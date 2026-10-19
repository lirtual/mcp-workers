import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";
import { issueSessionChallenge, handleIdleSocketMessage, type V2Device } from "../src/v2-session.ts";

type Row = V2Device | string | object;
interface StorageFixture {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: Row): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; limit: number }): Promise<Map<string, T>>;
  transaction<T>(fn: (storage: StorageFixture) => Promise<T>): Promise<T>;
}
function setup() {
  const a = randomUUID(), b = randomUUID();
  const entries = new Map<string, Row>();
  const device = (id: string, label: string) => ({
    device_id: id, name: label, public_key: "key-" + id,
    fingerprint: "c".repeat(24), approved_at: Date.now(), revoked: false,
  });
  entries.set("device:" + a, device(a, "home"));
  entries.set("device:" + b, device(b, "work"));
  entries.set("session:epoch:" + a, "epoch-a");
  entries.set("session:epoch:" + b, "epoch-b");
  entries.set("session:nonce:" + a, { nonce: "n".repeat(24), expires_at: Date.now() + 60_000 });
  const storage: StorageFixture = {
    get: async <T>(key: string) => entries.get(key) as T | undefined,
    put: async (key: string, value: Row) => { entries.set(key, value); },
    delete: async (key: string) => entries.delete(key),
    list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
      new Map([...entries].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
    transaction: async <T>(fn: (tx: typeof storage) => Promise<T>) => fn(storage),
  };
  const closes = new Map<string, Array<{ code: number; reason: string }>>();
  const socket = (device_id: string, epoch: string) => ({
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id, epoch, last_auth_check_at: Date.now() - 60_000 }),
    serializeAttachment() { /* mock Hibernation checkpoint */ },
    close(code: number, reason: string) {
      closes.set(device_id, [...(closes.get(device_id) ?? []), { code, reason }]);
    },
    send() { throw new Error("no request dispatch expected"); },
  } as unknown as WebSocket);
  const aSocket = socket(a, "epoch-a"), bSocket = socket(b, "epoch-b");
  const sockets = new Map([["device:" + a, [aSocket]], ["device:" + b, [bSocket]]]);
  const state = {
    storage,
    getWebSockets: (tag: string) => sockets.get(tag) ?? [],
  } as unknown as DurableObjectState;
  const owner = new V2OwnerCoordinator(state);
  let doCalls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "my-portal",
    REMOTE_CONTROL_DEVICE_TOKEN: "v1-test-only",
    V2_OWNER: {
      idFromName: () => "owner",
      get: () => ({ fetch(input: RequestInfo | URL, init?: RequestInit) {
        doCalls++;
        return owner.fetch(input instanceof Request ? input : new Request(input, init));
      } }),
    },
  } as unknown as Env;
  const call = async (name: string, args: unknown, token = "my-portal") => {
    const response = await worker.fetch(new Request("https://mcp.test/mcp", {
      method: "POST", headers: { "authorization": "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
    }), env);
    return { status: response.status, json: await response.json() as {
      result: { content: Array<{ text: string }>; isError: boolean };
    } };
  };
  return { a, b, entries, storage, socket, sockets, aSocket, bSocket, state, owner, closes, call, get doCalls() { return doCalls; } };
}

test("Portal-only revoke deletes grant before closing A, preserves B, and is repeatable after DO rehydrate", async () => {
  const f = setup();
  const rejected = await f.call("revoke_device", { device_id: f.a }, "not-owner");
  assert.equal(rejected.status, 401);
  assert.equal(f.doCalls, 0);
  const malformed = await f.call("revoke_device", { device_id: "../a" });
  assert.equal(malformed.json.result.isError, true);
  assert.equal(f.doCalls, 0);
  const extra = await f.call("revoke_device", { device_id: f.a, confirm: false });
  assert.equal(extra.json.result.isError, true);
  assert.equal(f.doCalls, 0);
  const unknown = await f.call("revoke_device", { device_id: randomUUID() });
  assert.equal(unknown.json.result.isError, true);

  const revoke = await f.call("revoke_device", { device_id: f.a });
  assert.equal(revoke.json.result.isError, false);
  const body = JSON.parse(revoke.json.result.content[0]!.text) as {
    device_id: string; status: string; process_cleanup: string;
  };
  assert.equal(body.device_id, f.a);
  assert.equal(body.status, "revoked");
  assert.equal(body.process_cleanup, "unconfirmed", "missing Agent cleanup reply must never claim a process stopped");
  assert.equal(f.entries.has("device:" + f.a), false);
  assert.equal(f.entries.has("session:nonce:" + f.a), false);
  assert.equal(f.entries.has("session:epoch:" + f.a), false);
  assert.deepEqual(f.closes.get(f.a), [{ code: 1008, reason: "revoked" }]);
  assert.equal(f.closes.has(f.b), false);
  assert.equal((f.entries.get("device:" + f.b) as V2Device).revoked, false);

  // Deletion survives reconstruction; challenge is denied and old socket
  // application messages cannot pass the ordinary persisted policy guard.
  const rehydrated = new V2OwnerCoordinator(f.state);
  const login = await issueSessionChallenge(f.storage as never, { device_id: f.a });
  assert.equal(login.status, 404);
  const surviving = await issueSessionChallenge(f.storage as never, { device_id: f.b });
  assert.equal(surviving.status, 200);
  await handleIdleSocketMessage(f.state, f.aSocket, "rc-v2:auth:" + "d".repeat(32));
  assert.deepEqual(f.closes.get(f.a)?.at(-1), { code: 1008, reason: "revoked" });
  const list = await rehydrated.fetch(new Request("https://v2.internal/devices", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  const devices = await list.json() as Array<{ device_id: string; status: string }>;
  assert.equal(devices.some(d => d.device_id === f.a), false);
  assert.equal(devices.find(d => d.device_id === f.b)?.status, "online");
  const repeated = await f.call("revoke_device", { device_id: f.a });
  assert.equal(repeated.json.result.isError, true);
});

test("revoking an offline device deletes the grant without claiming to stop a process", async () => {
  const f = setup();
  f.sockets.set("device:" + f.a, []);
  const result = await f.call("revoke_device", { device_id: f.a });
  assert.deepEqual(JSON.parse(result.json.result.content[0]!.text), {
    device_id: f.a, status: "revoked", process_cleanup: "offline",
  });
  assert.equal(f.closes.has(f.a), false);
});

test("DO storage failure refuses to close a socket or claim revocation", async () => {
  const f = setup();
  // Prevent committing the deletion. All cleanup side effects must happen later.
  const fail = new V2OwnerCoordinator({
    storage: { transaction: async () => { throw new Error("backend unavailable"); } },
    getWebSockets: () => [f.aSocket],
  } as unknown as DurableObjectState);
  const response = await fail.fetch(new Request("https://v2.internal/revoke", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: f.a }),
  }));
  assert.equal(response.status, 503);
  assert.equal(f.closes.has(f.a), false);
});

test("revocation cancels an in-flight A request before closing A, without cancelling B", async () => {
  const f = setup();
  const pendingIds = new Map<string, string>();
  let seenA!: () => void, seenB!: () => void;
  const startedA = new Promise<void>(resolve => { seenA = resolve; });
  const startedB = new Promise<void>(resolve => { seenB = resolve; });
  const buildSocket = (id: string, epoch: string, notify: () => void) => ({
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: id, epoch }),
    send(frame: string) {
      pendingIds.set(id, (JSON.parse(frame) as { request_id: string }).request_id);
      notify();
    },
    close() { /* intentionally do not alter readyState: revocation must rely on tombstone */ },
  } as unknown as WebSocket);
  const aSocket = buildSocket(f.a, "epoch-a", seenA);
  const bSocket = buildSocket(f.b, "epoch-b", seenB);
  f.sockets.set("device:" + f.a, [aSocket]);
  f.sockets.set("device:" + f.b, [bSocket]);
  const read = (device_id: string) => f.owner.fetch(new Request("https://v2.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id, tool: "read_file", arguments: { path: "/tmp/file" } }),
  }));
  const aPending = read(f.a), bPending = read(f.b);
  await Promise.all([startedA, startedB]);
  const revoke = await f.owner.fetch(new Request("https://v2.internal/revoke", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: f.a }),
  }));
  assert.equal(revoke.status, 200);
  assert.equal((await aPending).status, 503);
  await f.owner.webSocketMessage(bSocket, JSON.stringify({
    kind: "read_result", request_id: pendingIds.get(f.b), status: "completed", text: "still-works",
  }));
  assert.deepEqual(await (await bPending).json(), { status: "completed", text: "still-works" });
  // Even if the transport close hangs and readyState looks OPEN, a new A
  // request is denied by the missing durable grant.
  assert.equal((await read(f.a)).status, 503);
  assert.equal(pendingIds.has(f.a), true);
});

test("confirmed cleanup ACK requires deleted grant and exact active-epoch socket", async () => {
  const f = setup();
  let checkedTombstone = false;
  const matching = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: f.a, epoch: "epoch-a" }),
    send(frame: string) {
      const msg = JSON.parse(frame) as { kind: string; request_id: string };
      assert.equal(msg.kind, "revoke_cleanup");
      checkedTombstone = !f.entries.has("device:" + f.a) &&
        !f.entries.has("session:epoch:" + f.a);
      queueMicrotask(() => { void f.owner.webSocketMessage(matching as unknown as WebSocket,
        JSON.stringify({ kind: "revoke_cleanup_result", request_id: msg.request_id, status: "confirmed" })); });
    },
    close(code: number, reason: string) {
      f.closes.set(f.a, [{ code, reason }]);
    },
  } as unknown as WebSocket;
  f.sockets.set("device:" + f.a, [matching]);
  const res = await f.call("revoke_device", { device_id: f.a });
  assert.equal(res.json.result.isError, false);
  assert.equal(checkedTombstone, true);
  assert.equal(JSON.parse(res.json.result.content[0]!.text).process_cleanup, "confirmed");
  assert.deepEqual(f.closes.get(f.a), [{ code: 1008, reason: "revoked" }]);
  assert.equal(f.closes.has(f.b), false);
});

test("stale-epoch socket may not receive the privileged cleanup frame", async () => {
  const f = setup();
  let messages = 0;
  const stale = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: f.a, epoch: "stale-epoch" }),
    send() { messages++; },
    close() { /* revoked */ },
  } as unknown as WebSocket;
  f.sockets.set("device:" + f.a, [stale]);
  const res = await f.call("revoke_device", { device_id: f.a });
  assert.equal(JSON.parse(res.json.result.content[0]!.text).process_cleanup, "unconfirmed");
  assert.equal(messages, 0);
});

test("device B cannot forge device A's cleanup confirmation", async () => {
  const f = setup();
  let forged = false;
  const target = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: f.a, epoch: "epoch-a" }),
    send(frame: string) {
      const requestId = (JSON.parse(frame) as { request_id: string }).request_id;
      queueMicrotask(async () => {
        await f.owner.webSocketMessage(f.bSocket, JSON.stringify({
          kind: "revoke_cleanup_result", request_id: requestId, status: "confirmed",
        }));
        forged = true;
        await f.owner.webSocketMessage(target as unknown as WebSocket, JSON.stringify({
          kind: "revoke_cleanup_result", request_id: requestId, status: "uncertain",
        }));
      });
    },
    close() { /* revoked */ },
  } as unknown as WebSocket;
  f.sockets.set("device:" + f.a, [target]);
  const r = await f.call("revoke_device", { device_id: f.a });
  assert.equal(forged, true);
  assert.equal(JSON.parse(r.json.result.content[0]!.text).process_cleanup, "unconfirmed");
});
