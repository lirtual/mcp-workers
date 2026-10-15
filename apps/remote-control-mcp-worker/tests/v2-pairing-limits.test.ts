import assert from "node:assert/strict";
import test from "node:test";
import { newEnrollment } from "../../remote-control-agent/src/v2-enrollment.ts";
import { lookupPending, registerPending } from "../src/v2-pairing.ts";

// Same transaction/storage contract as SQLite-backed DO's async KV API.
interface StorageMock {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; limit: number }): Promise<Map<string, T>>;
  transaction<T>(fn: (storage: StorageMock) => Promise<T>): Promise<T>;
}
function inMemoryStorage() {
  const records = new Map<string, unknown>();
  const api: StorageMock = {
    async get<T>(key: string): Promise<T | undefined> { return records.get(key) as T | undefined; },
    async put(key: string, value: unknown): Promise<void> { records.set(key, value); },
    async delete(key: string): Promise<boolean> { return records.delete(key); },
    async list<T>({ prefix, limit }: { prefix: string; limit: number }): Promise<Map<string, T>> {
      return new Map([...records].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
    async transaction<T>(fn: (storage: StorageMock) => Promise<T>): Promise<T> { return fn(api); },
  };
  return { api, records };
}

test("registration throttles invalid requests before expensive Ed25519 verification and fails closed", async () => {
  const { api, records } = inMemoryStorage();
  for (let i = 0; i < 12; i++) {
    assert.equal((await registerPending(api as never, { invalid: true })).status, 400);
  }
  assert.equal((await registerPending(api as never, { invalid: true })).status, 429);
  const valid = newEnrollment("safe-linux").request;
  assert.equal((await registerPending(api as never, valid)).status, 429);
  assert.equal([...records.keys()].filter((key) => key.startsWith("pending:")).length, 0);
  // Elapse server-side rate window without sleeping.
  const budget = records.get("budget:register") as { reset_at: number; count: number };
  records.set("budget:register", { ...budget, reset_at: Date.now() - 1 });
  assert.equal((await registerPending(api as never, valid)).status, 202);
});

test("authenticated lookup of unknown code is bounded, without exposing stored verifier or key", async () => {
  const { api, records } = inMemoryStorage();
  const device = newEnrollment("laptop").request;
  assert.equal((await registerPending(api as never, device)).status, 202);
  for (let i = 0; i < 30; i++) {
    assert.equal((await lookupPending(api as never, "f".repeat(64))).status, 404);
  }
  assert.equal((await lookupPending(api as never, device.code_verifier)).status, 429);
  const limit = records.get("budget:lookup") as { reset_at: number; count: number };
  records.set("budget:lookup", { ...limit, reset_at: Date.now() - 1 });
  const value = await lookupPending(api as never, device.code_verifier);
  assert.equal(value.status, 200);
  assert.equal(JSON.stringify(value.body).includes(device.code_verifier), false);
  assert.equal(JSON.stringify(value.body).includes(device.public_key), false);
  assert.equal((value.body as { name: string }).name, "laptop");
});

test("fresh pending request cannot exhaust active slots forever after expiry", async () => {
  const { api, records } = inMemoryStorage();
  // Make a fresh pending record, force expiry, then ensure a second enrolment removes it.
  const first = newEnrollment("one").request;
  assert.equal((await registerPending(api as never, first)).status, 202);
  const pending = records.get("pending:" + first.code_verifier) as { expires_at: number };
  records.set("pending:" + first.code_verifier, { ...pending, expires_at: Date.now() - 1 });
  assert.equal((await registerPending(api as never, newEnrollment("two").request)).status, 202);
  assert.equal(records.has("pending:" + first.code_verifier), false);
});


test("expired same-code verifier may be re-enrolled but active duplicate is refused", async () => {
  const { api, records } = inMemoryStorage();
  const request = newEnrollment("replace-expired").request;
  assert.equal((await registerPending(api as never, request)).status, 202);
  assert.equal((await registerPending(api as never, request)).status, 409);
  const key = "pending:" + request.code_verifier;
  records.set(key, { ...(records.get(key) as object), expires_at: Date.now() - 1 });
  const newer = (await registerPending(api as never, request));
  assert.equal(newer.status, 202);
  assert.ok((records.get(key) as { expires_at: number }).expires_at > Date.now());
  assert.equal([...records.keys()].filter(k => k.startsWith("pending:")).length, 1);
});
