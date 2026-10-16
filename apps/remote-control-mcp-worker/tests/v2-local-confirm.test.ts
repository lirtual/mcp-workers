import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newEnrollment, saveNewPrivateKey } from "../../remote-control-agent/src/v2-enrollment.ts";
import { confirmDeviceLocally } from "../../remote-control-agent/src/confirm-device.ts";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

interface StorageFixture {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(opts: { prefix: string; limit: number }): Promise<Map<string, T>>;
  transaction<T>(fn: (store: StorageFixture) => Promise<T>): Promise<T>;
}

function setup() {
  const rows = new Map<string, unknown>();
  const storage: StorageFixture = {
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async put(key: string, value: unknown) { rows.set(key, value); },
    async delete(key: string) { return rows.delete(key); },
    async list<T>(opts: { prefix: string; limit: number }) {
      return new Map([...rows].filter(([k]) => k.startsWith(opts.prefix)).slice(0, opts.limit)) as Map<string, T>;
    },
    async transaction<T>(fn: (store: StorageFixture) => Promise<T>) { return fn(storage); },
  };
  const owner = new V2OwnerCoordinator({ storage } as unknown as DurableObjectState);
  const V2_OWNER = {
    idFromName() { return "owner"; },
    get() { return { fetch: (url: RequestInfo | URL, init?: RequestInit) =>
      owner.fetch(url instanceof Request ? url : new Request(url, init)) }; },
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "portal-test-only",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy-v1-test",
    V2_OWNER,
  } as Env & { V2_OWNER: DurableObjectNamespace };
  const site = "https://pairing.test/";
  const send: typeof fetch = async (input, init) =>
    worker.fetch(input instanceof Request ? input : new Request(input, init), env);
  const rpc = async (name: string, args: object, token = "portal-test-only") => {
    const response = await send(site + "mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args } }),
    });
    return { response, data: await response.json() as {
      result?: { content: Array<{ text: string }> };
    } };
  };
  const value = (result: Awaited<ReturnType<typeof rpc>>) =>
    JSON.parse(result.data.result?.content[0]?.text ?? "{}") as Record<string, unknown>;
  return { rows, env, site, send, rpc, value, storage };
}

test("Portal preview/prepare + independent Agent terminal proof is the ONLY pairing activation path", async () => {
  const { rows, site, send, rpc, value } = setup();
  const material = newEnrollment("Linux-v2-pending");
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-local-confirm-"));
  const file = path.join(dir, "key.pem");
  try {
    await saveNewPrivateKey(file, material.privateKeyPem);
    const registration = await send(site + "agent/pair/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(material.request),
    });
    assert.equal(registration.status, 202);

    const preview = await rpc("pairing_lookup", { code: material.code });
    const identity = value(preview);
    assert.match(String(identity.pairing_id), /^[a-f0-9-]{36}$/);
    assert.match(String(identity.fingerprint), /^[a-f0-9]{24}$/);
    const denied = await rpc("pairing_prepare", { pairing_id: identity.pairing_id,
      expected_fingerprint: "0".repeat(24) });
    assert.equal(denied.data.result?.content[0]?.text.includes("not found"), true);
    const prepWithoutBearer = await rpc("pairing_prepare", {
      pairing_id: identity.pairing_id, expected_fingerprint: identity.fingerprint,
    }, "not-the-owner");
    assert.equal(prepWithoutBearer.response.status, 401);

    const prepared = await rpc("pairing_prepare", {
      pairing_id: identity.pairing_id, expected_fingerprint: identity.fingerprint,
    });
    const challenge = String(value(prepared).challenge);
    assert.match(challenge, /^[A-Z2-7]{12}$/);
    assert.equal([...rows.keys()].filter(x => x.startsWith("device:")).length, 0);

    const auto = await rpc("pairing_confirm", {
      pairing_id: identity.pairing_id, expected_fingerprint: identity.fingerprint, approve: true,
    });
    assert.match(auto.data.result?.content[0]?.text ?? "", /rejected/);
    assert.equal([...rows.keys()].filter(x => x.startsWith("device:")).length, 0);

    // The model may see the challenge but cannot sign as the new device.
    const forged = await send(site + "agent/pair/complete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifier: material.request.code_verifier,
        challenge, proof: "invalid" }),
    });
    assert.equal(forged.status, 403);

    let capturedProof: unknown;
    const signed: typeof fetch = async (input, init) => {
      capturedProof = JSON.parse(String(init?.body));
      return send(input, init);
    };
    const deviceId = await confirmDeviceLocally(material.code, challenge, site, file, signed);
    assert.match(deviceId, /^[a-f0-9-]{36}$/);
    assert.equal([...rows.keys()].filter(x => x.startsWith("device:")).length, 1);
    assert.equal([...rows.keys()].filter(x => x.startsWith("pending:")).length, 0);
    assert.equal((rows.get("device:" + deviceId) as { public_key: string }).public_key, material.request.public_key);

    const replay = await send(site + "agent/pair/complete", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(capturedProof),
    });
    assert.equal(replay.status, 404);
    await assert.rejects(confirmDeviceLocally(material.code, challenge, site, file, signed), /already has a paired/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local confirmation rejects guessed/expired challenge and wrong private key", async () => {
  const { rows, site, send, rpc, value } = setup();
  const material = newEnrollment("trusted-key");
  const wrong = newEnrollment("wrong-key");
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-local-deny-"));
  const rightPath = path.join(dir, "right.pem");
  const wrongPath = path.join(dir, "wrong.pem");
  try {
    await saveNewPrivateKey(rightPath, material.privateKeyPem);
    await saveNewPrivateKey(wrongPath, wrong.privateKeyPem);
    assert.equal((await send(site + "agent/pair/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(material.request),
    })).status, 202);
    const identity = value(await rpc("pairing_lookup", { code: material.code }));
    const prepared = value(await rpc("pairing_prepare", {
      pairing_id: identity.pairing_id, expected_fingerprint: identity.fingerprint,
    }));
    const challenge = String(prepared.challenge);
    await assert.rejects(confirmDeviceLocally(material.code, challenge, site, wrongPath, send), /denied/);
    await assert.rejects(confirmDeviceLocally(material.code, "AAAAAAAAAAAA", site, rightPath, send), /denied/);
    assert.equal([...rows.keys()].filter(x => x.startsWith("device:")).length, 0);
    const replacement = value(await rpc("pairing_prepare", {
      pairing_id: identity.pairing_id, expected_fingerprint: identity.fingerprint,
    }));
    const newerChallenge = String(replacement.challenge);
    assert.notEqual(challenge, newerChallenge);
    await assert.rejects(confirmDeviceLocally(material.code, challenge, site, rightPath, send), /denied/);
    const row = rows.get("pending:" + material.request.code_verifier) as { confirmation_expires_at: number };
    row.confirmation_expires_at = Date.now() - 1;
    await assert.rejects(confirmDeviceLocally(material.code, challenge, site, rightPath, send), /denied/);
    assert.equal([...rows.keys()].filter(x => x.startsWith("device:")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revoked identity cannot silently re-pair with the old key, but a new key and the same machine name can", async () => {
  const { rows, site, send, rpc, value } = setup();
  const original = newEnrollment("same-host");
  const fresh = newEnrollment("same-host");
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-reinstall-after-revoke-"));
  async function begin(material: typeof original) {
    const registered = await send(site + "agent/pair/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(material.request),
    });
    assert.equal(registered.status, 202);
    const identity = value(await rpc("pairing_lookup", { code: material.code }));
    const prepared = value(await rpc("pairing_prepare", {
      pairing_id: identity.pairing_id, expected_fingerprint: identity.fingerprint,
    }));
    return String(prepared.challenge);
  }
  try {
    const oldKey = path.join(dir, "old.pem");
    await saveNewPrivateKey(oldKey, original.privateKeyPem);
    const originalId = await confirmDeviceLocally(original.code, await begin(original), site, oldKey, send);
    assert.match(originalId, /^[a-f0-9-]{36}$/);
    const revoked = await rpc("revoke_device", { device_id: originalId });
    assert.equal(value(revoked).status, "revoked");

    // A reinstalled Agent still holding a cloned old key and an entirely new
    // human-entered confirmation challenge must never obtain a second ID.
    const clonedOld = path.join(dir, "cloned-old.pem");
    await saveNewPrivateKey(clonedOld, original.privateKeyPem);
    const rejected = await send(site + "agent/pair/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(newEnrollment("same-host", original.privateKeyPem).request),
    });
    // Refuse the old public key BEFORE creating a pending code or challenge.
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json() as {error:string}).error, "identity_already_used");
    assert.equal([...rows].filter(([k]) => k.startsWith("device:")).length, 1);
    assert.equal((rows.get("device:" + originalId) as { revoked: boolean }).revoked, true);

    // A fresh installation with a fresh Ed25519 identity can go through the
    // same independent human terminal confirmation, even with the same label.
    const newKey = path.join(dir, "new.pem");
    await saveNewPrivateKey(newKey, fresh.privateKeyPem);
    const newId = await confirmDeviceLocally(fresh.code, await begin(fresh), site, newKey, send);
    assert.notEqual(newId, originalId);
    assert.equal((rows.get("device:" + newId) as { revoked: boolean }).revoked, false);
    assert.equal((rows.get("device:" + originalId) as { revoked: boolean }).revoked, true);
    assert.equal([...rows].filter(([k]) => k.startsWith("device:")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
