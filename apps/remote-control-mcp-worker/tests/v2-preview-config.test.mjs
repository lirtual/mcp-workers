import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

test("dedicated v2 preview cannot inherit the v1 VPC binding, token or DO namespace", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const preview = JSON.parse(await readFile(path.join(root, "wrangler.v2-preview.jsonc"), "utf8"));
  const production = await readFile(path.join(root, "wrangler.jsonc"), "utf8");
  assert.equal(preview.name, "remote-control-v2-preview");
  assert.equal(preview.main, "src/worker.ts");
  assert.equal(preview.vars?.REMOTE_CONTROL_V2_PREVIEW_ONLY, "true");
  assert.equal(preview.durable_objects.bindings.length, 1);
  assert.deepEqual(preview.durable_objects.bindings[0], {
    name: "V2_OWNER", class_name: "V2OwnerCoordinator",
  });
  assert.deepEqual(preview.exports.V2OwnerCoordinator, { type: "durable-object", storage: "sqlite" });
  assert.deepEqual(preview.secrets.required, ["MCP_ACCESS_TOKEN"]);
  assert.deepEqual(preview.compatibility_flags, ["nodejs_compat"]);
  assert.equal(preview.observability.logs.invocation_logs, false);
  assert.equal(preview.preview_urls, false);
  assert.equal(preview.keep_vars, false);
  assert.ok(!("vpc_services" in preview));
  assert.ok(!("migrations" in preview));
  assert.ok(!("routes" in preview));
  assert.ok(!("triggers" in preview));
  assert.equal(JSON.stringify(preview).includes("REMOTE_CONTROL_DEVICE_TOKEN"), false);
  assert.equal(JSON.stringify(preview).includes("REMOTE_CONTROL_DEVICE"), false);
  const bootstrap = JSON.parse(await readFile(path.join(root, "wrangler.v2-preview-bootstrap.jsonc"), "utf8"));
  const { secrets: _requiredPreviewSecret, ...releaseSettings } = preview;
  assert.deepEqual(bootstrap, releaseSettings, "bootstrap differs only by omission of the required secret declaration");
  assert.equal("secrets" in bootstrap, false);
  const v2Prod = JSON.parse(production);
  assert.equal(v2Prod.name, "remote-control-mcp-worker");
  assert.equal(v2Prod.vars?.REMOTE_CONTROL_V2_ONLY, undefined);
  assert.equal(v2Prod.keep_vars, false);
  assert.deepEqual(v2Prod.routes, [{ pattern: "rca.lirtual.dpdns.org", custom_domain: true }],
    "production RCA must use a true Custom Domain, not a Worker Route");
  assert.deepEqual(v2Prod.secrets.required, ["MCP_ACCESS_TOKEN"]);
  assert.deepEqual(v2Prod.durable_objects.bindings, [{
    name: "DEVICE_COORDINATOR", class_name: "DeviceCoordinator",
  }], "production must own an independent DO namespace");
  assert.deepEqual(v2Prod.exports?.DeviceCoordinator, { type: "durable-object", storage: "sqlite" });
  assert.equal(v2Prod.vpc_services, undefined, "production must no longer bind VPC");
  assert.equal(JSON.stringify(v2Prod).includes("REMOTE_CONTROL_DEVICE_TOKEN"), false);
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

test("production installer is pinned to the public v0.1.8 release and its own origin", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const prod = "https://remote-control-mcp-worker.aiyaya.workers.dev";
  const env = { MCP_ACCESS_TOKEN: "owner-only",
    
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) } };
  const response = await worker.fetch(new Request(prod + "/install.sh"), env);
  assert.equal(response.status, 200);
  const content = await response.text();
  assert.match(content, /remote-control-agent-v0\.1\.8/);
  assert.ok(content.includes("--endpoint") && content.includes(prod + "/"));
  const rejected = await worker.fetch(new Request("https://unauthorized.test/install.sh"), env);
  assert.equal(rejected.status, 403);
});

test("Preview exposes per-device reads, writes, Shell and Receipt without a temporary grant", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const { randomUUID } = await import("node:crypto");
  const device_id = randomUUID(), operation_id = "preview-operation-" + randomUUID();
  const calls = [];
  let legacyCalls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "preview-test-token",
    REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    V2_OWNER: {
      idFromName: name => name,
      get: () => ({
        fetch: async (request, init) => {
          const pathname = new URL(String(request)).pathname;
          const payload = JSON.parse(init.body);
          calls.push({ pathname, payload });
          return pathname === "/read"
            ? Response.json({ status: "completed", text: "test-read" })
            : Response.json({ operation_id: payload.operation_id, status: "not_found" });
        },
      }),
    },
    REMOTE_CONTROL_DEVICE: { fetch: () => { legacyCalls++; throw Error("v1 must not be called"); } },
  };
  async function rpc(method, params, token = "preview-test-token") {
    const res = await worker.fetch(new Request("https://preview.test/mcp", {
      method: "POST", headers: {
        "content-type": "application/json", authorization: "Bearer " + token,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method, params }),
    }), env);
    return { status: res.status, body: await res.json() };
  }

  const listed = await rpc("tools/list", {});
  const tools = listed.body.result.tools;
  for (const name of ["read_file", "write_file", "create_directory", "replace_text", "move_file",
    "delete_file", "get_operation_status", "run_command", "send_input", "stop_session",
    "list_sessions", "read_session_output"]) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, "v2 Preview missing " + name);
    assert.ok(tool.inputSchema.required.includes("device_id"), "missing explicit device_id: " + name);
  }
  for (const name of ["pairing_lookup", "pairing_approve", "list_devices", "revoke_device"]) {
    assert.ok(tools.some(item => item.name === name), "owner tool missing: " + name);
  }

  const cases = [
    ["read_file", { device_id, path: "/etc/os-release" }],
    ["write_file", { device_id, operation_id, path: "/home/rcagent/test.txt", content: "test", mode: "append" }],
    ["run_command", { device_id, operation_id, command: "printf fixture" }],
    ["get_operation_status", { device_id, operation_id }],
  ];
  for (const [name, args] of cases) {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.notEqual(result.body.result?.isError, true, name + " rejected a paired-device request");
  }
  assert.equal(calls.length, cases.length);
  assert.deepEqual(calls.map(x => x.pathname), ["/read", "/operation", "/operation", "/operation"]);
  assert.ok(calls.every(x => x.payload.device_id === device_id));
  assert.equal(legacyCalls, 0);
  assert.equal((await rpc("tools/call", {
    name: "write_file",
    arguments: { device_id, operation_id, path: "/home/rcagent/test.txt", content: "test", mode: "append" },
  }, "wrong-token")).status, 401);
  assert.equal(calls.length, cases.length, "invalid MCP token must never reach owner DO");
});

test("Preview denies missing/invalid device IDs and never routes to legacy v1", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const { randomUUID } = await import("node:crypto");
  let ownerCalls = 0, legacyCalls = 0;
  const device_id = randomUUID(), operation_id = "preview-reject-" + randomUUID();
  const env = {
    MCP_ACCESS_TOKEN: "token",
    REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    V2_OWNER: {
      idFromName: () => { ownerCalls++; throw Error("should not dispatch"); },
      get: () => { ownerCalls++; throw Error("should not dispatch"); },
    },
    REMOTE_CONTROL_DEVICE: { fetch: () => { legacyCalls++; throw Error("legacy fallback"); } },
  };
  async function rpc(name, args) {
    const res = await worker.fetch(new Request("https://preview.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/call", params: {
        name, arguments: args,
      } }),
    }), env);
    return (await res.json()).result;
  }
  for (const [name, args] of [
    ["read_file", { path: "/etc/os-release" }],
    ["write_file", { operation_id, path: "/tmp/a", content: "x", mode: "append" }],
    ["run_command", { device_id: "bad-device-id", operation_id, command: "id" }],
    ["get_operation_status", { device_id: "", operation_id }],
    ["unsupported_tool", { device_id }],
  ]) {
    const result = await rpc(name, args);
    assert.equal(result?.isError, true, name + " must be rejected");
  }
  assert.equal(ownerCalls, 0, "invalid calls must be refused before owner DO dispatch");
  assert.equal(legacyCalls, 0, "v2 Preview never falls back to v1 VPC");

  const noOwnerEnv = { MCP_ACCESS_TOKEN: "token", REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    REMOTE_CONTROL_DEVICE: env.REMOTE_CONTROL_DEVICE };
  const response = await worker.fetch(new Request("https://preview.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 44, method: "tools/call",
      params: { name: "write_file", arguments: { device_id, operation_id,
        path: "/home/rcagent/test.txt", content: "test", mode: "append" } } }),
  }), noOwnerEnv);
  assert.equal((await response.json()).result?.isError, true);
  assert.equal(legacyCalls, 0);
});

test("Preview mutation maps Agent uncertain outcomes to timeout_unknown without replay", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const { randomUUID } = await import("node:crypto");
  const device_id = randomUUID(), operation_id = "uncertain-" + randomUUID();
  let status = "unavailable";
  let ownerCalls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "preview-uncertain-token",
    REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    V2_OWNER: {
      idFromName: () => "single-owner",
      get: () => ({
        fetch: async (url, init) => {
          ownerCalls++;
          assert.equal(new URL(String(url)).pathname, "/operation");
          const body = JSON.parse(init.body);
          assert.equal(body.device_id, device_id);
          return Response.json({ operation_id, status });
        },
      }),
    },
  };
  async function invoke(name, argumentsValue) {
    const result = await worker.fetch(new Request("https://preview.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer preview-uncertain-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 36, method: "tools/call",
        params: { name, arguments: argumentsValue } }),
    }), env);
    const payload = await result.json();
    assert.notEqual(payload.result?.isError, true);
    return JSON.parse(payload.result.content[0].text);
  }
  const write = { device_id, operation_id, path: "/home/rcagent/fault-test.txt",
    content: "ONE\\n", mode: "append" };
  assert.deepEqual(await invoke("write_file", write), { operation_id, status: "timeout_unknown" });
  status = "unknown";
  assert.deepEqual(await invoke("write_file", write), { operation_id, status: "timeout_unknown" });
  status = "completed";
  assert.deepEqual(await invoke("write_file", write), { operation_id, status: "completed" });
  status = "unavailable";
  // A receipt lookup must remain a read-only status report, not a mutation.
  assert.deepEqual(await invoke("get_operation_status", { device_id, operation_id }),
    { operation_id, status: "unavailable" });
  assert.equal(ownerCalls, 4);
});


test("single-code Worker Preview installer enabled only for reviewed immutable Agent release", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const origin = "https://remote-control-v2-preview.aiyaya.workers.dev";
  const request = new Request(origin+"/install.sh");
  const configured = {
    MCP_ACCESS_TOKEN: "test-only", REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    V2_OWNER: { idFromName: () => "single-owner-v2", get: () => ({}) },
  };
  const enabled = await worker.fetch(request,configured);
  assert.equal(enabled.status,200);
  assert.equal(enabled.headers.get("cache-control"),"no-store");
  assert.match(await enabled.text(),/remote-control-agent-v0\.1\.8/);
  const disabled = await worker.fetch(new Request(origin+"/install.sh"),{
    MCP_ACCESS_TOKEN: "test-only", REMOTE_CONTROL_V2_PREVIEW_ONLY:"false"
  });
  assert.equal(disabled.status,503);
  const unconfigured = await worker.fetch(new Request(origin+"/install.sh"),{
    REMOTE_CONTROL_V2_PREVIEW_ONLY:"true"
  });
  assert.equal(unconfigured.status,503);
  const unexpectedOrigin = await worker.fetch(new Request("https://evil.example/install.sh"),configured);
  assert.equal(unexpectedOrigin.status,403);
});
