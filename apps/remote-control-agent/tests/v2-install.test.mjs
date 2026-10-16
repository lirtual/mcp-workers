import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MARKER, UNIT, classifyLinuxKernel, inspectInstallIdentity, parseInstallArgs, promoteRevokedIdentity, renderV2Service, trustedEndpoint } from "../scripts/install-v2.mjs";
import { beginDeviceEnrollment, PendingIdentityConflictError } from "../src/pair-device.ts";
import { assertRemoteRevocation } from "../src/v2-repair.ts";
import { DeviceSessionRejectedError, recoverDeviceId, signedSessionProof } from "../src/v2-session-client.ts";
import { newEnrollment } from "../src/v2-enrollment.ts";

const example = {
  node: "/opt/node24/bin/node",
  home: "/home/agent",
  repoRoot: "/home/agent/mcp-workers",
  endpoint: "https://rc.example.org/",
  keyPath: "/home/agent/.local/share/mcp-workers/remote-control/v2-identity.pem",
};

test("minimal Linux v2 CLI supports install, explicit paired-key resume, upgrade, and safe uninstall", () => {
  assert.deepEqual(parseInstallArgs(["--endpoint", "https://rc.example.org", "--name", "office"]), {
    action: "install", endpoint: "https://rc.example.org", name: "office", foreground: false, showFingerprint: false,
  });
  assert.equal(parseInstallArgs(["--resume", "--endpoint", "https://rc.example.org"]).action, "resume");
  assert.equal(parseInstallArgs(["--upgrade", "--endpoint", "https://rc.example.org"]).action, "upgrade");
  assert.equal(parseInstallArgs(["--uninstall"]).action, "uninstall");
  for (const args of [
    [], ["--upgrade"], ["--uninstall", "--name", "x"], ["--uninstall", "--endpoint", "https://host.test"],
    ["--upgrade", "--uninstall", "--endpoint", "https://host.test"], ["--unknown"],
    ["--re-pair", "--endpoint", "https://host.test"],
    ["--endpoint", "https://host.test", "--name", "malicious\nhost"],
  ]) {
    assert.throws(() => parseInstallArgs(args));
  }
});

test("installer accepts only a clean trusted HTTPS origin without credentials", () => {
  assert.equal(trustedEndpoint("https://v2.example.org/"), "https://v2.example.org/");
  assert.equal(trustedEndpoint("https://v2.example.org:8443"), "https://v2.example.org:8443/");
  for (const endpoint of [
    "http://v2.example.org/", "https://user:password@v2.example.org/",
    "https://v2.example.org/x", "https://v2.example.org/?secret=abc",
    "https://v2.example.org/#frag", "https://[::1]/", "file:///etc/passwd",
  ]) assert.throws(() => trustedEndpoint(endpoint));
});

test("separate v2 systemd unit never references v1 credentials, tunnel or write/Shell authorization", () => {
  assert.equal(UNIT, "remote-control-v2-agent.service");
  const unit = renderV2Service(example);
  assert.ok(unit.startsWith(MARKER));
  assert.match(unit, /ExecStart=\/opt\/node24\/bin\/node --experimental-strip-types \/home\/agent\/mcp-workers\/apps\/remote-control-agent\/src\/v2-main\.ts/);
  assert.match(unit, /Environment=REMOTE_CONTROL_V2_ENDPOINT=https:\/\/rc\.example\.org\//);
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -r .*v2-identity\.pem\.device-id/);
  assert.match(unit, /ExecStartPre=\/usr\/bin\/test -x .*session-supervisor/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /UMask=0077/);
  assert.ok(!unit.includes("remote-control-agent.service\n"));
  assert.ok(!unit.includes("REMOTE_CONTROL_DEVICE_TOKEN"));
  assert.ok(!unit.includes("MCP_ACCESS_TOKEN"));
  assert.ok(!unit.includes("cloudflared"));
  assert.ok(!unit.includes("writeFile"));
  assert.ok(!unit.includes("shell=true"));
  for (const unsafe of [
    { ...example, repoRoot: "/opt/with space" }, { ...example, node: "/usr/bin/node\nExecStart=/bin/sh" },
    { ...example, repoRoot: "/tmp/%h" }, { ...example, keyPath: "/tmp/a\\b" },
    { ...example, endpoint: "https://user:pass@rc.example.org" },
  ]) assert.throws(() => renderV2Service(unsafe));
});

test("v2 startup opts into read-only but explicitly keeps file write/Shell off", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const entry = await readFile(path.join(testDir, "..", "src", "v2-main.ts"), "utf8");
  assert.match(entry, /maintainAuthenticatedDeviceSession/);
  assert.match(entry, /readOnly: true/);
  assert.match(entry, /writeFile: false/);
  assert.match(entry, /shell: false/);
  assert.ok(!entry.includes("REMOTE_CONTROL_DEVICE_TOKEN"));
  assert.ok(!entry.includes("MCP_ACCESS_TOKEN"));
});

test("WSL2 host detection keeps the Linux installer but rejects unsupported WSL1", () => {
  assert.equal(classifyLinuxKernel("6.6.87.2-microsoft-standard-WSL2\n"), "wsl2");
  assert.equal(classifyLinuxKernel("5.15.167.4-microsoft-standard-WSL2"), "wsl2");
  assert.equal(classifyLinuxKernel("4.4.0-19041-Microsoft"), "wsl1");
  assert.equal(classifyLinuxKernel("6.8.0-51-generic"), "linux");
  assert.throws(() => classifyLinuxKernel(""), /Linux kernel/);
});

test("WSL2 shares the Linux-only Agent, with no Windows Shell or host auto-wakeup hooks", async () => {
  const file = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "..", "scripts", "install-v2.mjs"), "utf8");
  assert.match(file, /cannot wake a stopped WSL distribution/);
  assert.ok(!file.includes("schtasks"));
  assert.ok(!file.includes("TaskScheduler"));
  assert.ok(!file.includes("powershell.exe"));
  assert.ok(!file.includes("cmd.exe"));
  assert.ok(!file.includes("wsl.exe"));
  const unit = renderV2Service(example);
  assert.ok(!unit.includes("ExecStart=/mnt/c/"));
  assert.ok(!unit.includes("REMOTE_CONTROL_DEVICE_TOKEN"));
});

test("foreground is opt-in and cannot uninstall, upgrade, or duplicate flags", () => {
  assert.deepEqual(parseInstallArgs([
    "--foreground", "--endpoint", "https://rc.example.org", "--name", "grokbot",
  ]), { action: "install", endpoint: "https://rc.example.org", name: "grokbot", foreground: true, showFingerprint: false });
  assert.equal(parseInstallArgs(["--resume", "--foreground", "--endpoint", "https://rc.example.org"]).action, "resume");
  for (const args of [
    ["--foreground", "--uninstall"],
    ["--upgrade", "--foreground", "--endpoint", "https://rc.example.org"],
    ["--foreground", "--foreground", "--endpoint", "https://rc.example.org"],
    ["--show-fingerprint", "--show-fingerprint", "--endpoint", "https://rc.example.org"],
    ["--show-fingerprint", "--resume", "--endpoint", "https://rc.example.org"],
    ["--foreground"],
  ]) assert.throws(() => parseInstallArgs(args));
});

test("foreground reuses signed read-only v2 entrypoint and skips systemd preflight", async () => {
  const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "..", "scripts", "install-v2.mjs"), "utf8");
  assert.match(src, /if \(!foreground\) run\("systemctl", \["--user", "show-environment"\]\)/);
  assert.match(src, /if \(!foreground\) run\("systemd-analyze"/);
  assert.match(src, /run\("cc", \["--version"\]\)/);
  assert.match(src, /run\(process.execPath, \[compilerScript\]\)/);
  assert.match(src, /if \(options.foreground\)/);
  assert.match(src, /await startForeground\(\{ endpoint: trustedEndpoint\(options.endpoint\), keyPath \}\)/);
  assert.match(src, /await import\("\.\.\/src\/v2-main\.ts"\)/);
  assert.match(src, /Foreground refuses to compete with an existing v2 systemd unit/);
  assert.match(src, /ownerOnly\(keyPath \+ "\.device-id", 0o600\)/);
  assert.doesNotMatch(src, /nohup|supervisord|cron|pm2/);
});

test("first enrollment prompts for one challenge, not the original pairing code again", async () => {
  const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "..", "scripts", "install-v2.mjs"), "utf8");
  assert.doesNotMatch(src, /Repeat original 10-character code:/);
  assert.match(src, /await confirmDeviceLocally\(enrollment\.code, challenge, options\.endpoint, keyPath\)/);
  assert.match(src, /\^\[A-Z2-7\]\{12\}\$/);
  assert.match(src, /attempt < 3/);
  assert.match(src, /Invalid local challenge format/);
  assert.match(src, /if \(!stdin\.isTTY \|\| !stdout\.isTTY\)/);
});

test("first pairing hides fingerprint by default, but optional display matches pending public key", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "rc-v2-fingerprint-"));
  try {
    const keyPath = path.join(folder, "private.pem");
    let request;
    const fakeFetch = async (url, options) => {
      assert.equal(new URL(url).pathname, "/agent/pair/start");
      request = JSON.parse(options.body);
      return new Response(null, { status: 202 });
    };
    const pending = await beginDeviceEnrollment("debian-wsl2", "https://rc.example.org/", keyPath, fakeFetch);
    const publicSpkiDer = createPublicKey(createPrivateKey(await readFile(keyPath, "utf8")))
      .export({ type: "spki", format: "der" });
    const expected = createHash("sha256").update(publicSpkiDer).digest("hex").slice(0, 24);
    assert.equal(pending.fingerprint, expected);
    assert.equal(pending.fingerprint, createHash("sha256")
      .update(Buffer.from(request.public_key, "base64")).digest("hex").slice(0, 24));
    assert.match(pending.code, /^[A-Z2-7]{10}$/);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    const script = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "install-v2.mjs"), "utf8");
    assert.equal(parseInstallArgs(["--endpoint", "https://rc.example.org"]).showFingerprint, false);
    assert.equal(parseInstallArgs(["--show-fingerprint", "--endpoint", "https://rc.example.org"]).showFingerprint, true);
    assert.match(script, /if \(options\.showFingerprint\)/);
    assert.match(script, /Local public key fingerprint \(optional check\): " \+ enrollment\.fingerprint/);
    assert.match(script, /Enter only the 12-character challenge here/);
    assert.doesNotMatch(script, /openssl pkey|Repeat original 10-character code/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("interrupted enrollment renews its code using the SAME owner-only Ed25519 key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-retry-"));
  const key = path.join(dir, "identity.pem");
  const registered = [];
  const send = async (_url, options) => {
    registered.push(JSON.parse(options.body));
    return new Response(null, { status: 202 });
  };
  try {
    const first = await beginDeviceEnrollment("retry-host", "https://rc.example.org/", key, send);
    const pem = await readFile(key, "utf8");
    const again = await beginDeviceEnrollment("retry-host", "https://rc.example.org/", key, send, true);
    assert.notEqual(first.code, again.code);
    assert.equal(first.fingerprint, again.fingerprint);
    assert.equal(registered[0].public_key, registered[1].public_key);
    assert.notEqual(registered[0].code_verifier, registered[1].code_verifier);
    assert.equal(await readFile(key, "utf8"), pem);
    assert.equal((await stat(key)).mode & 0o777, 0o600);
    await assert.rejects(
      beginDeviceEnrollment("retry-host", "https://rc.example.org/", key,
        async () => { throw new Error("network offline"); }, true),
      /Pending enrollment could not be completed/);
    assert.equal(await readFile(key, "utf8"), pem);
    await assert.rejects(
      beginDeviceEnrollment("retry-host", "https://rc.example.org/", key,
        async () => new Response(null, { status: 409 }), true),
      PendingIdentityConflictError);
    assert.equal(await readFile(key, "utf8"), pem);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("signed recovery distinguishes unknown key (404) from uncertain network and keeps private identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-recovery-"));
  const key = path.join(dir, "identity.pem");
  const material = newEnrollment("repair-host");
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(key, material.privateKeyPem, {mode: 0o600});
    const id = "5431b055-a601-47d5-92c8-1beeddea7ce1";
    const nonce = "0123456789abcdef01234567";
    const server = async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/agent/session/challenge")
        return Response.json({device_id: id, nonce});
      if (pathname === "/agent/session/recover") {
        const body = JSON.parse(options.body);
        const signed = signedSessionProof(material.privateKeyPem, id, nonce);
        assert.equal(body.proof, signed.proof);
        assert.equal(body.device_id, id);
        return Response.json({status: "verified", device_id: id});
      }
      throw new Error("unexpected route");
    };
    assert.equal(await recoverDeviceId("https://rc.example.org/", key, server), id);
    assert.equal((await readFile(key + ".device-id", "utf8")).trim(), id);
    await assert.rejects(
      recoverDeviceId("https://rc.example.org/", key, async () => new Response(null, {status: 404})),
      error => error instanceof DeviceSessionRejectedError && error.status === 404);
    await assert.rejects(
      recoverDeviceId("https://rc.example.org/", key, async () => { throw new Error("offline"); }),
      /offline/);
    assert.equal((await readFile(key + ".device-id", "utf8")).trim(), id);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("default installer auto-classifies approved, pending and signed-revoked identities safely", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-automatic-install-"));
  const key = path.join(dir, "identity.pem");
  const deviceId = "77770000-0000-4000-8000-000000000001";
  const options = {endpoint: "https://rc.example.org/"};
  const rejected = (status) => async () => { throw new DeviceSessionRejectedError("denied", status); };
  const offline = async () => { throw new Error("network unavailable"); };
  const neverVerify = async () => { throw new Error("unexpected tombstone check"); };
  const verify = async (endpoint, pathName, id) => {
    assert.equal(endpoint, options.endpoint);
    assert.equal(pathName, key);
    assert.equal(id, deviceId);
  };
  try {
    assert.equal(await inspectInstallIdentity(options, key, null), "new");
    await assert.rejects(inspectInstallIdentity(options, key, "owned-service"),
      /identity is missing/);
    await writeFile(key+".device-id", deviceId, {mode:0o600});
    await assert.rejects(inspectInstallIdentity(options, key, null), /without its private key/);
    await rm(key+".device-id");

    const material = newEnrollment("recovered-debian");
    await writeFile(key, material.privateKeyPem, {mode:0o600});
    assert.equal(await inspectInstallIdentity(options, key, null,
      {recover:rejected(404),verifyRevoked:neverVerify}), "pending");
    await assert.rejects(inspectInstallIdentity(options, key, "owned-service",
      {recover:rejected(404),verifyRevoked:neverVerify}), DeviceSessionRejectedError);
    await assert.rejects(inspectInstallIdentity(options, key, null,
      {recover:offline,verifyRevoked:neverVerify}), /network unavailable/);
    assert.equal(await readFile(key, "utf8"), material.privateKeyPem);
    assert.equal(await inspectInstallIdentity(options, key, null,
      {recover:async () => deviceId,verifyRevoked:neverVerify}), "approved");

    await writeFile(key+".device-id", deviceId, {mode:0o600});
    assert.equal(await inspectInstallIdentity(options, key, "owned-service",
      {recover:async () => deviceId,verifyRevoked:neverVerify}), "approved");
    await assert.rejects(inspectInstallIdentity(options, key, "owned-service",
      {recover:async () => "88880000-0000-4000-8000-000000000002",
        verifyRevoked:neverVerify}), /identities conflict/);
    await assert.rejects(inspectInstallIdentity(options, key, "owned-service",
      {recover:offline,verifyRevoked:neverVerify}), /network unavailable/);
    await assert.rejects(inspectInstallIdentity(options, key, "owned-service",
      {recover:rejected(503),verifyRevoked:neverVerify}), DeviceSessionRejectedError);
    for (const status of [401,403,404]) {
      assert.equal(await inspectInstallIdentity(options, key, "owned-service",
        {recover:rejected(status),verifyRevoked:verify}), "revoked");
      await assert.rejects(inspectInstallIdentity(options, key, "owned-service",
        {recover:rejected(status),verifyRevoked:async () => {throw Error("unverified");}}),
        /unverified/);
    }
    assert.equal(await readFile(key+".device-id", "utf8"), deviceId);
    assert.equal(await readFile(key, "utf8"), material.privateKeyPem);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("one installer command dispatches verified revoke to guarded local challenge", async () => {
  const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-v2.mjs"), "utf8");
  assert.match(src, /const state = await inspectInstallIdentity\(options, keyPath, previous\)/);
  assert.match(src, /if \(state === "revoked"\)/);
  assert.match(src, /await rePairRevokedDevice\(options, keyPath, previous, stdin, stdout\)/);
  assert.match(src, /if \(previous\) \{\s*stdout.write\("v2 user service already installed/);
  assert.match(src, /await pairFreshPending\(options, keyPath, stdin, stdout, state === "pending"\)/);
  assert.match(src, /await assertRemoteRevocation\(options.endpoint, keyPath, oldId\)/);
  assert.doesNotMatch(src, /Type RE-PAIR|Explicit re-pair confirmation was not provided/);
  assert.doesNotMatch(src, /options.action === "re-pair"/);
  assert.doesNotMatch(src, /unlink\(keyPath\)|rm\(keyPath\)/);
});

test("explicit re-pair accepts only a signed proof of an already revoked same-ID key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-repair-proof-"));
  const keyPath = path.join(dir, "identity.pem");
  const material = newEnrollment("revoked-host");
  const id = "d41f1d0c-288c-4ae4-bd0d-9ff8b1b8c321";
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(keyPath, material.privateKeyPem, {mode:0o600});
    let count = 0;
    const fake = async (url, opts) => {
      count++;
      assert.equal(new URL(url).pathname, "/agent/re-pair/status");
      const req = JSON.parse(opts.body);
      assert.equal(req.device_id, id);
      assert.equal(req.public_key, material.request.public_key);
      assert.equal(typeof req.issued_at, "number");
      const key = createPrivateKey(material.privateKeyPem);
      const signed = requireCompatibleSignedProof(req, key);
      assert.equal(req.proof, signed);
      return Response.json({status:"revoked",device_id:id});
    };
    await assertRemoteRevocation("https://rc.example.org/", keyPath, id, fake);
    assert.equal(count, 1);
    for (const status of [403, 404, 409, 503]) {
      await assert.rejects(
        assertRemoteRevocation("https://rc.example.org/", keyPath, id,
          async () => new Response(null, {status})), /Revocation cannot be verified/);
    }
    await assert.rejects(
      assertRemoteRevocation("https://rc.example.org/", keyPath, id,
        async () => {throw Error("offline");}), /offline/);
    assert.equal(await readFile(keyPath, "utf8"), material.privateKeyPem);
    await assert.rejects(
      assertRemoteRevocation("https://rc.example.org/", keyPath, id,
        async () => Response.json({status:"revoked",device_id:"00000000-0000-4000-8000-000000000000"})),
      /Revocation cannot be verified/);
  } finally {await rm(dir, {recursive:true,force:true});}
});

function requireCompatibleSignedProof(payload, key) {
  const content = "remote-control:v2:re-pair-revoked:" +
    payload.device_id + ":" + payload.public_key + ":" + payload.issued_at;
  return Buffer.from(nodeSign(null, Buffer.from(content), key)).toString("base64");
}

test("revoked install archives old identity only AFTER new challenged pairing", async () => {
  const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "..","scripts","install-v2.mjs"), "utf8");
  assert.match(src, /await assertRemoteRevocation\(options\.endpoint, keyPath, oldId\)/);
  assert.match(src, /Old device identity confirmed revoked; starting fresh pairing/);
  assert.match(src, /const stage = keyPath \+ "\.re-pair-new"/);
  assert.match(src, /await pairFreshPending\(options, stage, stdin, stdout, Boolean\(stageExists\)\)/);
  assert.match(src, /if \(previous\) run\("systemctl", \["--user", "stop", UNIT\]\)/);
  assert.match(src, /await move\(keyPath, path\.join\(archive, "identity\.pem"\)\)/);
  assert.match(src, /await move\(stage, keyPath\)/);
  assert.doesNotMatch(src, /rm\(keyPath\)|unlink\(keyPath\)/);
});

test("staged identity promotion archives the revoked key/ID and installs only the new paired identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-stage-success-"));
  const key = path.join(dir, "identity.pem");
  const oldId = "0ded0000-0000-4000-8000-000000000001";
  const newId = "0ded0000-0000-4000-8000-000000000002";
  try {
    await writeFile(key, "old-revoked-key", {mode:0o600});
    await writeFile(key+".device-id", oldId, {mode:0o600});
    await writeFile(key+".re-pair-new", "new-paired-key", {mode:0o600});
    await writeFile(key+".re-pair-new.device-id", newId, {mode:0o600});
    const archive=await promoteRevokedIdentity(key,oldId);
    assert.equal((await stat(archive)).mode & 0o777,0o700);
    assert.equal(await readFile(path.join(archive,"identity.pem"),"utf8"),"old-revoked-key");
    assert.equal(await readFile(path.join(archive,"identity.pem.device-id"),"utf8"),oldId);
    assert.equal(await readFile(key,"utf8"),"new-paired-key");
    assert.equal(await readFile(key+".device-id","utf8"),newId);
    await assert.rejects(readFile(key+".re-pair-new"),{code:"ENOENT"});
    await assert.rejects(readFile(key+".re-pair-new.device-id"),{code:"ENOENT"});
    assert.equal((await stat(key)).mode & 0o777,0o600);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("mid-promotion rename failure restores BOTH complete identities; retry succeeds without deleting keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-v2-stage-rollback-"));
  const key = path.join(dir, "identity.pem");
  const oldId = "0ded0000-0000-4000-8000-000000000003";
  const newId = "0ded0000-0000-4000-8000-000000000004";
  try {
    await writeFile(key,"old-revoked-key",{mode:0o600});
    await writeFile(key+".device-id",oldId,{mode:0o600});
    await writeFile(key+".re-pair-new","new-paired-key",{mode:0o600});
    await writeFile(key+".re-pair-new.device-id",newId,{mode:0o600});
    let failed=false;
    const failAfterThreeMoves=async (from,to)=>{
      if (!failed && from===key+".re-pair-new.device-id") {
        failed=true;
        throw new Error("injected rename failure");
      }
      return rename(from,to);
    };
    await assert.rejects(promoteRevokedIdentity(key,oldId,failAfterThreeMoves),
      /injected rename failure/);
    assert.equal(failed,true);
    assert.equal(await readFile(key,"utf8"),"old-revoked-key");
    assert.equal(await readFile(key+".device-id","utf8"),oldId);
    assert.equal(await readFile(key+".re-pair-new","utf8"),"new-paired-key");
    assert.equal(await readFile(key+".re-pair-new.device-id","utf8"),newId);
    await assert.rejects(stat(path.join(dir,"revoked-"+oldId)),{code:"ENOENT"});
    await promoteRevokedIdentity(key,oldId);
    assert.equal(await readFile(key+".device-id","utf8"),newId);
    assert.equal(await readFile(path.join(dir,"revoked-"+oldId,"identity.pem.device-id"),"utf8"),oldId);
  } finally {await rm(dir,{recursive:true,force:true});}
});
