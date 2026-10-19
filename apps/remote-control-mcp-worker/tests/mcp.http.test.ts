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
      name: string; inputSchema: { required?: string[] };
    }> };
    error?: { message?: string };
  } };
}

test("production Portal authentication fails closed before DO dispatch", async () => {
  const f = fixture(async () => Response.json([]));
  const request = { name: "list_devices", arguments: {} };
  const missing = await rpc({ ...f.env, MCP_ACCESS_TOKEN: undefined } as Env,
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
  assert.equal(f.calls.length, 0);
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
