import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

test("list_devices requires Portal bearer and reports only current, approved WSS devices", async () => {
  const onlineId = randomUUID(), staleId = randomUUID(), offlineId = randomUUID(), revokedId = randomUUID();
  const rows = new Map<string, unknown>();
  for (const [id, name, revoked] of [
    [onlineId, "home", false], [staleId, "stale", false],
    [offlineId, "office", false], [revokedId, "retired", true],
  ] as const) {
    rows.set("device:" + id, {
      device_id: id, name, revoked, public_key: "private-public-key",
      fingerprint: "f".repeat(24), approved_at: Date.now(),
    });
  }
  rows.set("session:epoch:" + onlineId, "new-epoch");
  rows.set("session:epoch:" + staleId, "new-epoch");
  const socket = (id: string, epoch: string): WebSocket => ({
    readyState: WebSocket.OPEN,
    deserializeAttachment() { return { device_id: id, epoch }; },
  }) as unknown as WebSocket;
  const sockets = new Map([
    ["device:" + onlineId, [socket(onlineId, "old-epoch"), socket(onlineId, "new-epoch")]],
    ["device:" + staleId, [socket(staleId, "old-epoch")]],
    ["device:" + revokedId, [socket(revokedId, "any")]],
  ]);
  let deviceReads = 0;
  const storage = {
    async get<T>(key: string) { deviceReads++; return rows.get(key) as T | undefined; },
    async list<T>({ prefix, limit }: { prefix: string; limit: number }) {
      return new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
  };
  const state = {
    storage,
    getWebSockets: (tag: string) => sockets.get(tag) ?? [],
  } as unknown as DurableObjectState;
  const owner = new V2OwnerCoordinator(state);
  let forwarded = 0;
  const V2_OWNER = {
    idFromName() { return "single-owner"; },
    get() {
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          forwarded++;
          return owner.fetch(input instanceof Request ? input : new Request(input, init));
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "owner-only",
    REMOTE_CONTROL_DEVICE_TOKEN: "v1-only",
    V2_OWNER,
  } as Env & { V2_OWNER: DurableObjectNamespace };
  const rpc = (name: string, args: unknown = {}, token = "owner-only") => worker.fetch(
    new Request("https://host.test/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: args } }),
    }), env,
  );
  assert.equal((await rpc("list_devices", {}, "incorrect")).status, 401);
  assert.equal(forwarded, 0);
  const listed = await rpc("list_devices");
  assert.equal(listed.status, 200);
  const payload = await listed.json() as { result: { content: Array<{ text: string }> } };
  const devices = JSON.parse(payload.result.content[0]!.text) as Array<{
    device_id: string; name: string; status: string;
  }>;
  assert.deepEqual(devices, [
    { device_id: onlineId, name: "home", status: "online" },
    { device_id: staleId, name: "stale", status: "offline" },
    { device_id: offlineId, name: "office", status: "offline" },
    { device_id: revokedId, name: "retired", status: "revoked" },
  ].sort((a, b) => a.device_id.localeCompare(b.device_id)));
  assert.equal(payload.result.content[0]!.text.includes("private-public-key"), false);
  assert.equal(devices.some(d => d.device_id === revokedId && d.status === "online"), false);
  assert.equal(forwarded, 1);
  const before = deviceReads;
  const bad = await rpc("list_devices", { device_id: onlineId });
  assert.equal((await bad.json() as {result:{isError:boolean}}).result.isError, true);
  assert.equal(deviceReads, before, "unexpected list arguments must be rejected before any DO I/O");

  const tools = await worker.fetch(new Request("https://host.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner-only" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
  }), env);
  assert.equal((await tools.json() as {result:{tools:Array<{name:string}>}}).result.tools.some(t=>t.name==="list_devices"),true);
});

test("device enumeration is bounded and fails closed when the small-owner limit is exceeded", async () => {
  const rows = new Map<string, unknown>();
  for (let i = 0; i < 65; i++) {
    const id = `12345678-1234-4123-8123-${i.toString(16).padStart(12, "0")}`;
    rows.set("device:" + id, {
      device_id: id, name: "test-device", revoked: false, public_key: "unavailable",
    });
  }
  const owner = new V2OwnerCoordinator({
    storage: {
      list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
        new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
    },
    getWebSockets: () => { assert.fail("Over-capacity listing must not inspect sockets"); },
  } as unknown as DurableObjectState);
  const result = await owner.fetch(new Request("https://v2.internal/devices", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "capacity" });
});

test("device status fails closed for corrupt Hibernation attachment", async () => {
  const id = randomUUID();
  const owner = new V2OwnerCoordinator({
    storage: {
      list: async () => new Map([["device:" + id, {
        device_id: id, name: "damaged", revoked: false,
      }]]),
      get: async () => "fresh",
    },
    getWebSockets: () => [{
      deserializeAttachment: () => { throw new Error("attachment unavailable"); },
    }],
  } as unknown as DurableObjectState);
  const response = await owner.fetch(new Request("https://v2.internal/devices", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ device_id: id, name: "damaged", status: "offline" }]);
});
