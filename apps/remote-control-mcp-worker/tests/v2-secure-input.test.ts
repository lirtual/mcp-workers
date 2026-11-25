import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  cancelSecureInputRecord, consumeSecureInputRecord, createSecureInputRecord,
  getSecureInputRecord, parseSecureInputRequest, pruneSecureInputRecords, secureInputTargetBinding,
  startSecureInputDispatch, updateSecureInputStatus, validateSecureInputSecret, type SecureInputRecord,
} from "../src/v2-secure-input.ts";

const MINUTE = 60_000;
const confirmed = { target_confirmed: true, production_authorized: true } as const;
function makeStore() {
  const rows = new Map<string, unknown>();
  let tail = Promise.resolve();
  const base = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)); },
    delete: async (key: string) => rows.delete(key),
    list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
      new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
  };
  return {
    ...base, rows,
    transaction: async <T>(fn: (tx: typeof base) => Promise<T>) => {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { return await fn(base); } finally { release(); }
    },
  };
}
const deviceId = randomUUID();
const execution = { device_id: deviceId, epoch: "current-epoch", grant_type: "permanent" as const };
function githubInput(overrides: Record<string, unknown> = {}) {
  return {
    purpose: "Configure the test deployment credential",
    execution: { device_id: deviceId },
    target: { kind: "github_environment_secret", repository: "lirtual/mcp-workers",
      environment: "staging", name: "DEPLOY_TOKEN" },
    ...overrides,
  };
}
async function createPending(store: ReturnType<typeof makeStore>, now = 1_800_000_000_000) {
  const parsed = parseSecureInputRequest(githubInput());
  assert.ok(parsed);
  return createSecureInputRecord(store as never, parsed, "owner_user_1", execution, {
    provider: "github", identity: "lirtual", repository: "lirtual/mcp-workers", permission: "admin",
  }, now);
}

test("request parser accepts only exact supported targets and bounded metadata", () => {
  const parsed = parseSecureInputRequest(githubInput());
  assert.ok(parsed);
  assert.equal(parsed.target.kind, "github_environment_secret");
  assert.equal(parsed.target.name, "DEPLOY_TOKEN");
  assert.equal(parsed.execution.device_id, deviceId);
  assert.equal(parseSecureInputRequest(githubInput({ unexpected: "field" })), null);
  assert.equal(parseSecureInputRequest(githubInput({ purpose: "\nsecret" })), null);
  assert.equal(parseSecureInputRequest(githubInput({ execution: { device_id: "not-a-uuid" } })), null);
  assert.equal(parseSecureInputRequest(githubInput({ target: { ...githubInput().target, repository: "owner/../repo" } })), null);
  assert.equal(parseSecureInputRequest(githubInput({ target: { ...githubInput().target, name: "bad-name" } })), null);
  assert.equal(parseSecureInputRequest(githubInput({ target: { ...githubInput().target, extra: true } })), null);
});

test("request metadata binds target and execution epoch without storing credential material", async () => {
  const store = makeStore(), now = 1_800_000_000_000;
  const record = await createPending(store, now);
  assert.equal(record.state, "pending");
  assert.equal(record.owner_user_id, "owner_user_1");
  assert.equal(record.execution.epoch, "current-epoch");
  assert.equal(record.provider_principal?.identity, "lirtual");
  assert.equal(record.is_production, true);
  assert.equal(record.expires_at, now + 5 * MINUTE);
  assert.match(record.target_binding, /^[a-f0-9]{64}$/);
  assert.equal(await secureInputTargetBinding(record), record.target_binding);
  const stored = store.rows.get("secure-input:" + record.request_id) as Record<string, unknown>;
  assert.ok(stored);
  for (const key of ["secret", "secret_digest", "ciphertext"]) assert.equal(Object.hasOwn(stored, key), false);
  assert.equal(JSON.stringify(stored).includes("DEPLOY_TOKEN_VALUE"), false);
});

test("secret validation rejects empty, NUL and oversized values", () => {
  assert.equal(validateSecureInputSecret("value"), true);
  assert.equal(validateSecureInputSecret("line one\nline two"), true);
  assert.equal(validateSecureInputSecret(""), false);
  assert.equal(validateSecureInputSecret("   \n  "), false);
  assert.equal(validateSecureInputSecret("a\0b"), false);
  assert.equal(validateSecureInputSecret("x".repeat(8193)), false);
});

test("consumption is atomic and a request can be submitted only once", async () => {
  const store = makeStore(), record = await createPending(store);
  const results = await Promise.all([
    consumeSecureInputRecord(store as never, record.request_id, "owner_user_1", confirmed),
    consumeSecureInputRecord(store as never, record.request_id, "owner_user_1", confirmed),
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 1);
  const stored = store.rows.get("secure-input:" + record.request_id) as SecureInputRecord;
  assert.equal(stored.state, "unknown");
  assert.equal(typeof stored.consumed_at, "number");
  assert.equal(Object.hasOwn(stored, "secret"), false);
  const firstDispatch = await startSecureInputDispatch(store as never, record.request_id, deviceId, "current-epoch");
  assert.equal(firstDispatch.status, 200);
  assert.equal((await startSecureInputDispatch(store as never, record.request_id, deviceId, "current-epoch")).status, 409);
});

test("owner mismatch, expiry and cancellation cannot consume a request", async () => {
  const store = makeStore(), now = 1_800_000_000_000;
  const record = await createPending(store, now);
  assert.equal((await getSecureInputRecord(store as never, record.request_id, "other-owner", now)).status, 404);
  assert.equal((await consumeSecureInputRecord(store as never, record.request_id, "other-owner", confirmed, now)).status, 404);
  assert.equal((await cancelSecureInputRecord(store as never, record.request_id, "owner_user_1", now)).status, 200);
  assert.equal((await consumeSecureInputRecord(store as never, record.request_id, "owner_user_1", confirmed, now)).status, 409);

  const expired = await createPending(store, now);
  assert.equal((await consumeSecureInputRecord(store as never, expired.request_id, "owner_user_1", confirmed, expired.expires_at)).status, 410);
  assert.equal((await getSecureInputRecord(store as never, expired.request_id, "owner_user_1", expired.expires_at)).status, 200);
  assert.equal((store.rows.get("secure-input:" + expired.request_id) as SecureInputRecord).state, "expired");
});

test("Agent status updates are bound to the exact device epoch and monotonic state", async () => {
  const store = makeStore(), record = await createPending(store);
  await consumeSecureInputRecord(store as never, record.request_id, "owner_user_1", confirmed);
  await startSecureInputDispatch(store as never, record.request_id, deviceId, "current-epoch");
  assert.equal((await updateSecureInputStatus(store as never, record.request_id, randomUUID(), "current-epoch", "accepted")).status, 404);
  assert.equal((await updateSecureInputStatus(store as never, record.request_id, deviceId, "old-epoch", "accepted")).status, 404);
  assert.equal((await updateSecureInputStatus(store as never, record.request_id, deviceId, "current-epoch", "accepted")).status, 200);
  assert.equal((await updateSecureInputStatus(store as never, record.request_id, deviceId, "current-epoch", "running")).status, 200);
  assert.equal((await updateSecureInputStatus(store as never, record.request_id, deviceId, "current-epoch", "succeeded")).status, 200);
  assert.equal((await updateSecureInputStatus(store as never, record.request_id, deviceId, "current-epoch", "failed", "provider_write_failed")).status, 409);
  const stored = store.rows.get("secure-input:" + record.request_id) as SecureInputRecord;
  assert.equal(stored.state, "succeeded");
  assert.equal(stored.error_code, undefined);
});

test("stale accepted/running requests become unknown, never replayed", async () => {
  const store = makeStore(), now = 1_800_000_000_000;
  const record = await createPending(store, now);
  await consumeSecureInputRecord(store as never, record.request_id, "owner_user_1", confirmed, now);
  await startSecureInputDispatch(store as never, record.request_id, deviceId, "current-epoch", now);
  await updateSecureInputStatus(store as never, record.request_id, deviceId, "current-epoch", "accepted", undefined, now + 1);
  const result = await getSecureInputRecord(store as never, record.request_id, "owner_user_1", now + 3 * MINUTE);
  assert.equal(result.status, 200);
  assert.equal((result.body as SecureInputRecord).state, "unknown");
});


test("production delivery requires a separate explicit authorization before one-time consume", async () => {
  const store = makeStore(), record = await createPending(store);
  const denied = await consumeSecureInputRecord(store as never, record.request_id, "owner_user_1",
    { target_confirmed: true, production_authorized: false });
  assert.equal(denied.status, 403);
  assert.equal((store.rows.get("secure-input:" + record.request_id) as SecureInputRecord).state, "pending");
  const accepted = await consumeSecureInputRecord(store as never, record.request_id, "owner_user_1", confirmed);
  assert.equal(accepted.status, 200);
  assert.equal(typeof accepted.record?.production_authorized_at, "number");
});


test("the retained-record limit admits exactly 64 even under concurrent creation", async () => {
  const store = makeStore(), now = 1_800_000_000_000;
  for (let i = 0; i < 63; i++) {
    const record = await createPending(store, now);
    assert.equal((await cancelSecureInputRecord(store as never, record.request_id, "owner_user_1", now)).status, 200);
  }
  const results = await Promise.allSettled([createPending(store, now), createPending(store, now)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal(store.rows.size, 64);
  await assert.rejects(createPending(store, now), /secure_input_capacity/);
});

test("bounded pruning recovers a previously over-capacity store without deleting retained evidence", async () => {
  const store = makeStore(), now = 1_800_000_000_000;
  const record = await createPending(store, now);
  store.rows.clear();
  for (let i = 0; i < 65; i++) {
    const id = randomUUID();
    store.rows.set("secure-input:" + id, { ...record, request_id: id, task_id: id, state: "cancelled",
      expires_at: i === 0 ? now - 24 * 60 * MINUTE : now + 5 * MINUTE });
  }
  assert.equal(await pruneSecureInputRecords(store as never, now - 1), false);
  assert.equal(store.rows.size, 65);
  assert.equal(await pruneSecureInputRecords(store as never, now), true);
  assert.equal(store.rows.size, 64);
  await assert.rejects(createPending(store, now), /secure_input_capacity/);
});
