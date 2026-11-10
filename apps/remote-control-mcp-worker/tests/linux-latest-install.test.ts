import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.ok(script.indexOf("tar -xOzf") < script.indexOf("bootstrap-node.mjs >"));
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8", timeout: 3000 }).status, 0);
  assert.ok(Buffer.byteLength(script) < 16384);
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
