import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { V2OwnerCoordinator } from "../src/worker.ts";

test("secure input request requires the current authenticated target socket and provider preflight", async () => {
  const id = randomUUID(), epoch = "target-epoch-1", rows = new Map<string, unknown>();
  rows.set("device:" + id, { device_id: id, name: "session-ubuntu", revoked: false,
    grant_type: "permanent", approved_at: Date.now(), public_key: "key",
    fingerprint: "a".repeat(24), last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 });
  rows.set("session:epoch:" + id, epoch);
  const socket = {
    readyState: WebSocket.OPEN,
    sent: [] as string[],
    deserializeAttachment: () => ({ device_id: id, epoch }),
    send(value: string) { this.sent.push(value); },
  };
  const base = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
      new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
  };
  const storage = {
    ...base,
    transaction: async <T>(fn: (tx: typeof base) => Promise<T>) => fn(base),
  };
  const owner = new V2OwnerCoordinator({
    storage, getWebSockets: (tag: string) => tag === "device:" + id ? [socket as unknown as WebSocket] : [],
  } as unknown as DurableObjectState);
  const creation = owner.fetch(new Request("https://do.internal/secure-input/request", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_user_id: "user_owner", request: {
      purpose: "Check deployment credential access", execution: { device_id: id },
      target: { kind: "github_repository_secret", repository: "lirtual/mcp-workers", name: "DEPLOY_TOKEN" },
    } }),
  }));
  await new Promise(resolve => setImmediate(resolve));
  const frame = JSON.parse(socket.sent[0]!) as { kind: string; preflight_id: string };
  assert.equal(frame.kind, "secure_input_prepare");
  await owner.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
    kind: "secure_input_prepare_result", preflight_id: frame.preflight_id, status: "ready",
    provider_principal: { provider: "github", identity: "lirtual", repository: "lirtual/mcp-workers", permission: "admin" },
  }));
  const response = await creation;
  assert.equal(response.status, 200);
  const record = await response.json() as { state: string; execution: Record<string, unknown> };
  assert.equal(record.state, "pending");
  assert.equal("epoch" in record.execution, false);
});
