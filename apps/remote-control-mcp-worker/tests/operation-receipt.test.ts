import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import worker from "../src/worker.ts";
import { OwnerCoordinator } from "../src/pairing.ts";

// No Agent implementation: each test supplies the exact wire reply.
function operationRoutingFixture() {
  const a = randomUUID(), b = randomUUID();
  const rows = new Map<string, unknown>();
  const sockets = new Map<string, WebSocket>();
  let owner!: OwnerCoordinator;
  let reply: Record<string, unknown> = {};
  const dispatched: { device: string; frame: Record<string, unknown> }[] = [];
  for (const device of [a, b]) {
    const epoch = randomUUID();
    rows.set("device:" + device, { device_id: device, revoked: false,
      last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 });
    rows.set("session:epoch:" + device, epoch);
    const socket = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ device_id: device, epoch }),
      send(text: string) {
        const frame = JSON.parse(text);
        dispatched.push({ device, frame });
        queueMicrotask(() => { void owner.webSocketMessage(socket, JSON.stringify({
          request_id: frame.request_id, ...reply,
        })); });
      },
    } as unknown as WebSocket;
    sockets.set("device:" + device, socket);
  }
  owner = new OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: (tag: string) => sockets.has(tag) ? [sockets.get(tag)!] : [],
  } as unknown as DurableObjectState);
  let legacy = 0;
  const env = {
    MCP_ACCESS_TOKEN: "authorized",
    REMOTE_CONTROL_DEVICE: { fetch() { legacy++; throw Error("legacy forbidden"); } },
    DEVICE_COORDINATOR: { idFromName: () => "owner", get: () => ({
      fetch(input: RequestInfo | URL, init?: RequestInit) {
        return owner.fetch(input instanceof Request ? input : new Request(input, init));
      },
    }) },
  } as unknown as Env;
  async function call(tool: string, args: object, token = "authorized") {
    const response = await worker.fetch(new Request("https://mcp.test/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: tool, arguments: args } }),
    }), env);
    const body = await response.json() as { result?: { content: Array<{ text: string }>; isError?: boolean } };
    return { http: response.status, error: body.result?.isError, text: body.result?.content[0]?.text ?? "" };
  }
  async function exchange(device: string, publicTool: string, args: object, expected: object,
    wireReply: Record<string, unknown>) {
    reply = wireReply;
    const before = dispatched.length;
    const actual = await call(publicTool, { device_id: device, ...args });
    assert.equal(dispatched.length, before + 1);
    const sent = dispatched[before]!;
    assert.equal(sent.device, device);
    assert.match(String(sent.frame.request_id), /^[a-f0-9-]{36}$/);
    assert.deepEqual(sent.frame, { request_id: sent.frame.request_id, ...expected });
    return actual;
  }
  async function op(device: string, operationId: string, publicTool: string, args: object,
    wireTool: string, wireArgs: object, status: string, extra: object = {}) {
    const result = { operation_id: operationId, status, ...extra };
    const actual = await exchange(device, publicTool, { operation_id: operationId, ...args },
      { kind: "operation", tool: wireTool, operation_id: operationId, arguments: wireArgs },
      { kind: "operation_result", result });
    assert.deepEqual(JSON.parse(actual.text), status === "unavailable"
      ? { operation_id: operationId, status: "timeout_unknown" } : result);
  }
  async function read(device: string, publicTool: string, args: object, wireTool: string, wireArgs: object, text?: string) {
    const actual = await exchange(device, publicTool, args, { kind: "read", tool: wireTool, arguments: wireArgs },
      text === undefined ? { kind: "read_result", status: "failed" } : { kind: "read_result", status: "completed", text });
    if (text === undefined) assert.equal(actual.error, true);
    else assert.equal(actual.text, text);
  }
  return { a, b, call, op, read, dispatched, legacyCalls: () => legacy };
}

// Actual file effects, process ownership and durable deduplication belong to
// native_file_wss, native_process_wss and receipt_contract.
test("Worker routes exact operation intent and receipts to each device", async () => {
  const { a, b, call, op, read, dispatched, legacyCalls } = operationRoutingFixture();
  const absent = randomUUID(), id = randomUUID(), sessionId = randomUUID();
  const write = { path: "/tmp/marker", content: "A", mode: "append" };
  assert.equal((await call("write_file", { device_id: a, operation_id: id, ...write }, "denied")).http, 401);
  assert.equal((await call("write_file", { device_id: a, ...write })).error, true);
  assert.deepEqual(JSON.parse((await call("write_file", { device_id: absent, operation_id: id, ...write })).text),
    { operation_id: id, status: "offline", not_dispatched: true });
  assert.equal(dispatched.length, 0);
  await op(a, id, "write_file", write, "write_file", write, "completed");
  await op(a, id, "write_file", write, "write_file", write, "completed");
  const changed = { ...write, content: "CHANGED" };
  await op(a, id, "write_file", changed, "write_file", changed, "conflict");
  await op(b, id, "get_operation_status", {}, "get_operation_status", { operation_id: id }, "not_found");
  await op(a, id, "get_operation_status", {}, "get_operation_status", { operation_id: id }, "completed",
    { receipt: { operation_id: id, tool_name: "write_file", state: "completed" } });
  await op(b, id, "write_file", write, "write_file", write, "completed");
  const dir = { path: "/tmp/created" };
  await op(a, randomUUID(), "create_directory", dir, "create_directory", dir, "completed");
  const edit = { file_path: write.path, old_string: "A", new_string: "EDITED" };
  await op(a, randomUUID(), "replace_text", edit, "edit_block", { ...edit, expected_replacements: 1 }, "completed");
  const move = { source: write.path, destination: "/tmp/moved" };
  await op(a, randomUUID(), "move_file", move, "move_file", move, "completed");
  const del = { path: move.destination };
  await op(a, randomUUID(), "delete_file", del, "delete_file", del, "completed");
  const launchId = randomUUID(), command = { command: "fixture-only", timeout_ms: 0 };
  await op(a, launchId, "run_command", command, "start_process", command, "running", { session_id: sessionId });
  await op(a, launchId, "run_command", command, "start_process", command, "running", { session_id: sessionId });
  await op(b, launchId, "get_operation_status", {}, "get_operation_status", { operation_id: launchId }, "not_found");
  await op(a, launchId, "get_operation_status", {}, "get_operation_status", { operation_id: launchId }, "running",
    { receipt: { operation_id: launchId, tool_name: "start_process", state: "running", session_id: sessionId } });
  await read(a, "list_sessions", {}, "list_sessions", {}, JSON.stringify([{ session_id: sessionId }]));
  await read(b, "list_sessions", {}, "list_sessions", {}, "[]");
  const output = { session_id: sessionId, offset: 0, length: 1024 };
  await read(a, "read_session_output", output, "read_process_output", output, JSON.stringify({ session_id: sessionId, output: "fixture", next_offset: 7 }));
  await read(b, "read_session_output", { session_id: sessionId }, "read_process_output", { session_id: sessionId, offset: 0, length: 16384 });
  const input = { session_id: sessionId, input: "fixture input" };
  await op(a, randomUUID(), "send_input", input, "interact_with_process", input, "completed");
  await op(b, randomUUID(), "send_input", input, "interact_with_process", input, "unavailable");
  const stop = { session_id: sessionId };
  await op(a, randomUUID(), "stop_session", stop, "force_terminate", stop, "completed");
  const before = dispatched.length;
  assert.equal((await call("stop_session", { device_id: a, operation_id: randomUUID(), session_id: "123" })).error, true);
  assert.equal((await call("run_command", { device_id: a, command: "fixture-only" })).error, true);
  assert.equal(dispatched.length, before);
  assert.equal(legacyCalls(), 0);
});

test("a socket send failure does not promise an operation was never dispatched", async () => {
  const deviceId = randomUUID();
  const operationId = "send-unknown-" + randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + deviceId, { device_id: deviceId, revoked: false,
      last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + deviceId, "current"],
  ]);
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: deviceId, epoch: "current" }),
    send() { throw new Error("ambiguous transport failure"); },
  } as unknown as WebSocket;
  const owner = new OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: (tag: string) => tag === "device:" + deviceId ? [socket] : [],
  } as unknown as DurableObjectState);
  const reply = await owner.fetch(new Request("https://device.internal/operation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, operation_id: operationId,
      tool: "write_file", arguments: { path: "/tmp/not-sent", content: "x", mode: "append" } }),
  }));
  assert.equal(reply.status, 503);
  assert.deepEqual(await reply.json(), { error: "timeout_unknown" });
});

test("Worker labels only proven pre-dispatch busy and offline as not dispatched", async () => {
  const deviceId = randomUUID();
  const operationId = "refused-" + randomUUID();
  let reason = "busy";
  const env = {
    MCP_ACCESS_TOKEN: "authorized",
    DEVICE_COORDINATOR: { idFromName: () => "owner", get: () => ({
      fetch: async () => Response.json({ error: reason }, { status: 503 }),
    }) },
  } as unknown as Env;
  async function call() {
    const response = await worker.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer authorized" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call",
        params: { name: "write_file", arguments: {
          device_id: deviceId, operation_id: operationId,
          path: "/tmp/not-sent", content: "x", mode: "append",
        } } }),
    }), env);
    const body = await response.json() as { result: { content: Array<{ text: string }> } };
    return JSON.parse(body.result.content[0]!.text);
  }
  assert.deepEqual(await call(), { operation_id: operationId, status: "busy", not_dispatched: true });
  reason = "offline";
  assert.deepEqual(await call(), { operation_id: operationId, status: "offline", not_dispatched: true });
  reason = "timeout_unknown";
  assert.deepEqual(await call(), { operation_id: operationId, status: "timeout_unknown" });
});

test("response lost after dispatch returns timeout_unknown; reconnect only queries the receipt", async () => {
  const marker = "/tmp/fixture-output";
  const deviceId = randomUUID();
  const id = "lost-" + randomUUID();
  const dispatched: Record<string, unknown>[] = [];
  let owner!: OwnerCoordinator;
  let currentSocket: WebSocket | undefined;
  let epoch = "first";
  const rows = new Map<string, unknown>([
    ["device:" + deviceId, { device_id: deviceId, revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + deviceId, epoch],
  ]);
  const state = {
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: (tag: string) => tag === "device:" + deviceId && currentSocket ? [currentSocket] : [],
  } as unknown as DurableObjectState;
  owner = new OwnerCoordinator(state);
  function connect() {
    const server = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ device_id: deviceId, epoch }),
      send(text: string) {
        const frame = JSON.parse(text);
        dispatched.push(frame);
        if (epoch === "first") {
          queueMicrotask(() => {
            currentSocket = undefined;
            void owner.webSocketClose(server, 1006, "network lost", false);
          });
        } else {
          queueMicrotask(() => { void owner.webSocketMessage(server, JSON.stringify({
            kind: "operation_result", request_id: frame.request_id,
            result: { operation_id: id, status: "completed",
              receipt: { operation_id: id, tool_name: "write_file", state: "completed" } },
          })); });
        }
      },
    } as unknown as WebSocket;
    currentSocket = server;
  }
  const env = {
    MCP_ACCESS_TOKEN: "portal",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy",
    DEVICE_COORDINATOR: {
      idFromName: () => "owner",
      get: () => ({ fetch(input: RequestInfo | URL, init?: RequestInit) {
        return owner.fetch(input instanceof Request ? input : new Request(input, init));
      } }),
    },
  } as unknown as Env;
  async function call(name: string, args: object) {
    const response = await worker.fetch(new Request("https://mcp.test/mcp", {
      method: "POST", headers: { "authorization": "Bearer portal", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name, arguments: args } }),
    }), env);
    const data = await response.json() as { result: { content: Array<{ text: string }> } };
    return JSON.parse(data.result.content[0]!.text) as Record<string, unknown>;
  }
  {
    connect();
    const result = await call("write_file", {
      device_id: deviceId, operation_id: id, path: marker, content: "ONCE\n", mode: "append",
    });
    assert.equal(result.status, "timeout_unknown");
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], { kind: "operation", request_id: dispatched[0]!.request_id,
      tool: "write_file", operation_id: id, arguments: { path: marker, content: "ONCE\n", mode: "append" } });
    // A new signed session has an independently persisted epoch. No replay
    // was enqueued in the DO; only an explicitly requested lookup follows.
    epoch = "second";
    rows.set("session:epoch:" + deviceId, epoch);
    connect();
    assert.equal(dispatched.length, 1, "no replay on reconnect");
    const receipt = await call("get_operation_status", { device_id: deviceId, operation_id: id });
    assert.equal(receipt.status, "completed");
    assert.equal((receipt.receipt as { operation_id: string }).operation_id, id);
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1], { kind: "operation", request_id: dispatched[1]!.request_id,
      tool: "get_operation_status", operation_id: id, arguments: { operation_id: id } });
    // A caller may explicitly retry exactly the same operation ID and intent.
    const retry = await call("write_file", {
      device_id: deviceId, operation_id: id, path: marker, content: "ONCE\n", mode: "append",
    });
    assert.equal(retry.status, "completed");
    assert.equal(dispatched.length, 3);
    assert.deepEqual(dispatched[2], { ...dispatched[0], request_id: dispatched[2]!.request_id });
  }
});
