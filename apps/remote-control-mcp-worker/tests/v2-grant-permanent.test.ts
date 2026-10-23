import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import worker, {V2OwnerCoordinator} from "../src/worker.ts";
import {deviceIsAuthorized, issueSessionChallenge, TEMPORARY_GRANT_MS, type V2Device} from "../src/v2-session.ts";

function fixture() {
  const temporary = randomUUID(), unrelated = randomUUID(), permanent = randomUUID(), revoked = randomUUID();
  const fingerprint = "d".repeat(24);
  const approvedAt = Date.now() - 60_000;
  const expiresAt = approvedAt + TEMPORARY_GRANT_MS;
  const rows = new Map<string, unknown>();
  const record = (id: string, type: "temporary" | "permanent", fp = "c".repeat(24)): V2Device => ({
    device_id: id, name: id === temporary ? "Windows" : "Other",
    public_key: "key-" + id, fingerprint: fp, approved_at: approvedAt, revoked: false,
    grant_type: type, ...(type === "temporary" ? {expires_at: expiresAt} : {}),
  });
  rows.set("device:" + temporary, record(temporary, "temporary", fingerprint));
  rows.set("device:" + unrelated, record(unrelated, "temporary"));
  rows.set("device:" + permanent, record(permanent, "permanent"));
  rows.set("device:" + revoked, {...record(revoked, "temporary"), revoked: true});
  rows.set("session:epoch:" + temporary, "original-epoch");
  rows.set("session:nonce:" + temporary, {nonce: "n".repeat(24), expires_at: Date.now() + 30_000});

  type Storage = {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list<T>(args: {prefix: string; limit: number}): Promise<Map<string, T>>;
    transaction<T>(fn: (txn: Storage) => Promise<T>): Promise<T>;
  };
  let tail: Promise<void> = Promise.resolve();
  const storage: Storage = {
    async get<T>(key) {return rows.get(key) as T | undefined;},
    async put(key, value) {rows.set(key, value);},
    async delete(key) {return rows.delete(key);},
    async list<T>({prefix, limit}) {
      return new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
    async transaction<T>(fn) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => {release = resolve;});
      await previous;
      try {return await fn(storage);} finally {release();}
    },
  };
  const owner = new V2OwnerCoordinator({storage, getWebSockets: () => []} as unknown as DurableObjectState);
  let forwarded = 0;
  const env = {
    MCP_ACCESS_TOKEN: "owner-only",
    DEVICE_COORDINATOR: {
      idFromName: () => "single-owner-v2",
      get: () => ({fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        forwarded++;
        return owner.fetch(input instanceof Request ? input : new Request(input, init));
      }}),
    },
  } as unknown as Env;
  async function rpc(name: string, args: unknown, token = "owner-only") {
    const response = await worker.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {"content-type": "application/json", authorization: "Bearer " + token},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name, arguments: args}}),
    }), env);
    const json = await response.json() as {result?: {isError: boolean; content: Array<{text: string}>}};
    const raw = json.result?.content?.[0]?.text || "{}";
    let data: Record<string, unknown>;
    try {data = JSON.parse(raw) as Record<string, unknown>;} catch {data = {};}
    return {status: response.status, isError: json.result?.isError, data};
  }
  function input() {
    return {
      device_id: temporary, expected_fingerprint: fingerprint,
      expected_expires_at: expiresAt, confirmation: "make_permanent",
    };
  }
  return {
    temporary, unrelated, permanent, revoked, fingerprint, approvedAt, expiresAt,
    rows, storage, owner, env, rpc, input, get forwarded() {return forwarded;},
  };
}

test("owner must review one live temporary grant; invalid calls cannot reach the coordinator", async () => {
  const f = fixture(), before = structuredClone(f.rows.get("device:" + f.temporary));
  assert.equal((await f.rpc("device_make_permanent", f.input(), "not-owner")).status, 401);
  assert.equal(f.forwarded, 0);
  for (const invalid of [
    {device_id: f.temporary}, // missing consent and review fields
    {...f.input(), device_id: f.temporary.slice(0, 8)},
    {...f.input(), device_id: f.temporary.toUpperCase()},
    {...f.input(), expected_fingerprint: "0".repeat(24)},
    {...f.input(), expected_fingerprint: "INVALID"},
    {...f.input(), expected_expires_at: f.expiresAt + 1},
    {...f.input(), expected_expires_at: 1.1},
    {...f.input(), expected_expires_at: "tomorrow"},
    {...f.input(), confirmation: false},
    {...f.input(), confirmation: "temporary"},
    {...f.input(), unexpected: true},
  ]) {
    assert.equal((await f.rpc("device_make_permanent", invalid)).isError, true);
  }
  assert.deepEqual(f.rows.get("device:" + f.temporary), before);
  assert.equal(f.forwarded, 2, "only correctly structured but stale preconditions may reach DO");
  assert.equal((await f.rpc("device_make_permanent", {...f.input(), device_id: randomUUID()})).isError, true);
  assert.equal((await f.rpc("device_make_permanent", {...f.input(), device_id: f.revoked})).isError, true);
  assert.equal((await f.rpc("device_make_permanent", {...f.input(), device_id: f.permanent})).isError, true);
  assert.deepEqual(f.rows.get("device:" + f.temporary), before);
});

test("one owner-confirmed transaction changes grant only; key, ID, receipt and unrelated grants survive", async () => {
  const f = fixture(), prior = structuredClone(f.rows.get("device:" + f.temporary)) as V2Device;
  const unrelated = structuredClone(f.rows.get("device:" + f.unrelated));
  const listed = await f.rpc("list_devices", {});
  const entries = listed.data as unknown as Array<Record<string, unknown>>;
  const reviewed = entries.find(row => row.device_id === f.temporary)!;
  assert.equal(reviewed.grant_type, "temporary");
  assert.equal(reviewed.fingerprint, f.fingerprint);
  assert.equal(reviewed.expires_at, f.expiresAt);
  const args = {device_id: reviewed.device_id, expected_fingerprint: reviewed.fingerprint,
    expected_expires_at: reviewed.expires_at, confirmation: "make_permanent"};
  const approved = await f.rpc("device_make_permanent", args);
  assert.equal(approved.isError, false);
  assert.deepEqual(approved.data, {
    device_id: f.temporary, status: "promoted", grant_type: "permanent",
  });
  const saved = f.rows.get("device:" + f.temporary) as V2Device;
  const expected = {...prior, grant_type: "permanent"};
  delete expected.expires_at;
  assert.deepEqual(saved, expected);
  assert.equal(f.rows.get("session:epoch:" + f.temporary), "original-epoch");
  assert.deepEqual(f.rows.get("session:nonce:" + f.temporary),
    {nonce: "n".repeat(24), expires_at: prior.approved_at + 90_000});
  assert.deepEqual(f.rows.get("device:" + f.unrelated), unrelated);
  assert.equal(deviceIsAuthorized(saved, f.expiresAt + 7 * TEMPORARY_GRANT_MS), true);
  assert.equal((await issueSessionChallenge(f.storage as never, {device_id: f.temporary})).status, 200);
  const after = await f.rpc("list_devices", {});
  const updated = (after.data as unknown as Array<Record<string, unknown>>)
    .find(row => row.device_id === f.temporary)!;
  assert.equal(updated.expires_at, undefined);
  assert.equal(updated.fingerprint, undefined);
  assert.equal(updated.grant_type, undefined);
  assert.equal((await f.rpc("device_make_permanent", args)).isError, true, "no double promotion");
});

test("expired, revoked or changed grants fail closed before any write", async () => {
  const f = fixture();
  const stale = f.rows.get("device:" + f.temporary) as V2Device;
  // Stale-match rejects even when both the old and current expiries are in the future.
  stale.approved_at += 1000;
  stale.expires_at! += 1000;
  assert.equal((await f.rpc("device_make_permanent", f.input())).isError, true);
  assert.equal(stale.grant_type, "temporary");
  // A matching but expired grant cannot be upgraded or revived.
  stale.approved_at = Date.now() - TEMPORARY_GRANT_MS - 1;
  stale.expires_at = stale.approved_at + TEMPORARY_GRANT_MS;
  const expiredRequest = {...f.input(), expected_expires_at: stale.expires_at};
  assert.equal((await f.rpc("device_make_permanent", expiredRequest)).isError, true);
  assert.equal(stale.grant_type, "temporary");
  assert.equal((await issueSessionChallenge(f.storage as never, {device_id: f.temporary})).status, 404);
});

test("direct internal endpoint rejects malformed body; no public Agent pairing bypass is created", async () => {
  const f = fixture();
  for (const request of [
    new Request("https://v2.internal/grant/permanent", {method: "POST",
      headers: {"content-type": "application/json"}, body: JSON.stringify({...f.input(), confirmation: "no"})}),
    new Request("https://v2.internal/grant/permanent", {method: "POST",
      headers: {"content-type": "application/json"}, body: JSON.stringify({...f.input(), extra: true})}),
  ]) {
    const result = await f.owner.fetch(request);
    assert.equal(result.status, 400);
  }
  assert.equal((f.rows.get("device:" + f.temporary) as V2Device).grant_type, "temporary");
});
