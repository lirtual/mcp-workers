import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";

// This suite deliberately exercises the production DO transport. The removed v1
// VPC test used to await a service-binding callback that can no longer fire.
const portalToken = "portal-test-token";
const deviceId = "11111111-1111-4111-8111-111111111111";

function fixture(respond: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
  let legacyCalls = 0;
  const env = {
    MCP_ACCESS_TOKEN: portalToken,
    DEVICE_COORDINATOR: {
      idFromName(name: string) {
        assert.equal(name, "single-owner-v2");
        return name;
      },
      get() {
        return {
          async fetch(url: string, init?: RequestInit) {
            calls.push({
              url,
              body: init?.body ? JSON.parse(String(init.body)) as unknown : null,
              headers: new Headers(init?.headers),
            });
            return respond(url, init);
          },
        };
      },
    },
    // A stale v1 binding or credential must never become a transport fallback.
    REMOTE_CONTROL_DEVICE_TOKEN: "unused-legacy-token",
    REMOTE_CONTROL_DEVICE: {
      fetch(): never { legacyCalls++; throw new Error("v1 VPC must never be called"); },
    },
  } as unknown as Env;
  return { env, calls, legacyCalls: () => legacyCalls };
}

async function rpc(env: Env, method: string, params: unknown, opts: {
  token?: string; origin?: string;
} = {}) {
  const headers: Record<string, string> = {
    authorization: "Bearer " + (opts.token ?? portalToken),
    "content-type": "application/json",
  };
  if (opts.origin) headers.origin = opts.origin;
  const response = await worker.fetch(new Request("https://production.test/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
  }), env);
  return { status: response.status, body: await response.json() as {
    result?: { isError?: boolean; content?: Array<{ text?: string }>; tools?: Array<{
      name: string; description?: string; inputSchema: { required?: string[] };
    }> };
    error?: { message?: string };
  } };
}

test("production Portal authentication fails closed before DO dispatch", async () => {
  const f = fixture(async () => Response.json([]));
  const request = { name: "list_devices", arguments: {} };
  const missing = await rpc({ ...f.env, MCP_ACCESS_TOKEN: undefined } as unknown as Env,
    "tools/call", request);
  assert.equal(missing.status, 503);
  const wrong = await rpc(f.env, "tools/call", request, { token: "wrong" });
  assert.equal(wrong.status, 401);
  const origin = await rpc(f.env, "tools/call", request, { origin: "https://evil.test" });
  assert.equal(origin.status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(f.legacyCalls(), 0);
});

test("production tools require explicit device_id and retain owner controls", async () => {
  const f = fixture(async () => Response.json([]));
  const listed = await rpc(f.env, "tools/list", {});
  assert.equal(listed.status, 200);
  const tools = listed.body.result?.tools ?? [];
  for (const name of ["read_file", "write_file", "move_file", "run_command",
    "get_operation_status", "read_session_output"]) {
    const t = tools.find(item => item.name === name);
    assert.ok(t, "missing " + name);
    assert.ok(t.inputSchema.required?.includes("device_id"),
      "device_id is required for " + name);
  }
  for (const name of ["pairing_lookup", "pairing_approve", "list_devices", "revoke_device"]) {
    assert.ok(tools.some(item => item.name === name), "missing owner tool " + name);
  }
  const shell = tools.find(item => item.name === "run_command");
  assert.match(shell?.description ?? "", /Linux/);
  assert.match(shell?.description ?? "", /Windows PowerShell/);
  assert.match(shell?.description ?? "", /OS account.*permissions/);
  assert.match(shell?.description ?? "", /not a security sandbox/);
  assert.match(shell?.description ?? "", /stable operation_id/);
  assert.ok(!shell?.description?.includes("that Linux account"));
  assert.equal(f.calls.length, 0);
});

test("retired MCP Agent upgrade and owner-approval URL cannot dispatch",async()=>{
  const f=fixture(async()=>{throw new Error("No upgrade dispatch allowed");});
  const listed=await rpc(f.env,"tools/list",{});
  assert.ok(!(listed.body.result?.tools??[]).some(t=>t.name==="upgrade_agent"));
  const call=await rpc(f.env,"tools/call",{name:"upgrade_agent",arguments:{
    device_id:deviceId,operation_id:"retired",target_version:"v0.1.34"
  }});
  assert.equal(call.body.result?.isError,true);
  const page=await worker.fetch(new Request(
    "https://production.test/upgrade-approve/retired/"+("0".repeat(64))),f.env);
  assert.equal(page.status,404);
  assert.equal(f.calls.length,0);
});

test("unscoped, invalid and obsolete v1 calls reject without dispatch or hanging", async () => {
  const f = fixture(async () => { throw new Error("unexpected DO call"); });
  for (const [name, args] of [
    ["read_file", { path: "/etc/os-release" }],
    ["read_file", { device_id: "bad", path: "/etc/os-release" }],
    ["write_file", { path: "/tmp/a", content: "x", operation_id: "op-test" }],
    ["start_process", { device_id: deviceId, command: "id" }],
  ] as const) {
    const result = await rpc(f.env, "tools/call", { name, arguments: args });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.result?.isError, true, name);
  }
  assert.equal(f.calls.length, 0, "invalid requests must not reach owner DO");
  assert.equal(f.legacyCalls(), 0, "legacy binding is never invoked");
});

test("scoped benign read routes only to isolated DeviceCoordinator", async () => {
  const f = fixture(async (url, init) => {
    assert.equal(new URL(url).pathname, "/read");
    assert.equal(init?.method, "POST");
    return Response.json({ status: "completed", text: "synthetic-fixture" });
  });
  const read = await rpc(f.env, "tools/call", {
    name: "read_file", arguments: { device_id: deviceId, path: "/tmp/synthetic.txt" },
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.result?.isError, false);
  assert.equal(read.body.result?.content?.[0]?.text, "synthetic-fixture");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]?.body, {
    device_id: deviceId, tool: "read_file", arguments: { path: "/tmp/synthetic.txt" },
  });
  assert.equal(f.calls[0]?.headers.has("x-device-credential"), false);
  assert.equal(f.legacyCalls(), 0);
});

test("owner list_devices uses production coordinator and cannot be retargeted", async () => {
  const f = fixture(async url => {
    assert.equal(new URL(url).pathname, "/devices");
    return Response.json([{ device_id: deviceId, name: "fixture", status: "offline" }]);
  });
  const result = await rpc(f.env, "tools/call",
    { name: "list_devices", arguments: {} });
  assert.equal(result.body.result?.isError, false);
  assert.equal(f.calls.length, 1);
  const tampered = await rpc(f.env, "tools/call",
    { name: "list_devices", arguments: { host: "203.0.113.1" } });
  assert.equal(tampered.body.result?.isError, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.legacyCalls(), 0);
});

test("Computer Use status is scoped to one paired device and only the bounded read route", async () => {
  const f = fixture(async (url, init) => {
    assert.equal(new URL(url).pathname, "/read");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      device_id: deviceId, tool: "computer_status", arguments: {},
    });
    return Response.json({ status: "completed", text: JSON.stringify({
      desktop_grant: "stopped", operable: false, reason: "desktop_stopped",
    }) });
  });
  const listed = await rpc(f.env, "tools/list", {});
  const statusTool = listed.body.result?.tools?.find(t => t.name === "computer_status");
  assert.ok(statusTool);
  assert.deepEqual(statusTool.inputSchema.required, ["device_id"]);
  const denied = await rpc(f.env, "tools/call", {
    name: "computer_status", arguments: {},
  });
  assert.equal(denied.body.result?.isError, true);
  assert.equal(f.calls.length, 0);
  const accepted = await rpc(f.env, "tools/call", {
    name: "computer_status", arguments: { device_id: deviceId },
  });
  assert.equal(accepted.body.result?.isError, false);
  assert.match(accepted.body.result?.content?.[0]?.text ?? "", /desktop_stopped/);
  assert.equal(f.calls.length, 1);
});

test("computer_stop is an explicit non-replayable paired mutation and cannot remotely enable a desktop", async () => {
  const operation_id = "desktop-stop-remote-0001";
  const f = fixture(async (url, init) => {
    assert.equal(new URL(url).pathname, "/operation");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      device_id: deviceId, tool: "computer_stop", operation_id, arguments: {},
    });
    return Response.json({ operation_id, status: "completed" });
  });
  const listing = await rpc(f.env, "tools/list", {});
  assert.ok(listing.body.result?.tools?.some(t => t.name === "computer_stop"));
  assert.ok(!listing.body.result?.tools?.some(t => t.name === "computer_enable"));
  for (const invalid of [
    { operation_id },
    { device_id: deviceId },
    { device_id: "incorrect", operation_id },
    { device_id: deviceId, operation_id, extra: true },
  ]) {
    const response = await rpc(f.env, "tools/call", {
      name: "computer_stop", arguments: invalid,
    });
    assert.equal(response.body.result?.isError, true);
  }
  assert.equal(f.calls.length, 0);
  const response = await rpc(f.env, "tools/call", {
    name: "computer_stop", arguments: { device_id: deviceId, operation_id },
  });
  assert.equal(response.body.result?.isError, false);
  assert.match(response.body.result?.content?.[0]?.text ?? "", /completed/);
  assert.equal(f.calls.length, 1);
});

test("computer_observe exposes a bounded MCP Image Content for an explicitly selected display", async () => {
  const jpeg = Buffer.from([255,216,255,224,0,0,0,0,0,0,0,0,0,0,255,217]).toString("base64");
  const f = fixture(async (url, init) => {
    assert.equal(new URL(url).pathname, "/read");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      device_id: deviceId, tool: "computer_observe",
      arguments: { target_kind: "display", target_id: "primary" },
    });
    return Response.json({
      status:"completed",mime_type:"image/jpeg",data:jpeg,target_id:"primary",
      width:2,height:2,native_width:4,native_height:4,origin_x:-10,origin_y:20,
      session_id:1,observation_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      grant_generation:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });
  const tools = await rpc(f.env,"tools/list",{});
  assert.ok(tools.body.result?.tools?.some(t=>t.name==="computer_observe"));
  for(const invalid of [
    {device_id:deviceId}, {device_id:deviceId,target_kind:"display",target_id:"other"},
    {device_id:deviceId,target_kind:"display",target_id:"primary",extra:true},
  ]){
    const rejected=await rpc(f.env,"tools/call",{name:"computer_observe",arguments:invalid});
    assert.equal(rejected.body.result?.isError,true);
  }
  assert.equal(f.calls.length,0);
  const accepted=await rpc(f.env,"tools/call",{
    name:"computer_observe",arguments:{device_id:deviceId,target_kind:"display",target_id:"primary"},
  });
  assert.equal(accepted.body.result?.isError,false);
  const content=accepted.body.result?.content as Array<{type:string;data?:string;mimeType?:string;text?:string}>;
  assert.equal(content[0]?.type,"image");
  assert.equal(content[0]?.mimeType,"image/jpeg");
  assert.equal(content[0]?.data,jpeg);
  assert.match(content[1]?.text ?? "",/native_width/);
  assert.equal(f.calls.length,1);
});
