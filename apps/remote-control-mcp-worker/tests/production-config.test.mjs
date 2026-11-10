import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

test("production Worker has only the reviewed DO, Access and Custom Domain bindings", async () => {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
  const prod=JSON.parse(await readFile(path.join(root,"wrangler.jsonc"),"utf8"));
  assert.equal(prod.name,"remote-control-mcp-worker");
  assert.equal(prod.vars?.REMOTE_CONTROL_V2_ONLY,undefined);
  assert.equal(prod.keep_vars,false);
  assert.deepEqual(prod.routes,[{pattern:"rca.lirtual.dpdns.org",custom_domain:true}]);
  assert.deepEqual(prod.secrets.required,["MCP_ACCESS_TOKEN"]);
  assert.deepEqual(prod.durable_objects.bindings,[
    {name:"DEVICE_COORDINATOR",class_name:"DeviceCoordinator"}
  ]);
  assert.deepEqual(prod.exports?.DeviceCoordinator,{type:"durable-object",storage:"sqlite"});
  assert.equal(prod.vpc_services,undefined);
  assert.equal(JSON.stringify(prod).includes("REMOTE_CONTROL_DEVICE_TOKEN"),false);
});

test("production DO binding lists per-device tools without v1 fallback", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const env = { MCP_ACCESS_TOKEN: "token",
    
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({
      fetch: async () => Response.json([{ device_id: "11111111-1111-4111-8111-111111111111", name: "test", status: "online" }]),
    }) },
    REMOTE_CONTROL_DEVICE: { fetch: () => { throw Error("v1 VPC called"); } },
    REMOTE_CONTROL_DEVICE_TOKEN: "unused",
  };
  const rpc = async (method, params) => {
    const r = await worker.fetch(new Request("https://production.test/mcp", {
      method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method, params }),
    }), env);
    return r.json();
  };
  const tools = (await rpc("tools/list", {})).result.tools;
  assert.ok(tools.find(t => t.name === "read_file").inputSchema.required.includes("device_id"));
  const listed = await rpc("tools/call", { name: "list_devices", arguments: {} });
  assert.equal(listed.result.isError, false);
  const unscoped = await rpc("tools/call", { name: "read_file", arguments: { path: "/etc/os-release" } });
  assert.equal(unscoped.result.isError, true, "never allow implicit fallback to the old VPC");
});

test("production public installer routes keep the Linux pin, serve Windows latest, and resolve macOS latest", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const { LATEST_AGENT_RELEASE_URL } = await import("../src/github-latest-agent-release.ts");
  const prod = "https://remote-control-mcp-worker.aiyaya.workers.dev";
  const tag = "v0.2.0";
  const sha = "ab".repeat(32);
  const asset = (target, ext) => {
    const name = `remote-control-agent-${tag}-${target}.${ext}`;
    return { name, state: "uploaded", size: 2048, digest: "sha256:" + sha,
      browser_download_url: `https://github.com/lirtual/mcp-workers/releases/download/${tag}/${name}` };
  };
  const latest = {
    tag_name: tag, draft: false, prerelease: false, immutable: true,
    html_url: `https://github.com/lirtual/mcp-workers/releases/tag/${tag}`,
    assets: [
      asset("linux-x64-glibc", "tar.gz"), asset("linux-arm64-glibc", "tar.gz"),
      asset("windows-x64", "zip"), asset("darwin-arm64", "tar.gz"), asset("darwin-x64", "tar.gz"),
      { name: "SHA256SUMS", state: "uploaded", size: 80, digest: "sha256:" + "cd".repeat(32),
        browser_download_url: "https://example.invalid/sums" },
    ],
  };
  let releaseCalls = 0;
  const env = { MCP_ACCESS_TOKEN: "owner-only", REMOTE_CONTROL_INSTALL_ORIGIN: prod,
    AGENT_RELEASE_FETCH: async (url) => {
      releaseCalls += 1;
      if (url !== LATEST_AGENT_RELEASE_URL) throw new Error("unexpected GitHub URL " + url);
      return Response.json(latest);
    },
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) } };
  const response = await worker.fetch(new Request(prod + "/install.sh"), env);
  assert.equal(response.status, 200);
  const content = await response.text();
  assert.match(content, /remote-control-agent-v0\.1\.51/);
  assert.match(content, /--upgrade/);
  assert.doesNotMatch(content, /remote-control-agent-v0\.1\.13/);
  const windows = await worker.fetch(new Request(prod + "/install.ps1"), env);
  assert.equal(windows.status, 200);
  const windowsScript = await windows.text();
  assert.match(windowsScript, /https:\/\/api\.github\.com\/repos\/lirtual\/mcp-workers\/releases\/latest/);
  assert.doesNotMatch(windowsScript, /v0\.1\.51/);
  assert.doesNotMatch(windowsScript, /03f11bca0f21b7f8fd4ed1343db79827bb9b36be3feda0284b4b75f82d917311/);
  assert.doesNotMatch(windowsScript, /6026d0e1a6422bb89c43e0168f60304be04fdc3a2ee96c4bf3192b12628f323a/);
  assert.doesNotMatch(windowsScript, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(windowsScript, /github\.com\/lirtual\/remote-control-agent/);
  const home = await worker.fetch(new Request(prod + "/"), env);
  assert.equal(home.status, 200);
  const homepage = await home.text();
  assert.match(homepage, /Remote Control Agent/);
  assert.match(homepage, /const ready=\{windows:true,linux:true,macos:true\}/);
  assert.equal(releaseCalls, 0, "the install page must not look up latest");
  const macos = await worker.fetch(new Request(prod + "/install-macos.sh"), env);
  assert.equal(macos.status, 200, "available only after official Agent Release and explicit Worker deployment");
  assert.equal(releaseCalls, 1, "one install attempt resolves one latest snapshot");
  const macShell=await macos.text();
  assert.match(macShell, /#!\/bin\/sh/);
  assert.match(macShell, /arm64\) target=darwin-arm64/);
  assert.match(macShell, /x86_64\) target=darwin-x64/);
  assert.match(macShell, /arm_url='https:\/\/github\.com\/lirtual\/mcp-workers\/releases\/download\/v0\.2\.0\/remote-control-agent-v0\.2\.0-darwin-arm64\.tar\.gz'/);
  assert.match(macShell, /x64_url='https:\/\/github\.com\/lirtual\/mcp-workers\/releases\/download\/v0\.2\.0\/remote-control-agent-v0\.2\.0-darwin-x64\.tar\.gz'/);
  assert.match(macShell, new RegExp(sha));
  assert.doesNotMatch(macShell, /github\.com\/lirtual\/remote-control-agent/);
  assert.doesNotMatch(macShell, /03a14fd4138ca8d77fa8aced78f7a53ccc51724e/);
  assert.doesNotMatch(macShell, /dc3b7ea6cf5ece3c76a053ffde81b1dc1a217f1404daef621eb80ee151433803/);
  assert.doesNotMatch(macShell, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(macShell, /api\.github\.com/);
  assert.ok(macShell.includes('1) case "$1" in --upgrade) mode=upgrade ;; --remote-upgrade) mode=remote-upgrade ;;'));
  assert.match(macShell,/if \[ "\$mode" != upgrade \] && \[ "\$mode" != remote-upgrade \]/);
  assert.match(macShell,/--remote-upgrade\) mode=remote-upgrade/);
  assert.match(macShell,/--source-sha "\$identity"/);
  const rejected = await worker.fetch(new Request("https://unauthorized.test/install.sh"), env);
  assert.equal(rejected.status, 403);
});
