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

test("production public installer routes use only reviewed pinned release", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const prod = "https://remote-control-mcp-worker.aiyaya.workers.dev";
  const env = { MCP_ACCESS_TOKEN: "owner-only", REMOTE_CONTROL_INSTALL_ORIGIN: prod,
    
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) } };
  const response = await worker.fetch(new Request(prod + "/install.sh"), env);
  assert.equal(response.status, 200);
  const content = await response.text();
  assert.match(content, /remote-control-agent-v0\.1\.48/);
  assert.match(content, /--upgrade/);
  assert.doesNotMatch(content, /remote-control-agent-v0\.1\.13/);
  const windows = await worker.fetch(new Request(prod + "/install.ps1"), env);
  assert.equal(windows.status, 200);
  assert.match(await windows.text(), /6026d0e1a6422bb89c43e0168f60304be04fdc3a2ee96c4bf3192b12628f323a/);
  const home = await worker.fetch(new Request(prod + "/"), env);
  assert.equal(home.status, 200);
  const homepage = await home.text();
  assert.match(homepage, /Remote Control Agent/);
  assert.match(homepage, /const ready=\{windows:true,linux:true,macos:true\}/);
  const macos = await worker.fetch(new Request(prod + "/install-macos.sh"), env);
  assert.equal(macos.status, 200, "available only after official Agent Release and explicit Worker deployment");
  const macShell=await macos.text();
  assert.match(macShell, /#!\/bin\/sh/);
  assert.match(macShell, /arm64\) target=darwin-arm64/);
  assert.match(macShell, /x86_64\) target=darwin-x64/);
  assert.match(macShell, /remote-control-agent-v0\.1\.51-\$target\.tar\.gz/);
  assert.match(macShell, /dc3b7ea6cf5ece3c76a053ffde81b1dc1a217f1404daef621eb80ee151433803/);
  assert.match(macShell, /f75e2eff990a1cf465fbe1697240a8244798584798d552f05459d8dcdc13ede5/);
  assert.match(macShell, /59ce3cc7a9713e2ed6c01fc9d6d9015ee7dbee2f428e5a1cc45a654288ed5d55/);
  assert.ok(macShell.includes('1) case "$1" in --upgrade) mode=upgrade ;; --remote-upgrade) mode=remote-upgrade ;;'));
  assert.match(macShell,/if \[ "\$mode" != upgrade \] && \[ "\$mode" != remote-upgrade \]/);
  assert.match(macShell,/--remote-upgrade\) mode=remote-upgrade/);
  assert.match(macShell,/sh "\$source" "\$mode" --archive/);
  const rejected = await worker.fetch(new Request("https://unauthorized.test/install.sh"), env);
  assert.equal(rejected.status, 403);
});
