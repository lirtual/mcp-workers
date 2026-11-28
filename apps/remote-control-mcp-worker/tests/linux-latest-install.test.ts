import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import worker from "../src/worker.ts";
import { LATEST_MANIFEST_URL } from "../src/release-manifest-shell.ts";

const origin = "https://rca.lirtual.dpdns.org";
function approvedEnv(counter: { calls: number }): Env {
  return {
    MCP_ACCESS_TOKEN: "owner-only",
    REMOTE_CONTROL_INSTALL_ORIGIN: origin,
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) },
    // If the Worker still uses its old GitHub API lookup, this fails.
    AGENT_RELEASE_FETCH: async () => {
      counter.calls++;
      throw Error("Worker must not query GitHub");
    },
  } as unknown as Env;
}

test("first-install Linux script is static, no Worker GitHub API or old repository", async () => {
  const counter = { calls: 0 };
  const response = await worker.fetch(new Request(origin + "/install.sh"), approvedEnv(counter));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/x-shellscript/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(counter.calls, 0);
  const script = await response.text();
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.ok(script.includes(LATEST_MANIFEST_URL));
  assert.match(script, /rca-release-v1/);
  assert.match(script, /linux-x64-glibc/);
  assert.match(script, /linux-arm64-glibc/);
  assert.match(script, /--upgrade/);
  assert.match(script, /sha256sum -c -/);
  assert.match(script, /Verified asset size mismatch/);
  assert.match(script, /--endpoint "https:\/\/rca\.lirtual\.dpdns\.org\/"/);
  assert.doesNotMatch(script, /api\.github\.com|remote-control-agent-v0\.1\.51|lirtual\/remote-control-agent|--commit/);
  assert.ok(script.indexOf("Invalid immutable Agent Release manifest") <
            script.indexOf("Downloading Remote Control Agent"));
  assert.ok(script.indexOf("sha256sum -c -") < script.indexOf("tar -xOzf"));
  assert.ok(script.indexOf("tar -xOzf") < script.indexOf("bootstrap-v2.py >"));
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8", timeout: 3000 }).status, 0);
  assert.ok(Buffer.byteLength(script) < 16384);
});


test("public Linux installer root opt-in is explicit and refused before downloads", async () => {
  const response = await worker.fetch(new Request(origin + "/install.sh"), approvedEnv({calls:0}));
  const script = await response.text();
  const root = mkdtempSync(join(tmpdir(), "rca-root-shell-"));
  const id = join(root, "id");
  const run = (uid: number, args: string[]) => {
    writeFileSync(id, `#!/bin/sh\nprintf '%s\\n' '${uid}'\n`);
    chmodSync(id, 0o755);
    return spawnSync("sh", ["-s", "--", ...args], {
      input: script, encoding: "utf8", timeout: 3000,
      env: {...process.env, PATH: root + ":" + process.env.PATH},
    });
  };
  try {
    const missing = run(0, []);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Root installation requires --allow-root/);
    assert.doesNotMatch(missing.stderr, /Downloading Remote Control Agent/);

    const nonInteractive = run(0, ["--allow-root"]);
    assert.notEqual(nonInteractive.status, 0);
    assert.match(nonInteractive.stderr, /real local terminal/);
    assert.doesNotMatch(nonInteractive.stderr, /Downloading Remote Control Agent/);

    const mixed = run(0, ["--allow-root", "--upgrade"]);
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /cannot be combined/);

    const duplicate = run(0, ["--allow-root", "--allow-root"]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /Duplicate installer option/);

    const ordinary = run(1001, ["--allow-root"]);
    assert.notEqual(ordinary.status, 0);
    assert.match(ordinary.stderr, /only valid for UID 0/);
  } finally {
    rmSync(root, {recursive:true, force:true});
  }
});

test("cold Worker lookup errors never gate public Linux script or macOS script", async () => {
  const counter = { calls: 0 };
  const env = approvedEnv(counter);
  const linux = await worker.fetch(new Request(origin + "/install.sh"), env);
  const macos = await worker.fetch(new Request(origin + "/install-macos.sh"), env);
  assert.equal(linux.status, 200);
  assert.equal(macos.status, 200);
  assert.equal(counter.calls, 0);
  assert.match(await macos.text(), /rca-release-v1/);
});

test("wrong owner origin, query, method and unconfigured Worker refuse public installer", async () => {
  const counter = { calls: 0 };
  const env = approvedEnv(counter);
  assert.equal((await worker.fetch(new Request("https://evil.example/install.sh"), env)).status, 403);
  assert.equal((await worker.fetch(new Request(origin + "/install.sh?token=1"), env)).status, 405);
  assert.equal((await worker.fetch(new Request(origin + "/install.sh", { method: "POST" }), env)).status, 405);
  assert.equal((await worker.fetch(new Request(origin + "/install.sh", { headers: { origin } }), env)).status, 405);
  const blocked = await worker.fetch(new Request(origin + "/install.sh"), {} as Env);
  assert.equal(blocked.status, 503);
  assert.equal(counter.calls, 0);
});

test("public Linux Shell requires owner terminal before contacting GitHub", async () => {
  const counter = { calls: 0 };
  const response = await worker.fetch(new Request(origin + "/install.sh"), approvedEnv(counter));
  const script = await response.text();
  const ran = spawnSync("sh", ["-s", "--", "--upgrade"], { input: script, encoding: "utf8", timeout: 3000 });
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /Requires an ordinary interactive Linux user/);
  assert.equal(counter.calls, 0);
});

test("verified public Linux archive dispatch rejects retired runtimes and preserves action", async () => {
  const response = await worker.fetch(new Request(origin + "/install.sh"), approvedEnv({calls:0}));
  const script = await response.text();
  assert.ok(script.indexOf("sha256sum -c -") < script.indexOf('tar -tzf'));
  assert.ok(script.indexOf('tar -tzf') < script.indexOf('bootstrap-v2.py >'));
  // Exercise the generated dispatch after the common size/SHA gate. No
  // network, real installer, pairing, or user terminal is involved.
  const dispatch = script.slice(script.indexOf('tar -tzf')).replaceAll('< /dev/tty','< /dev/null');
  const root = mkdtempSync(join(tmpdir(),"rca-public-dispatch-"));
  try {
    for (const kind of ["node","native","invalid"] as const) {
      const fixture = join(root,kind);
      const scripts = join(fixture,"apps/remote-control-agent/scripts");
      const stage = join(root,kind+"-stage");
      mkdirSync(scripts,{recursive:true});
      mkdirSync(stage);
      const archive = join(root,kind+".tar.gz");
      const members = [];
      if (kind === "node") {
        mkdirSync(join(fixture,"bin"));
        writeFileSync(join(fixture,"bin/node"), '#!/bin/sh\nprintf "NODE:%s\\n" "$*"\n');
        writeFileSync(join(scripts,"bootstrap-node.mjs"),"fixture");
        members.push("bin/node","apps/remote-control-agent/scripts/bootstrap-node.mjs");
      } else if (kind === "native") {
        writeFileSync(join(scripts,"bootstrap-v2.py"),'import sys\nprint("NATIVE:"+" ".join(sys.argv[1:]))\n');
        members.push("apps/remote-control-agent/scripts/bootstrap-v2.py");
      } else {
        writeFileSync(join(fixture,"bundle.json"),"{}");
        members.push("bundle.json");
      }
      assert.equal(spawnSync("tar",["-czf",archive,"-C",fixture,...members]).status,0);
      const result=spawnSync("sh",["-ec",dispatch,"fixture","--upgrade"],{
        env:{...process.env,archive,stage,tag:"v0.1.58",expected:"a".repeat(64)},encoding:"utf8",timeout:5000,
      });
      if (kind !== "native") {
        assert.notEqual(result.status,0);
        assert.match(result.stderr,/Unsupported verified Agent archive/);
      } else {
        assert.equal(result.status,0,result.stderr);
        assert.match(result.stdout,/NATIVE:--latest-archive /);
        assert.match(result.stdout,/--tag v0\.1\.58/);
        assert.match(result.stdout,/--endpoint https:\/\/rca\.lirtual\.dpdns\.org\/ --upgrade/);
        assert.doesNotMatch(result.stdout,/NODE:/);
      }
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});
