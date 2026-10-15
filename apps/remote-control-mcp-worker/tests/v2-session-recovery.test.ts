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
      close(code: number, reason: string) { closes.push({ code, reason }); },
    } as unknown as WebSocket;
    return { obj, closes };
  }
  const state = { storage } as unknown as DurableObjectState;
  const old = socket("old-epoch");
  await handleIdleSocketMessage(state, old.obj, JSON.stringify({ type: "execute", tool: "write_file" }));
  assert.deepEqual(old.closes, [{ code: 1008, reason: "revoked" }]);
  const current = socket("new-epoch");
  await handleIdleSocketMessage(state, current.obj, JSON.stringify({ type: "execute", tool: "start_process" }));
  assert.deepEqual(current.closes, [{ code: 1008, reason: "no remote operations enabled" }]);
  const revoked = entries.get("device:" + id) as Record<string, unknown>;
  entries.set("device:" + id, { ...revoked, revoked: true });
  const afterRevoke = socket("new-epoch");
  await handleIdleSocketMessage(state, afterRevoke.obj, "{}");
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
    return {
      value: {
        deserializeAttachment: () => ({ device_id: id, epoch }),
        send: (value: string) => messages.push(value),
        close: (code: number, reason: string) => closes.push({ code, reason }),
      } as unknown as WebSocket,
      messages, closes,
    };
  };
  const active = createSocket("current");
  await handleIdleSocketMessage(state, active.value, "rc-v2:auth");
  assert.deepEqual(active.messages, ["rc-v2:auth-ok"]);
  assert.deepEqual(active.closes, []);

  entries.set("session:epoch:" + id, "replacement");
  const stale = createSocket("current");
  await handleIdleSocketMessage(state, stale.value, "rc-v2:auth");
  assert.deepEqual(stale.messages, []);
  assert.deepEqual(stale.closes, [{ code: 1008, reason: "revoked" }]);

  entries.set("device:" + id, {
    ...(entries.get("device:" + id) as object), revoked: true,
  });
  const revoked = createSocket("replacement");
  await handleIdleSocketMessage(state, revoked.value, "rc-v2:auth");
  assert.deepEqual(revoked.messages, []);
  assert.deepEqual(revoked.closes, [{ code: 1008, reason: "revoked" }]);
});
