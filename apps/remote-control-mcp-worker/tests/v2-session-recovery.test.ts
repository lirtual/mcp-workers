import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { newEnrollment, saveNewPrivateKey } from "../../remote-control-agent/src/v2-enrollment.ts";
import { recoverDeviceId, signedSessionProof } from "../../remote-control-agent/src/v2-session-client.ts";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";
import { authorizeSession, issueSessionChallenge, handleIdleSocketMessage } from "../src/v2-session.ts";

interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; limit: number }): Promise<Map<string, T>>;
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T>;
}
function fixture() {
  const entries = new Map<string, unknown>();
  const storage: Store = {
    async get<T>(key: string) { return entries.get(key) as T | undefined; },
    async put(key, value) { entries.set(key, value); },
    async delete(key) { return entries.delete(key); },
    async list<T>(opts: { prefix: string; limit: number }) { return new Map([...entries].filter(([key]) => key.startsWith(opts.prefix)).slice(0, opts.limit)) as Map<string, T>; },
    async transaction<T>(fn: (s: Store) => Promise<T>) { return fn(storage); },
  };
  const owner = new V2OwnerCoordinator({ storage } as unknown as DurableObjectState);
  const env = {
    MCP_ACCESS_TOKEN: "test-owner", REMOTE_CONTROL_DEVICE_TOKEN: "unused-v1",
    V2_OWNER: {
      idFromName: () => "single-owner",
      get: () => ({ fetch: (url: RequestInfo | URL, init?: RequestInit) =>
        owner.fetch(url instanceof Request ? url : new Request(url, init)) }),
    },
  } as unknown as Env;
  const send: typeof fetch = (url, init) =>
    worker.fetch(url instanceof Request ? url : new Request(url, init), env);
  return { entries, storage, send };
}

test("lost original pairing response can recover device ID using only approved local private key", async () => {
  const { entries, send } = fixture();
  const keys = newEnrollment("approved-node");
  const id = randomUUID();
  entries.set("device:" + id, {
    device_id: id, name: "approved-node", public_key: keys.request.public_key,
    fingerprint: "f".repeat(24), approved_at: Date.now(), revoked: false,
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "spec46-lost-deviceid-"));
  const keyPath = path.join(dir, "identity.pem");
  try {
    await saveNewPrivateKey(keyPath, keys.privateKeyPem);
    const recovered = await recoverDeviceId("http://127.0.0.1:7777/", keyPath, send);
    assert.equal(recovered, id);
    assert.equal((await readFile(keyPath + ".device-id", "utf8")).trim(), id);
    assert.equal(entries.has("session:nonce:" + id), false, "signed challenge must be consumed");
    assert.equal(await recoverDeviceId("http://127.0.0.1:7777/", keyPath, send), id,
      "repeat recovery with the same approved key is safe using a fresh nonce");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("identity recovery refuses wrong key, revoked device and conflicting local identity without overwriting it", async () => {
  const { entries, send } = fixture();
  const trusted = newEnrollment("trusted");
  const other = newEnrollment("different");
  const id = randomUUID();
  entries.set("device:" + id, {
    device_id: id, name: "trusted", public_key: trusted.request.public_key,
    fingerprint: "e".repeat(24), approved_at: Date.now(), revoked: false,
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "spec46-identity-guard-"));
  try {
    const wrongKey = path.join(dir, "wrong.pem");
    await saveNewPrivateKey(wrongKey, other.privateKeyPem);
    await assert.rejects(recoverDeviceId("http://127.0.0.1:7777/", wrongKey, send), /No approved device/);
    const keyPath = path.join(dir, "trusted.pem");
    await saveNewPrivateKey(keyPath, trusted.privateKeyPem);
    await writeFile(keyPath + ".device-id", randomUUID() + "\n", { mode: 0o600 });
    await assert.rejects(recoverDeviceId("http://127.0.0.1:7777/", keyPath, send), /does not match/);
    assert.notEqual((await readFile(keyPath + ".device-id", "utf8")).trim(), id);
    entries.set("device:" + id, { ...(entries.get("device:" + id) as object), revoked: true });
    await assert.rejects(recoverDeviceId("http://127.0.0.1:7777/", keyPath, send), /No approved device/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("same signed session challenge is consumed once; a new challenge invalidates old proof", async () => {
  const { entries, storage } = fixture();
  const keys = newEnrollment("one");
  const id = randomUUID();
  entries.set("device:" + id, {
    device_id: id, name: "one", public_key: keys.request.public_key,
    fingerprint: "0".repeat(24), approved_at: Date.now(), revoked: false,
  });
  const first = (await issueSessionChallenge(storage as never, { device_id: id })).body as { nonce: string };
  const signedOld = signedSessionProof(keys.privateKeyPem, id, first.nonce).proof;
  const second = (await issueSessionChallenge(storage as never, { device_id: id })).body as { nonce: string };
  assert.equal((await authorizeSession(storage as never, {
    device_id: id, nonce: first.nonce, proof: signedOld,
  })).status, 401);
  const signedNew = signedSessionProof(keys.privateKeyPem, id, second.nonce).proof;
  assert.equal((await authorizeSession(storage as never, {
    device_id: id, nonce: second.nonce, proof: signedNew,
  })).status, 200);
  assert.equal((await authorizeSession(storage as never, {
    device_id: id, nonce: second.nonce, proof: signedNew,
  })).status, 401);
});


test("hibernation-style reconstruction checks durable epoch and forbids every remote operation", async () => {
  const { entries, storage } = fixture();
  const id = randomUUID();
  const key = newEnrollment("a").request.public_key;
  entries.set("device:" + id, {
    device_id: id, name: "a", public_key: key,
    fingerprint: "0".repeat(24), approved_at: Date.now(), revoked: false,
  });
  entries.set("session:epoch:" + id, "new-epoch");
  function socket(epoch: string) {
    const closes: Array<{ code: number; reason: string }> = [];
    const obj = {
      deserializeAttachment() { return { device_id: id, epoch }; },
      serializeAttachment(_attachment: unknown) { /* mocked Hibernation persistence */ },
      close(code: number, reason: string) { closes.push({ code, reason }); },
    } as unknown as WebSocket;
    return { obj, closes };
  }
  const state = { storage } as unknown as DurableObjectState;
  const old = socket("old-epoch");
  await handleIdleSocketMessage(state, old.obj, "rc-v2:auth:" + "a".repeat(32));
  assert.deepEqual(old.closes, [{ code: 1008, reason: "revoked" }]);
  const current = socket("new-epoch");
  await handleIdleSocketMessage(state, current.obj, JSON.stringify({ type: "execute", tool: "start_process" }));
  assert.deepEqual(current.closes, [{ code: 1008, reason: "no remote operations enabled" }]);
  const revoked = entries.get("device:" + id) as Record<string, unknown>;
  entries.set("device:" + id, { ...revoked, revoked: true });
  const afterRevoke = socket("new-epoch");
  await handleIdleSocketMessage(state, afterRevoke.obj, "rc-v2:auth:" + "b".repeat(32));
  assert.deepEqual(afterRevoke.closes, [{ code: 1008, reason: "revoked" }]);
});


test("periodic authorization checks the persisted device and epoch after hibernation reconstruction", async () => {
  const { entries, storage } = fixture();
  const id = randomUUID();
  entries.set("device:" + id, {
    device_id: id, name: "approved", public_key: newEnrollment("approved").request.public_key,
    fingerprint: "a".repeat(24), approved_at: Date.now(), revoked: false,
  });
  entries.set("session:epoch:" + id, "current");
  const state = { storage } as unknown as DurableObjectState;
  const createSocket = (epoch: string) => {
    const messages: string[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    let attachment: object = { device_id: id, epoch };
    return {
      value: {
        deserializeAttachment: () => attachment,
        serializeAttachment: (next: object) => { attachment = next; },
        send: (value: string) => messages.push(value),
        close: (code: number, reason: string) => closes.push({ code, reason }),
      } as unknown as WebSocket,
      messages, closes,
    };
  };
  const active = createSocket("current");
  await handleIdleSocketMessage(state, active.value, "rc-v2:auth:" + "a".repeat(32));
  assert.deepEqual(active.messages, ["rc-v2:auth-ok:" + "a".repeat(32)]);
  assert.deepEqual(active.closes, []);
  const malformed = createSocket("current");
  await handleIdleSocketMessage(state, malformed.value, "rc-v2:auth");
  assert.deepEqual(malformed.messages, []);
  assert.deepEqual(malformed.closes, [{ code: 1008, reason: "no remote operations enabled" }]);

  entries.set("session:epoch:" + id, "replacement");
  const stale = createSocket("current");
  await handleIdleSocketMessage(state, stale.value, "rc-v2:auth:" + "b".repeat(32));
  assert.deepEqual(stale.messages, []);
  assert.deepEqual(stale.closes, [{ code: 1008, reason: "revoked" }]);

  entries.set("device:" + id, {
    ...(entries.get("device:" + id) as object), revoked: true,
  });
  const revoked = createSocket("replacement");
  await handleIdleSocketMessage(state, revoked.value, "rc-v2:auth:" + "c".repeat(32));
  assert.deepEqual(revoked.messages, []);
  assert.deepEqual(revoked.closes, [{ code: 1008, reason: "revoked" }]);
});


test("invalid or binary WSS frames never trigger durable storage reads or attachment access", async () => {
  let storageReads = 0;
  const state = {
    storage: { get: async () => { storageReads++; throw new Error("must not read"); } },
  } as unknown as DurableObjectState;
  for (const message of [
    "{}",
    JSON.stringify({ tool: "start_process", arguments: {} }),
    "rc-v2:auth",
    "rc-v2:auth:invalid",
    "rc-v2:auth:" + "b".repeat(2048),
    new Uint8Array(2048).buffer,
  ]) {
    const closes: Array<{ code: number; reason: string }> = [];
    const socket = {
      deserializeAttachment: () => { throw new Error("must not deserialize"); },
      close: (code: number, reason: string) => closes.push({ code, reason }),
    } as unknown as WebSocket;
    await handleIdleSocketMessage(state, socket, message);
    assert.deepEqual(closes, [{ code: 1008, reason: "no remote operations enabled" }]);
  }
  assert.equal(storageReads, 0, "invalid frames must never consume SQLite reads");
});

test("rate-limited WSS authority probe is fenced by Hibernation socket attachment", async () => {
  const id = randomUUID();
  let reads = 0;
  const state = {
    storage: { get: async (key: string) => {
      reads++;
      if (key === "session:epoch:" + id) return "current";
      if (key === "device:" + id) return { device_id: id, revoked: false };
      return undefined;
    } },
  } as unknown as DurableObjectState;
  let attachment: { device_id: string; epoch: string; last_auth_check_at?: number } = {
    device_id: id, epoch: "current",
  };
  const messages: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const socket = {
    deserializeAttachment: () => attachment,
    serializeAttachment: (next: typeof attachment) => { attachment = next; },
    send: (value: string) => messages.push(value),
    close: (code: number, reason: string) => closes.push({ code, reason }),
  } as unknown as WebSocket;
  await handleIdleSocketMessage(state, socket, "rc-v2:auth:" + "a".repeat(32));
  assert.deepEqual(messages, ["rc-v2:auth-ok:" + "a".repeat(32)]);
  assert.equal(reads, 2);
  assert.equal(typeof attachment.last_auth_check_at, "number");

  // Simulate a re-created DO reading the same persisted attachment. A second
  // tag does not bypass the rate gate or cause any additional storage reads.
  await handleIdleSocketMessage(state, socket, "rc-v2:auth:" + "b".repeat(32));
  assert.deepEqual(closes, [{ code: 1008, reason: "authorization rate limited" }]);
  assert.equal(reads, 2);
  assert.equal(messages.length, 1);

  // An auth check after the 30-second gate on a new socket remains valid.
  attachment = { device_id: id, epoch: "current", last_auth_check_at: Date.now() - 31_000 };
  await handleIdleSocketMessage(state, socket, "rc-v2:auth:" + "c".repeat(32));
  assert.deepEqual(messages[1], "rc-v2:auth-ok:" + "c".repeat(32));
  assert.equal(reads, 4);
});

test("DO storage outage fails closed with retryable 1011 instead of unhandled WSS event", async () => {
  const id = randomUUID();
  const state = {
    storage: { get: async () => { throw new Error("private storage failure"); } },
  } as unknown as DurableObjectState;
  const sent: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  let checkpointed = false;
  const socket = {
    deserializeAttachment: () => ({ device_id: id, epoch: "current" }),
    serializeAttachment: () => { checkpointed = true; },
    send: (value: string) => sent.push(value),
    close: (code: number, reason: string) => closes.push({ code, reason }),
  } as unknown as WebSocket;
  await handleIdleSocketMessage(state, socket, "rc-v2:auth:" + "d".repeat(32));
  assert.equal(checkpointed, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(closes, [{ code: 1011, reason: "authorization unavailable" }]);
});


test("corrupted Hibernation socket attachment fails closed without running the message handler", async () => {
  const id = randomUUID();
  let reads = 0;
  const state = {
    storage: { get: async () => { reads++; return undefined; } },
  } as unknown as DurableObjectState;
  for (const stage of ["deserialize", "serialize"] as const) {
    const closes: Array<{ code: number; reason: string }> = [];
    const socket = {
      deserializeAttachment: () => {
        if (stage === "deserialize") throw new Error("corrupted attachment");
        return { device_id: id, epoch: "current" };
      },
      serializeAttachment: () => { throw new Error("cannot persist attachment"); },
      send: () => { assert.fail("Invalid attachment must not authorize"); },
      close: (code: number, reason: string) => closes.push({ code, reason }),
    } as unknown as WebSocket;
    await handleIdleSocketMessage(state, socket, "rc-v2:auth:" + "e".repeat(32));
    assert.deepEqual(closes, [{ code: 1011, reason: "authorization unavailable" }]);
  }
  assert.equal(reads, 0);
});
