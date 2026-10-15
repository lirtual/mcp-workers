import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentExecutionEngine } from "../../remote-control-agent/src/execution.ts";
import { monitorDeviceSocket, executeV2FileOperation } from "../../remote-control-agent/src/v2-connection-lifecycle.ts";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

class Client extends EventTarget {
  readyState: number = WebSocket.OPEN;
  private readonly outgoing: (frame: string) => void;
  constructor(outgoing: (frame: string) => void) { super(); this.outgoing = outgoing; }
  send(data: string) { this.outgoing(data); }
  close() { this.readyState = WebSocket.CLOSED; }
  receive(data: string) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

test("v2 write_file preserves Agent receipt idempotency per device; no v1 fallback or cross-device lookup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-receipt-"));
  const a = randomUUID(), b = randomUUID(), absent = randomUUID();
  const id = "intent-" + randomUUID();
  const markerA = path.join(dir, "a.log");
  const markerB = path.join(dir, "b.log");
  const engines = [
    createAgentExecutionEngine({ receiptDirectory: path.join(dir, "receipts-a") }),
    createAgentExecutionEngine({ receiptDirectory: path.join(dir, "receipts-b") }),
  ];
  const stops = [new AbortController(), new AbortController()];
  const monitors: Promise<unknown>[] = [];
  const epochs = new Map([[a, "epoch-a"], [b, "epoch-b"]]);
  const data = new Map<string, unknown>([
    ["device:" + a, { device_id: a, revoked: false }],
    ["device:" + b, { device_id: b, revoked: false }],
    ["session:epoch:" + a, "epoch-a"], ["session:epoch:" + b, "epoch-b"],
  ]);
  let owner!: V2OwnerCoordinator;
  let legacy = 0;
  const serverSockets = new Map<string, WebSocket[]>();
  for (const [index, device] of [a, b].entries()) {
    const execution = engines[index]!;
    let client!: Client;
    const server = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ device_id: device, epoch: epochs.get(device) }),
      send(frame: string) { queueMicrotask(() => client.receive(frame)); },
      close() { client.close(); },
    } as unknown as WebSocket;
    client = new Client(frame => {
      queueMicrotask(() => { void owner.webSocketMessage(server, frame); });
    });
    const monitor = monitorDeviceSocket(client as unknown as WebSocket, stops[index]!.signal,
      { intervalMs: 60_000, timeoutMs: 10_000 }, undefined,
      (tool, args, operationId, signal) =>
        executeV2FileOperation(execution, tool, args, operationId, signal));
    monitors.push(monitor);
    serverSockets.set("device:" + device, [server]);
  }
  const storage = { get: async <T>(key: string) => data.get(key) as T | undefined };
  owner = new V2OwnerCoordinator({
    storage, getWebSockets: (tag: string) => serverSockets.get(tag) ?? [],
  } as unknown as DurableObjectState);
  const env = {
    MCP_ACCESS_TOKEN: "authorized",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy",
    REMOTE_CONTROL_DEVICE: { fetch() { legacy++; throw new Error("v1 call forbidden"); } },
    V2_OWNER: { idFromName: () => "single-owner", get: () => ({
      fetch(input: RequestInfo | URL, init?: RequestInit) {
        return owner.fetch(input instanceof Request ? input : new Request(input, init));
      },
    }) },
  } as unknown as Env;
  async function call(tool: string, args: object, token = "authorized") {
    const result = await worker.fetch(new Request("https://mcp.test/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: tool, arguments: args } }),
    }), env);
    const body = await result.json() as { result?: { content: Array<{ text: string }>; isError?: boolean } };
    return { http: result.status, data: body,
      content: body.result?.content[0]?.text ?? "" };
  }
  try {
    assert.equal((await call("write_file", { device_id: a, operation_id: id,
      path: markerA, content: "A\n", mode: "append" }, "denied")).http, 401);
    const missing = await call("write_file", { device_id: a, path: markerA, content: "A\n", mode: "append" });
    assert.equal(missing.data.result?.isError, true);
    assert.equal((await call("write_file", { device_id: absent, operation_id: id,
      path: markerA, content: "A\n", mode: "append" })).content.includes("timeout_unknown"), true);

    const writeA = await call("write_file", { device_id: a, operation_id: id,
      path: markerA, content: "A\n", mode: "append" });
    assert.equal(JSON.parse(writeA.content).status, "completed");
    const repeated = await call("write_file", { device_id: a, operation_id: id,
      path: markerA, content: "A\n", mode: "append" });
    assert.equal(JSON.parse(repeated.content).status, "completed");
    assert.equal(await readFile(markerA, "utf8"), "A\n", "original Agent receipt prevents second append");
    const conflict = await call("write_file", { device_id: a, operation_id: id,
      path: markerA, content: "CHANGED\n", mode: "append" });
    assert.equal(JSON.parse(conflict.content).status, "conflict");
    assert.equal(await readFile(markerA, "utf8"), "A\n");

    const invalidDirectory = await call("create_directory", {
      device_id: a, path: path.join(dir, "unauthorized"),
    });
    assert.equal(invalidDirectory.data.result?.isError, true);
    const subdir = path.join(dir, "created");
    const mkdirId = "mkdir-" + randomUUID();
    const createArgs = { device_id: a, operation_id: mkdirId, path: subdir };
    assert.equal(JSON.parse((await call("create_directory", createArgs)).content).status, "completed");
    assert.equal(JSON.parse((await call("create_directory", createArgs)).content).status, "completed");
    assert.equal(JSON.parse((await call("create_directory", {
      ...createArgs, path: path.join(dir, "other"),
    })).content).status, "conflict");

    const editId = "edit-" + randomUUID();
    const editArgs = { device_id: a, operation_id: editId, file_path: markerA,
      old_string: "A\n", new_string: "EDITED\n" };
    assert.equal(JSON.parse((await call("replace_text", editArgs)).content).status, "completed");
    assert.equal(JSON.parse((await call("replace_text", editArgs)).content).status, "completed");
    assert.equal(await readFile(markerA, "utf8"), "EDITED\n");

    const moved = path.join(subdir, "moved.txt");
    const moveArgs = { device_id: a, operation_id: "move-" + randomUUID(),
      source: markerA, destination: moved };
    assert.equal(JSON.parse((await call("move_file", moveArgs)).content).status, "completed");
    assert.equal(JSON.parse((await call("move_file", moveArgs)).content).status, "completed");
    assert.equal(await readFile(moved, "utf8"), "EDITED\n");
    const deleteArgs = { device_id: a, operation_id: "delete-" + randomUUID(), path: moved };
    assert.equal(JSON.parse((await call("delete_file", deleteArgs)).content).status, "completed");
    assert.equal(JSON.parse((await call("delete_file", deleteArgs)).content).status, "completed");
    await assert.rejects(readFile(moved, "utf8"), { code: "ENOENT" });

    const notAtB = await call("get_operation_status", { device_id: b, operation_id: id });
    assert.equal(JSON.parse(notAtB.content).status, "not_found");
    const receiptA = await call("get_operation_status", { device_id: a, operation_id: id });
    const receipt = JSON.parse(receiptA.content) as { status: string; receipt: { operation_id: string } };
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.receipt.operation_id, id);
    const writeB = await call("write_file", { device_id: b, operation_id: id,
      path: markerB, content: "B\n", mode: "append" });
    assert.equal(JSON.parse(writeB.content).status, "completed");
    assert.equal(await readFile(markerB, "utf8"), "B\n");
    const launchId = "launch-" + randomUUID();
    const launchArgs = { device_id: a, operation_id: launchId,
      command: "printf 'mcp-v2-session-A\\n'", timeout_ms: 0 };
    const launched = JSON.parse((await call("run_command", launchArgs)).content) as {
      operation_id: string; status: string; session_id?: string;
    };
    assert.equal(launched.operation_id, launchId);
    assert.match(launched.status, /^(running|completed)$/);
    assert.match(launched.session_id!, /^[a-f0-9-]{36}$/);
    const duplicate = JSON.parse((await call("run_command", launchArgs)).content);
    assert.equal(duplicate.session_id, launched.session_id);
    const changedCommand = JSON.parse((await call("run_command", {
      ...launchArgs, command: "printf 'DIFFERENT\\n'",
    })).content);
    assert.equal(changedCommand.status, "conflict");
    const deviceBReceipt = JSON.parse((await call("get_operation_status", {
      device_id: b, operation_id: launchId,
    })).content);
    assert.equal(deviceBReceipt.status, "not_found");
    const sessionReceipt = JSON.parse((await call("get_operation_status", {
      device_id: a, operation_id: launchId,
    })).content);
    assert.equal(sessionReceipt.receipt.session_id, launched.session_id);
    const missingShellId = await call("run_command", { device_id: a, command: "date" });
    assert.equal(missingShellId.data.result?.isError, true);
    assert.equal(legacy, 0);
  } finally {
    stops.forEach(stop => stop.abort());
    await Promise.all(monitors);
    await Promise.all(engines.map(engine => engine.close()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("without an operation callback, signed v2 Agent rejects file mutation frames", async () => {
  const stop = new AbortController();
  const socket = new Client(() => {});
  const run = monitorDeviceSocket(socket as unknown as WebSocket, stop.signal,
    { intervalMs: 60_000, timeoutMs: 10_000 });
  socket.receive(JSON.stringify({ kind: "operation", request_id: randomUUID(),
    operation_id: "intent-1", tool: "write_file",
    arguments: { path: "/tmp/no-write", content: "NO", mode: "append" } }));
  assert.equal(await run, "policy");
});

test("response-lost-after-write returns timeout_unknown; reconnect only queries the persisted receipt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-response-lost-"));
  const marker = path.join(dir, "output.txt");
  const deviceId = randomUUID();
  const id = "lost-" + randomUUID();
  const engine = createAgentExecutionEngine({ receiptDirectory: path.join(dir, "receipts") });
  const controllers: AbortController[] = [];
  const monitors: Promise<unknown>[] = [];
  let owner!: V2OwnerCoordinator;
  let currentSocket: WebSocket | undefined;
  let epoch = "first";
  let loseFirstResult = true;
  const rows = new Map<string, unknown>([
    ["device:" + deviceId, { device_id: deviceId, revoked: false }],
    ["session:epoch:" + deviceId, epoch],
  ]);
  const state = {
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: (tag: string) => tag === "device:" + deviceId && currentSocket ? [currentSocket] : [],
  } as unknown as DurableObjectState;
  owner = new V2OwnerCoordinator(state);
  function connect() {
    const stop = new AbortController();
    controllers.push(stop);
    let client!: Client;
    const server = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ device_id: deviceId, epoch }),
      send(text: string) { queueMicrotask(() => client.receive(text)); },
      close() { client.close(); },
    } as unknown as WebSocket;
    client = new Client(frame => {
      const message = JSON.parse(frame) as { kind?: string };
      if (message.kind === "operation_result" && loseFirstResult) {
        loseFirstResult = false;
        queueMicrotask(() => {
          void owner.webSocketClose(server, 1006, "network lost", false);
          currentSocket = undefined;
          stop.abort();
        });
        return; // The Agent executed, but DO never received its receipt.
      }
      queueMicrotask(() => { void owner.webSocketMessage(server, frame); });
    });
    const monitor = monitorDeviceSocket(client as unknown as WebSocket, stop.signal,
      { intervalMs: 60_000, timeoutMs: 10_000 }, undefined,
      (tool, args, operationId, signal) =>
        executeV2FileOperation(engine, tool, args, operationId, signal));
    monitors.push(monitor);
    currentSocket = server;
  }
  const env = {
    MCP_ACCESS_TOKEN: "portal",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy",
    V2_OWNER: {
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
  try {
    connect();
    const result = await call("write_file", {
      device_id: deviceId, operation_id: id, path: marker, content: "ONCE\n", mode: "append",
    });
    assert.equal(result.status, "timeout_unknown");
    assert.equal(await readFile(marker, "utf8"), "ONCE\n", "write may have committed before lost reply");
    // A new signed session has an independently persisted epoch. No replay
    // was enqueued in the DO; only an explicitly requested lookup follows.
    epoch = "second";
    rows.set("session:epoch:" + deviceId, epoch);
    connect();
    const receipt = await call("get_operation_status", { device_id: deviceId, operation_id: id });
    assert.equal(receipt.status, "completed");
    assert.equal((receipt.receipt as { operation_id: string }).operation_id, id);
    assert.equal(await readFile(marker, "utf8"), "ONCE\n");
    // A client manually retrying the SAME ID and SAME intent is harmless.
    const retry = await call("write_file", {
      device_id: deviceId, operation_id: id, path: marker, content: "ONCE\n", mode: "append",
    });
    assert.equal(retry.status, "completed");
    assert.equal(await readFile(marker, "utf8"), "ONCE\n");
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.all(monitors);
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
