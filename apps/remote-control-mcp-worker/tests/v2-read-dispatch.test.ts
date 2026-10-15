import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeReadTool } from "../../remote-control-agent/src/read-execution.ts";
import { monitorDeviceSocket } from "../../remote-control-agent/src/v2-connection-lifecycle.ts";
import { SearchSessions } from "../../remote-control-agent/src/search.ts";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

class ClientSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  private readonly respond: (data: string) => void;
  constructor(respond: (data: string) => void) { super(); this.respond = respond; }
  send(text: string) { this.sent.push(text); this.respond(text); }
  close() { this.readyState = WebSocket.CLOSED; }
  receive(data: string) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

test("MCP read_file with explicit device_id routes through DO WSS only to the approved current device", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remote-v2-dispatch-"));
  const file = path.join(dir, "marker.txt");
  await writeFile(file, "private-A-marker\n", { mode: 0o600 });
  const a = randomUUID(), b = randomUUID(), unknown = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + a, { device_id: a, name: "a", revoked: false }],
    ["device:" + b, { device_id: b, name: "b", revoked: false }],
    ["session:epoch:" + a, "epoch-a"], ["session:epoch:" + b, "epoch-b"],
  ]);
  const storage = { get: async <T>(key: string) => rows.get(key) as T | undefined };
  let owner!: V2OwnerCoordinator;
  const controllers = [new AbortController(), new AbortController()];
  const monitors: Promise<unknown>[] = [];
  const sentToServer: string[] = [];
  const fromServer: string[] = [];
  const createSocket = (device_id: string, epoch: string, index: number) => {
    let client!: ClientSocket;
    const server = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ device_id, epoch }),
      send(message: string) {
        fromServer.push(device_id);
        queueMicrotask(() => client.receive(message));
      },
      close() { client.close(); },
    } as unknown as WebSocket;
    client = new ClientSocket(message => {
      sentToServer.push(device_id);
      queueMicrotask(() => { void owner.webSocketMessage(server, message); });
    });
    const searches = new SearchSessions();
    const monitor = monitorDeviceSocket(client as unknown as WebSocket, controllers[index]!.signal,
      { intervalMs: 60_000, timeoutMs: 10_000 },
      async (args, signal) => {
        const reply = await executeReadTool("read_file", args, searches, signal);
        return reply.kind === "completed" ? reply.text : null;
      });
    monitors.push(monitor.finally(() => searches.close()));
    return server;
  };
  const serverA = createSocket(a, "epoch-a", 0);
  const serverB = createSocket(b, "epoch-b", 1);
  const state = {
    storage,
    getWebSockets(tag: string) {
      return tag === "device:" + a ? [serverA] : tag === "device:" + b ? [serverB] : [];
    },
  } as unknown as DurableObjectState;
  owner = new V2OwnerCoordinator(state);
  let legacyCalls = 0, doCalls = 0;
  const V2_OWNER = {
    idFromName: () => "only-owner",
    get: () => ({
      fetch(input: RequestInfo | URL, init?: RequestInit) {
        doCalls++;
        return owner.fetch(input instanceof Request ? input : new Request(input, init));
      },
    }),
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "portal-test",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy-v1-test",
    REMOTE_CONTROL_DEVICE: { fetch() { legacyCalls++; throw new Error("v1 must not be used"); } },
    V2_OWNER,
  } as unknown as Env;
  async function call(device_id: unknown, token = "portal-test") {
    const res = await worker.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name: "read_file", arguments: { device_id, path: file, offset: 0, length: 1 },
      } }),
    }), env);
    return { http: res.status, body: await res.text() };
  }
  try {
    const forbidden = await call(a, "wrong");
    assert.equal(forbidden.http, 401);
    assert.equal(doCalls, 0);
    const success = await call(a);
    assert.equal(success.http, 200);
    assert.match(success.body, /private-A-marker/);
    assert.deepEqual(fromServer, [a]);
    assert.deepEqual(sentToServer, [a]);
    const absent = await call(unknown);
    assert.doesNotMatch(absent.body, /private-A-marker/);
    assert.match(absent.body, /unavailable/);
    const invalid = await call("../b");
    assert.match(invalid.body, /valid device_id/);
    assert.equal(legacyCalls, 0);
    assert.equal(fromServer.length, 1, "unknown and malformed device must not be dispatched");
  } finally {
    controllers.forEach(c => c.abort());
    await Promise.all(monitors);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Agent only accepts bounded read_file frames when explicitly enabled", async () => {
  const controller = new AbortController();
  const client = new ClientSocket(() => {});
  let called = 0;
  const monitored = monitorDeviceSocket(client as unknown as WebSocket, controller.signal,
    { intervalMs: 60_000, timeoutMs: 10_000 }, async () => { called++; return "data"; });
  client.receive(JSON.stringify({ kind: "read", request_id: randomUUID(),
    tool: "start_process", arguments: { command: "exit 0" } }));
  assert.equal(await monitored, "policy");
  assert.equal(called, 0);
  const disabled = new ClientSocket(() => {});
  const stopped = monitorDeviceSocket(disabled as unknown as WebSocket, new AbortController().signal,
    { intervalMs: 60_000, timeoutMs: 10_000 });
  disabled.receive(JSON.stringify({ kind: "read", request_id: randomUUID(),
    tool: "read_file", arguments: { path: "/tmp/not-authorized" } }));
  assert.equal(await stopped, "policy");
});

test("a second device cannot spoof a read reply and a superseded epoch cannot return stale content", async () => {
  const a = randomUUID(), b = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + a, { device_id: a, revoked: false }],
    ["device:" + b, { device_id: b, revoked: false }],
    ["session:epoch:" + a, "current-a"],
    ["session:epoch:" + b, "current-b"],
  ]);
  let requestId: string | undefined;
  let received!: () => void;
  const hasRequest = new Promise<void>(resolve => { received = resolve; });
  let wrongClosed = false;
  const good = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: a, epoch: "current-a" }),
    send(data: string) {
      const request = JSON.parse(data) as { request_id: string; kind: string };
      assert.equal(request.kind, "read");
      requestId = request.request_id;
      received();
    },
  } as unknown as WebSocket;
  const wrong = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: b, epoch: "current-b" }),
    close(code: number) { assert.equal(code, 1008); wrongClosed = true; },
  } as unknown as WebSocket;
  const owner = new V2OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets(tag: string) { return tag === "device:" + a ? [good] : [wrong]; },
  } as unknown as DurableObjectState);
  const pending = owner.fetch(new Request("https://v2.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: a, tool: "read_file", arguments: { path: "/tmp/safe" } }),
  }));
  await hasRequest;
  await owner.webSocketMessage(wrong, JSON.stringify({
    kind: "read_result", request_id: requestId, status: "completed", text: "FORGED-B",
  }));
  assert.equal(wrongClosed, true);
  // A new signed WSS session supersedes the original request before its reply.
  rows.set("session:epoch:" + a, "newer-a");
  await owner.webSocketMessage(good, JSON.stringify({
    kind: "read_result", request_id: requestId, status: "completed", text: "STALE-A",
  }));
  const response = await pending;
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /FORGED-B|STALE-A/);
});

test("old epoch and revoked device are rejected before WSS dispatch", async () => {
  const id = randomUUID();
  let sends = 0;
  const rows = new Map<string, unknown>([
    ["device:" + id, { device_id: id, revoked: false }],
    ["session:epoch:" + id, "newer"],
  ]);
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: id, epoch: "old" }),
    send() { sends++; },
  } as unknown as WebSocket;
  const owner = new V2OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: () => [socket],
  } as unknown as DurableObjectState);
  const request = () => owner.fetch(new Request("https://v2.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: id, tool: "read_file", arguments: { path: "/tmp/safe" } }),
  }));
  assert.equal((await request()).status, 503);
  rows.set("device:" + id, { device_id: id, revoked: true });
  assert.equal((await request()).status, 503);
  assert.equal(sends, 0);
});

test("five simultaneous DO reads admit only four bounded in-flight requests", async () => {
  const id = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + id, { device_id: id, revoked: false }],
    ["session:epoch:" + id, "current"],
  ]);
  const sent: string[] = [];
  let reachedFour!: () => void;
  const four = new Promise<void>(resolve => { reachedFour = resolve; });
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: id, epoch: "current" }),
    send(text: string) {
      sent.push((JSON.parse(text) as { request_id: string }).request_id);
      if (sent.length === 4) reachedFour();
    },
  } as unknown as WebSocket;
  const owner = new V2OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: () => [socket],
  } as unknown as DurableObjectState);
  const makeRequest = () => owner.fetch(new Request("https://v2.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: id, tool: "read_file", arguments: { path: "/tmp/marker" } }),
  }));
  const requests = Array.from({ length: 5 }, makeRequest);
  await four;
  await Promise.resolve();
  for (const request_id of sent) {
    await owner.webSocketMessage(socket, JSON.stringify({
      kind: "read_result", request_id, status: "completed", text: "ok",
    }));
  }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 200, 200, 503]);
  assert.equal(sent.length, 4);
});
