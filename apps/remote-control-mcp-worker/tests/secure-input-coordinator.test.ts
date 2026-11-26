import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DeviceCoordinator } from "../src/worker.ts";

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
  const owner = new DeviceCoordinator({
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

test("secure task input requires the same live Workflow physical Attempt at creation and dispatch", async () => {
  const id = randomUUID(), attempt = randomUUID(), epoch = "session-epoch", rows = new Map<string, unknown>();
  const expires = Date.now() + 60_000;
  rows.set("device:" + id, { device_id: id, name: "session-ubuntu", revoked: false,
    grant_type: "session", approved_at: Date.now(), public_key: "key",
    fingerprint: "a".repeat(24), session_attempt_id: attempt, session_run_id: 123,
    session_run_attempt: 1, session_workflow_name: "ubuntu", expires_at: expires });
  rows.set("session:epoch:" + id, epoch);
  const decision = { allowed: true, attempt_id: attempt, github_run_id: 123,
    github_run_attempt: 1, workflow_name: "ubuntu", expires_at: expires };
  let currentDecision: unknown = decision;
  let authorizationCalls = 0;
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: id, epoch }),
    send(value: string) { sent.push(value); },
  } as unknown as WebSocket;
  const base = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
      new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
  };
  const storage = { ...base, transaction: async <T>(fn: (tx: typeof base) => Promise<T>) => fn(base) };
  const owner = new DeviceCoordinator({
    storage, getWebSockets: (tag: string) => tag === "device:" + id ? [socket] : [],
  } as unknown as DurableObjectState, { WORKFLOW_SESSION_AUTHORIZATION: {
    async authorizeSessionAttempt(input) {
      authorizationCalls++;
      assert.deepEqual(input, { attempt_id: attempt });
      return currentDecision;
    },
  } });
  const post = (route: string, data: object) => owner.fetch(new Request("https://do.internal/secure-input/" + route, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_user_id: "user_owner", ...data }),
  }));
  const request = { purpose: "Synthetic task input", execution: { device_id: id }, is_production: false,
    target: { kind: "task_process", session_id: randomUUID(), name: "SYNTHETIC_MARKER" } };
  const create = async () => {
    const pending = post("request", { request });
    await new Promise(resolve => setImmediate(resolve));
    const frame = JSON.parse(sent.at(-1)!);
    assert.equal(frame.kind, "secure_input_prepare");
    await owner.webSocketMessage(socket, JSON.stringify({
      kind: "secure_input_prepare_result", preflight_id: frame.preflight_id, status: "ready",
    }));
    const response = await pending;
    assert.equal(response.status, 200);
    const record = await response.json() as { request_id: string; execution: Record<string, unknown> };
    assert.equal(record.execution.session_attempt_id, attempt);
    assert.equal(record.execution.session_run_id, 123);
    assert.equal(record.execution.session_run_attempt, 1);
    return record.request_id;
  };
  const dispatchCount = () => sent.filter(frame => JSON.parse(frame).kind === "secure_input").length;
  const submit = (request_id: string) => post("submit", {
    request_id, secret: "synthetic-test-marker", target_confirmed: true, production_authorized: false,
  });
  for (const change of [{ allowed: false }, { github_run_id: 124 }, { github_run_attempt: 2 },
      { attempt_id: randomUUID() }, { expires_at: expires + 1000 }]) {
    currentDecision = decision;
    const requestId = await create();
    const priorCalls = authorizationCalls;
    currentDecision = { ...decision, ...change };
    assert.equal((await submit(requestId)).status, 503);
    assert.ok(authorizationCalls > priorCalls, "dispatch must ask Workflow again");
    assert.equal(dispatchCount(), 0, "invalid physical Attempt must not receive any input");
  }
  currentDecision = { ...decision, allowed: false };
  const priorFrames = sent.length;
  assert.equal((await post("request", { request })).status, 503);
  assert.equal(sent.length, priorFrames);
  currentDecision = decision;
  const requestId = await create();
  assert.equal((await submit(requestId)).status, 200);
  assert.equal(dispatchCount(), 1);
  const dispatched = JSON.parse(sent.at(-1)!);
  assert.equal(dispatched.provider_principal, null, "task submit must include the explicit null principal required by the Agent");
  await owner.webSocketMessage(socket, JSON.stringify({ kind: "secure_input_ack", request_id: requestId, status: "accepted" }));
  await owner.webSocketMessage(socket, JSON.stringify({ kind: "secure_input_progress", request_id: requestId, status: "running" }));
  await owner.webSocketMessage(socket, JSON.stringify({ kind: "secure_input_result", request_id: requestId, status: "succeeded" }));
  assert.equal((await (await post("status", {request_id: requestId})).json() as {state: string}).state, "succeeded");
  assert.equal((await submit(requestId)).status, 409);
  assert.equal(dispatchCount(), 1, "consumed request cannot send twice");
});
