import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { V2OwnerCoordinator } from "../src/worker.ts";

function testFleet() {
  const a = randomUUID(), b = randomUUID();
  const data = new Map<string, unknown>([
    ["device:" + a, { device_id: a, name: "home", revoked: false }],
    ["device:" + b, { device_id: b, name: "office", revoked: false }],
    ["session:epoch:" + a, "epoch-a"], ["session:epoch:" + b, "epoch-b"],
  ]);
  const reads = new Map<string, string[]>();
  const requestReady = new Map<string, () => void>();
  const seenA = new Promise<void>(resolve => requestReady.set(a, resolve));
  const seenB = new Promise<void>(resolve => requestReady.set(b, resolve));
  function socket(id: string, epoch: string) {
    return {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ device_id: id, epoch, last_auth_check_at: Date.now() - 1_000 }),
      send(text: string) {
        const frame = JSON.parse(text) as { kind: string; request_id: string };
        assert.equal(frame.kind, "read");
        reads.set(id, [...(reads.get(id) ?? []), frame.request_id]);
        requestReady.get(id)?.();
      },
      close() { /* mock Cloudflare close notification */ },
    } as unknown as WebSocket;
  }
  const aSocket = socket(a, "epoch-a");
  const bSocket = socket(b, "epoch-b");
  let sockets = new Map([["device:" + a, [aSocket]], ["device:" + b, [bSocket]]]);
  const storage = {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
  };
  const state = {
    storage,
    getWebSockets: (tag: string) => sockets.get(tag) ?? [],
  } as unknown as DurableObjectState;
  const owner = new V2OwnerCoordinator(state);
  function read(id: string) {
    return owner.fetch(new Request("https://v2.internal/read", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: id, tool: "read_file", arguments: { path: "/tmp/fixture" } }),
    }));
  }
  return { a, b, aSocket, bSocket, reads, data, state, owner, read, seenA, seenB,
    removeSocket(id: string) { sockets.set("device:" + id, []); },
    replaceSocket(id: string, ws: WebSocket) { sockets.set("device:" + id, [ws]); } };
}

test("DO Hibernation socket close cancels only that device's in-flight reads immediately", async () => {
  const f = testFleet();
  const aResult = f.read(f.a), bResult = f.read(f.b);
  await Promise.all([f.seenA, f.seenB]);
  await f.owner.webSocketClose(f.aSocket, 1000, "normal disconnect", true);
  f.removeSocket(f.a);
  const response = await aResult;
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "offline" });
  assert.equal(f.data.get("session:epoch:" + f.a), "epoch-a", "close must not revoke device or clear newer epochs");
  const bRequest = f.reads.get(f.b)![0]!;
  await f.owner.webSocketMessage(f.bSocket, JSON.stringify({
    kind: "read_result", request_id: bRequest, status: "completed", text: "device-B-ok",
  }));
  assert.equal((await bResult).status, 200);
  // Late reply from a closed connection must never rescue or requeue the lost read.
  await f.owner.webSocketMessage(f.aSocket, JSON.stringify({
    kind: "read_result", request_id: f.reads.get(f.a)![0], status: "completed", text: "stale",
  }));
  const denied = await f.read(f.a);
  assert.equal(denied.status, 503);
  assert.equal(f.reads.get(f.a)!.length, 1);
});

test("DO websocket error rejects in-flight work, while a reconstructed DO finds the other live socket", async () => {
  const f = testFleet();
  const read = f.read(f.a);
  await f.seenA;
  await f.owner.webSocketError(f.aSocket, new Error("disconnect"));
  assert.equal((await read).status, 503);
  f.removeSocket(f.a);
  // Simulate memory eviction: new class instance, same durable storage and socket registry.
  const revived = new V2OwnerCoordinator(f.state);
  const result = await revived.fetch(new Request("https://v2.internal/devices", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  assert.deepEqual(await result.json(), [
    { device_id: f.a, name: "home", status: "offline" },
    { device_id: f.b, name: "office", status: "online" },
  ].sort((x, y) => x.device_id.localeCompare(y.device_id)));
  // An actual read dispatched by the reconstructed DO must target the live
  // device and correlate only a new request; no prior in-memory map is needed.
  const fresh = revived.fetch(new Request("https://v2.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: f.b, tool: "read_file", arguments: { path: "/tmp/fixture" } }),
  }));
  await f.seenB;
  await revived.webSocketMessage(f.bSocket, JSON.stringify({
    kind: "read_result", request_id: f.reads.get(f.b)![0], status: "completed", text: "awake-B",
  }));
  assert.deepEqual(await (await fresh).json(), { status: "completed", text: "awake-B" });
});

test("a closing socket is not listed as online even before close handshake completes", async () => {
  const f = testFleet();
  const closing = { readyState: WebSocket.CLOSING,
    deserializeAttachment: () => ({ device_id: f.a, epoch: "epoch-a" }) } as unknown as WebSocket;
  f.replaceSocket(f.a, closing);
  const listed = await f.owner.fetch(new Request("https://v2.internal/devices", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  const entries = await listed.json() as Array<{ device_id: string; status: string }>;
  assert.equal(entries.find(x => x.device_id === f.a)?.status, "offline");
  assert.equal(entries.find(x => x.device_id === f.b)?.status, "online");
});
