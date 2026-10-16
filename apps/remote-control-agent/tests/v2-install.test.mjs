import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MARKER, UNIT, classifyLinuxKernel, parseInstallArgs, renderV2Service, trustedEndpoint } from "../scripts/install-v2.mjs";
import { beginDeviceEnrollment, PendingIdentityConflictError } from "../src/pair-device.ts";
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

test("default installer distinguishes interrupted pairing from deliberate revoke", async () => {
  const script = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-v2.mjs"), "utf8");
  assert.match(script, /await recoverDeviceId\(options\.endpoint, keyPath\)/);
  assert.match(script, /error instanceof DeviceSessionRejectedError && error\.status === 404/);
  assert.match(script, /await beginDeviceEnrollment\(/);
  assert.match(script, /Boolean\(existingKey\)/);
  assert.match(script, /if \(existingId\)/);
  assert.match(script, /Existing device key is already approved or revoked/);
  assert.doesNotMatch(script, /unlink\(keyPath\)|rm\(keyPath\)/);
});
