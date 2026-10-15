import assert from "node:assert/strict";
import test from "node:test";
import { newEnrollment } from "../../remote-control-agent/src/v2-enrollment.ts";
import { signedSessionProof } from "../../remote-control-agent/src/v2-session-client.ts";
import { acceptAuthenticatedSocket, authorizeSession, authorizeSocketSession, issueSessionChallenge, readWebSocketProof } from "../src/v2-session.ts";

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


test("socket upgrade commits the new durable epoch with nonce consumption, recovery never displaces it", async () => {
  const { records, store } = testStore();
  const trusted = newEnrollment("authorized-host");
  records.set("device:" + uuid, {
    device_id: uuid, name: "authorized-host", public_key: trusted.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: false,
  });
  const first = (await issueSessionChallenge(store as never, { device_id: uuid })).body as { nonce: string };
  const proof = { device_id: uuid, nonce: first.nonce,
    proof: signedSessionProof(trusted.privateKeyPem, uuid, first.nonce).proof };
  const upgrade = await authorizeSocketSession(store as never, proof);
  assert.equal(upgrade?.device_id, uuid);
  assert.match(upgrade?.epoch ?? "", /^[a-f0-9-]{36}$/);
  assert.equal(records.get("session:epoch:" + uuid), upgrade?.epoch);
  assert.equal(records.has("session:nonce:" + uuid), false);
  assert.equal(await authorizeSocketSession(store as never, proof), null, "upgrade proof is one-use");

  const recover = (await issueSessionChallenge(store as never, { device_id: uuid })).body as { nonce: string };
  const recovery = await authorizeSession(store as never, {
    device_id: uuid, nonce: recover.nonce,
    proof: signedSessionProof(trusted.privateKeyPem, uuid, recover.nonce).proof,
  });
  assert.equal(recovery.status, 200);
  assert.equal(records.get("session:epoch:" + uuid), upgrade?.epoch,
    "recovering the same identity must not supersede an authenticated socket");

  const next = (await issueSessionChallenge(store as never, { device_id: uuid })).body as { nonce: string };
  const upgraded = await authorizeSocketSession(store as never, {
    device_id: uuid, nonce: next.nonce,
    proof: signedSessionProof(trusted.privateKeyPem, uuid, next.nonce).proof,
  });
  assert.ok(upgraded && upgraded.epoch !== upgrade?.epoch);
  assert.equal(records.get("session:epoch:" + uuid), upgraded?.epoch);
});

test("revoked device with an otherwise correct signed nonce never commits socket epoch", async () => {
  const { records, store } = testStore();
  const identity = newEnrollment("revoked-host");
  records.set("device:" + uuid, {
    device_id: uuid, name: "revoked-host", public_key: identity.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: false,
  });
  const pending = (await issueSessionChallenge(store as never, { device_id: uuid })).body as { nonce: string };
  records.set("device:" + uuid, {
    ...(records.get("device:" + uuid) as object), revoked: true,
  });
  const result = await authorizeSocketSession(store as never, {
    device_id: uuid, nonce: pending.nonce,
    proof: signedSessionProof(identity.privateKeyPem, uuid, pending.nonce).proof,
  });
  assert.equal(result, null);
  assert.equal(records.has("session:epoch:" + uuid), false);
});

test("failed Hibernation attachment setup closes an accepted WSS instead of leaking a live socket", async () => {
  const { records, store } = testStore();
  const identity = newEnrollment("attachment-failure");
  records.set("device:" + uuid, {
    device_id: uuid, name: "attachment-failure", public_key: identity.request.public_key,
    fingerprint: "0123456789abcdef01234567", approved_at: Date.now(), revoked: false,
  });
  const challenge = (await issueSessionChallenge(store as never, { device_id: uuid })).body as { nonce: string };
  const proof = signedSessionProof(identity.privateKeyPem, uuid, challenge.nonce).proof;
  const closeCalls: Array<{ code: number; reason: string }> = [];
  const server = {
    serializeAttachment: () => { throw new Error("private attachment failure"); },
    close: (code: number, reason: string) => closeCalls.push({ code, reason }),
  } as unknown as WebSocket;
  let accepted = false;
  const state = {
    getWebSockets: () => [],
    acceptWebSocket: (socket: WebSocket) => { assert.equal(socket, server); accepted = true; },
  } as unknown as DurableObjectState;
  const pairGlobal = globalThis as unknown as { WebSocketPair?: unknown };
  const previousPair = pairGlobal.WebSocketPair;
  pairGlobal.WebSocketPair = class {
    0 = {} as WebSocket;
    1 = server;
  };
  try {
    const response = await acceptAuthenticatedSocket(store as never, state, new Request(
      "https://test.invalid/ws/" + uuid,
      { headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": "rc-v2, rcv2." + challenge.nonce + "." + proof,
      } },
    ));
    assert.equal(response.status, 503, "failed socket attachment must not return an authenticated 101");
    assert.equal(accepted, true);
    assert.deepEqual(closeCalls, [{ code: 1011, reason: "authorization unavailable" }]);
    assert.equal(records.has("session:nonce:" + uuid), false, "failed upgrade proof cannot be reused");
  } finally {
    pairGlobal.WebSocketPair = previousPair;
  }
});
