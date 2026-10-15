import assert from "node:assert/strict";
import test from "node:test";
import { newEnrollment } from "../../remote-control-agent/src/v2-enrollment.ts";
import { signedSessionProof } from "../../remote-control-agent/src/v2-session-client.ts";
import { authorizeSession, issueSessionChallenge, readWebSocketProof } from "../src/v2-session.ts";

interface MockStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; limit: number }): Promise<Map<string, T>>;
  transaction<T>(fn: (store: MockStore) => Promise<T>): Promise<T>;
}
function testStore() {
  const records = new Map<string, unknown>();
  const store: MockStore = {
    async get<T>(key: string) { return records.get(key) as T | undefined; },
    async put(key, value) { records.set(key, value); },
    async delete(key) { return records.delete(key); },
    async list<T>(opts: {prefix:string;limit:number}) { return new Map([...records].filter(([k]) => k.startsWith(opts.prefix)).slice(0, opts.limit)) as Map<string, T>; },
    async transaction<T>(fn:(store:MockStore)=>Promise<T>) { return fn(store); },
  };
  return { records, store };
}
const uuid = "2126f1bd-641e-44f2-b304-b136795b3f46";

test("signed approved-key session nonce works once, not as a reusable device password", async () => {
  const { records, store } = testStore();
  const trusted = newEnrollment("host-1");
  records.set("device:" + uuid, {
    device_id: uuid, name: "host-1", public_key: trusted.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: false,
  });
  const challenge = await issueSessionChallenge(store as never, { device_id: uuid });
  assert.equal(challenge.status, 200);
  const nonce = (challenge.body as { nonce: string }).nonce;
  assert.match(nonce, /^[A-Za-z0-9_-]{24}$/);
  const good = signedSessionProof(trusted.privateKeyPem, uuid, nonce);
  assert.match(good.proof, /^[A-Za-z0-9_-]{86}$/);
  assert.equal((await authorizeSession(store as never, { device_id: uuid, nonce, proof: good.proof })).status, 200);
  assert.equal((await authorizeSession(store as never, { device_id: uuid, nonce, proof: good.proof })).status, 401);
  assert.equal((await issueSessionChallenge(store as never, { device_id: "not-uuid" })).status, 400);
  assert.equal((await issueSessionChallenge(store as never, { device_id: "00000000-0000-0000-0000-000000000000" })).status, 404);
});

test("session proof cannot be signed with another installation's key or stale/replaced nonce", async () => {
  const { records, store } = testStore();
  const trusted = newEnrollment("host-1");
  const attacker = newEnrollment("host-2");
  records.set("device:" + uuid, {
    device_id: uuid, name: "host-1", public_key: trusted.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: false,
  });
  const first = (await issueSessionChallenge(store as never, { public_key: trusted.request.public_key })).body as {
    nonce: string; device_id: string;
  };
  assert.equal(first.device_id, uuid);
  assert.equal((await authorizeSession(store as never, {
    device_id: uuid, nonce: first.nonce, proof: signedSessionProof(attacker.privateKeyPem, uuid, first.nonce).proof,
  })).status, 401);
  const second = (await issueSessionChallenge(store as never, { device_id: uuid })).body as { nonce: string };
  assert.equal((await authorizeSession(store as never, {
    device_id: uuid, nonce: first.nonce, proof: signedSessionProof(trusted.privateKeyPem, uuid, first.nonce).proof,
  })).status, 401);
  const record = records.get("session:nonce:" + uuid) as { expires_at: number };
  record.expires_at = Date.now() - 1;
  assert.equal((await authorizeSession(store as never, {
    device_id: uuid, nonce: second.nonce, proof: signedSessionProof(trusted.privateKeyPem, uuid, second.nonce).proof,
  })).status, 401);
});

test("revoked key stays rejected, and no WebSocket protocol without signed nonce is accepted", async () => {
  const { records, store } = testStore();
  const trusted = newEnrollment("host-1");
  records.set("device:" + uuid, {
    device_id: uuid, name: "host-1", public_key: trusted.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: true,
  });
  assert.equal((await issueSessionChallenge(store as never, { device_id: uuid })).status, 404);
  records.set("device:" + uuid, {
    device_id: uuid, name: "host-1", public_key: trusted.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: false,
  });
  const ch = (await issueSessionChallenge(store as never, { device_id: uuid })).body as { nonce: string };
  const proof = signedSessionProof(trusted.privateKeyPem, uuid, ch.nonce).proof;
  const request = (header: string) => new Request("https://test.invalid/ws/" + uuid, {
    headers: { "sec-websocket-protocol": header },
  });
  assert.deepEqual(readWebSocketProof(request("rc-v2, rcv2." + ch.nonce + "." + proof)), {
    device_id: uuid, nonce: ch.nonce, proof,
  });
  for (const bad of ["rc-v2", "rc-v2, unauthenticated", "rc-v2, rcv2.bad.bad", "rc-v2, rcv2." + ch.nonce + "." + proof + ", another"]) {
    assert.equal(readWebSocketProof(request(bad)), null);
  }
  records.set("device:" + uuid, {
    device_id: uuid, name: "host-1", public_key: trusted.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: true,
  });
  assert.equal((await authorizeSession(store as never, { device_id: uuid, nonce: ch.nonce, proof })).status, 401);
});
