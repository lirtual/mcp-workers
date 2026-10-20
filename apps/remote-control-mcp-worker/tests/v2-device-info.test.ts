import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { handleDeviceInfoMessage, listApprovedDevices } from "../src/v2-session.ts";

function harness() {
  const activeId = randomUUID(), otherId = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + activeId, { device_id: activeId, name: "same-host", revoked: false,
      public_key: "never-disclose", fingerprint: "f", approved_at: Date.now() }],
    ["device:" + otherId, { device_id: otherId, name: "same-host", revoked: false,
      public_key: "never-disclose", fingerprint: "f", approved_at: Date.now() }],
    ["session:epoch:" + activeId, "epoch-live"],
    ["session:epoch:" + otherId, "epoch-other"],
  ]);
  const storage = {
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async put(key: string, value: unknown) { rows.set(key, value); },
    async list<T>({ prefix, limit }: {prefix: string; limit: number}) {
      return new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
    async delete(key: string) { rows.delete(key); },
    async transaction<T>(fn: (tx: { get: (key: string) => Promise<unknown>; put: (key: string, value: unknown) => Promise<void> }) => Promise<T>) { return fn(storage); },
  };
  const makeSocket = (id: string, epoch: string) => {
    let attachment: Record<string, unknown> = { device_id: id, epoch, last_auth_check_at: Date.now() };
    return {
      readyState: Number(WebSocket.OPEN),
      closeCode: 0,
      deserializeAttachment() { return attachment; },
      serializeAttachment(value: Record<string, unknown>) { attachment = value; },
      close(code: number) { this.closeCode = code; this.readyState = WebSocket.CLOSED; },
    };
  };
  const live = makeSocket(activeId, "epoch-live");
  const sockets = new Map([["device:" + activeId, [live]]]);
  const state = {
    storage, getWebSockets: (tag: string) => sockets.get(tag) ?? [],
  } as unknown as DurableObjectState;
  return { activeId, otherId, rows, live, makeSocket, state, sockets };
}

const deviceInfo = JSON.stringify({
  kind: "device_info", hostname: "workstation", os: "windows", os_version: "10.0.26100",
  arch: "x64", environment: "native", agent_version: "v0.1.12-windows-rc.1",
  capabilities: ["read"],
});

test("signed current epoch reports minimal metadata, not credentials or an inferred grant", async () => {
  const h = harness();
  assert.equal(await handleDeviceInfoMessage(h.state, h.live as unknown as WebSocket, deviceInfo), true);
  const response = await listApprovedDevices(h.state);
  assert.equal(response.status, 200);
  const listed = response.body as Array<Record<string, any>>;
  const active = listed.find(row => row.device_id === h.activeId)!;
  const legacy = listed.find(row => row.device_id === h.otherId)!;
  assert.equal(active.status, "online");
  assert.equal(active.device_info.hostname, "workstation");
  assert.equal(active.device_info.os, "windows");
  assert.deepEqual(active.capabilities, ["read"]);
  assert.ok(Number.isSafeInteger(active.last_seen));
  assert.ok(active.display_name.includes("windows/native"));
  assert.equal(active.name_ambiguous, true);
  assert.equal(legacy.status, "offline");
  assert.equal(legacy.capabilities, undefined);
  assert.match(legacy.display_name, new RegExp(h.otherId.slice(0, 8)));
  assert.equal(JSON.stringify(listed).includes("never-disclose"), false);
  // New authenticated epoch must not claim previous Agent's capabilities.
  h.rows.set("session:epoch:" + h.activeId, "epoch-new");
  h.sockets.set("device:" + h.activeId, [h.makeSocket(h.activeId, "epoch-new")]);
  const afterReconnect = (await listApprovedDevices(h.state)).body as Array<Record<string, any>>;
  const refreshed = afterReconnect.find(row => row.device_id === h.activeId)!;
  assert.equal(refreshed.status, "online");
  assert.equal(refreshed.capabilities, undefined);
  // Cannot overwrite the same epoch's identity facts repeatedly.
  assert.equal(await handleDeviceInfoMessage(h.state, h.live as unknown as WebSocket, deviceInfo), true);
  assert.equal(h.live.closeCode, 1008);
});

test("stale, revoked, malformed or oversized device info is rejected without changing a grant", async () => {
  const h = harness();
  const old = h.makeSocket(h.activeId, "stale-epoch");
  assert.equal(await handleDeviceInfoMessage(h.state, old as unknown as WebSocket, deviceInfo), true);
  assert.equal(old.closeCode, 1008);
  assert.equal((h.rows.get("device:" + h.activeId) as {device_info?: unknown}).device_info, undefined);
  const corrupt = h.makeSocket(h.activeId, "epoch-live");
  assert.equal(await handleDeviceInfoMessage(h.state, corrupt as unknown as WebSocket,
    deviceInfo.replace('"read"', '"unrestricted"')), true);
  assert.equal(corrupt.closeCode, 1008);
  const huge = h.makeSocket(h.activeId, "epoch-live");
  assert.equal(await handleDeviceInfoMessage(h.state, huge as unknown as WebSocket,
    deviceInfo + "x".repeat(1200)), true);
  assert.equal(huge.closeCode, 1008);
  h.rows.set("device:" + h.activeId, { ...(h.rows.get("device:" + h.activeId) as object), revoked: true });
  const revoked = h.makeSocket(h.activeId, "epoch-live");
  assert.equal(await handleDeviceInfoMessage(h.state, revoked as unknown as WebSocket, deviceInfo), true);
  assert.equal(revoked.closeCode, 1008);
  assert.equal((h.rows.get("device:" + h.activeId) as {device_info?: unknown}).device_info, undefined);
});
