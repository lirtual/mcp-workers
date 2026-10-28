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
  assert.match(content, /remote-control-agent-v0\.1\.35/);
  assert.match(content, /--upgrade/);
  assert.doesNotMatch(content, /remote-control-agent-v0\.1\.13/);
  const windows = await worker.fetch(new Request(prod + "/install.ps1"), env);
  assert.equal(windows.status, 200);
  assert.match(await windows.text(), /4ba573a57d72c306e8e40aea203ced037550913d3f7a3782edadb04fadc04b84/);
  const home = await worker.fetch(new Request(prod + "/"), env);
  assert.equal(home.status, 200);
  const homepage = await home.text();
  assert.match(homepage, /Remote Control Agent/);
  assert.match(homepage, /const ready=\{windows:true,linux:true\}/);
  const rejected = await worker.fetch(new Request("https://unauthorized.test/install.sh"), env);
  assert.equal(rejected.status, 403);
});
