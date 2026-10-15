import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newEnrollment, saveNewPrivateKey } from "../../remote-control-agent/src/v2-enrollment.ts";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";
import { registerPending, lookupPending, verifyRegistration, type PendingDevice } from "../src/v2-pairing.ts";

function makeStore() {
  const values = new Map<string, PendingDevice>();
  const store: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: PendingDevice): Promise<void>; delete(key: string): Promise<boolean>; list<T>(opts: {prefix: string;limit: number}): Promise<Map<string,T>>; transaction<T>(fn:(tx: typeof store)=>Promise<T>): Promise<T> } = {
    async get<T>(key: string): Promise<T | undefined> { return values.get(key) as T | undefined; },
    async put(key: string, value: PendingDevice) { values.set(key, value); },
    async delete(key: string) { return values.delete(key); },
    async list<T>({ prefix, limit }: {prefix: string;limit: number}): Promise<Map<string,T>> {
      return new Map([...values].filter(([k]) => k.startsWith(prefix)).slice(0, limit)) as Map<string,T>;
    },
    async transaction<T>(fn: (tx: typeof store)=>Promise<T>): Promise<T> { return fn(store); },
  };
  return { store, values };
}

test("v2 Agent code and Ed25519 public proof are bounded; private key stays local", async () => {
  const { code, request, privateKeyPem } = newEnrollment("home-linux");
  assert.match(code, /^[A-Z2-7]{10}$/);
  assert.match(request.code_verifier, /^[a-f0-9]{64}$/);
  assert.equal((await verifyRegistration(request))?.verifier, request.code_verifier);
  assert.equal(await verifyRegistration({ ...request, name: "tampered" }), null === null ? (await verifyRegistration({ ...request, proof: "invalid" })) : null); // see separate invalid proof assertion
  assert.equal(await verifyRegistration({ ...request, proof: "invalid" }), null);
  assert.equal(await verifyRegistration({ ...request, name: "tampered" }), null);
  assert.equal(await verifyRegistration({ ...request, issued_at: request.issued_at - 65_000 }), null);
  const dir = await mkdtemp(path.join(os.tmpdir(), "remote-v2-pair-"));
  const keyPath = path.join(dir, "device-key.pem");
  try {
    await saveNewPrivateKey(keyPath, privateKeyPem);
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.match(await readFile(keyPath, "utf8"), /PRIVATE KEY/);
    await assert.rejects(saveNewPrivateKey(keyPath, "second"), { code: "EEXIST" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pending enrollment only permits Portal-authenticated readonly preview; v1 tools untouched", async () => {
  const { store, values } = makeStore();
  const owner = new V2OwnerCoordinator({ storage: store } as unknown as DurableObjectState);
  const binding = {
    idFromName() { return "one"; },
    get() { return { fetch: (input: RequestInfo | URL, init?: RequestInit) => owner.fetch(input instanceof Request ? input : new Request(input, init)) }; },
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "portal-credential",
    REMOTE_CONTROL_DEVICE_TOKEN: "local-agent-secret",
    V2_OWNER: binding,
  } as Env & { V2_OWNER: DurableObjectNamespace };
  const enrollment = newEnrollment("test-cloud");
  const registration = await worker.fetch(new Request("https://example.test/agent/pair/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(enrollment.request),
  }), env);
  assert.equal(registration.status, 202);

  async function mcp(token: string, method: string, params?: unknown) {
    return worker.fetch(new Request("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), env);
  }
  assert.equal((await mcp("bad", "tools/call", { name: "pairing_lookup", arguments: { code: enrollment.code } })).status, 401);
  const tools = await (await mcp("portal-credential", "tools/list")).json() as {result:{tools:Array<{name:string}>}};
  assert.equal(tools.result.tools.some(x=>x.name==="pairing_lookup"), true);
  const match = await mcp("portal-credential", "tools/call", { name: "pairing_lookup", arguments: { code: enrollment.code } });
  const matchBody = await match.text();
  assert.match(matchBody, /test-cloud/);
  assert.ok(!matchBody.includes(enrollment.code));
  assert.ok(!matchBody.includes(enrollment.request.public_key));
  assert.ok(!matchBody.includes(enrollment.request.code_verifier));
  assert.ok(!matchBody.includes("PRIVATE KEY"));
  assert.ok(!matchBody.includes("approve"));
  assert.equal([...values.keys()].filter((key) => key.startsWith("pending:")).length, 1);
  const wrong = await mcp("portal-credential", "tools/call", { name: "pairing_lookup", arguments: { code: "AAAAAAAAAA" } });
  assert.ok((await wrong.text()).includes("not found"));
  assert.equal([...values.keys()].filter((key) => key.startsWith("pending:")).length, 1); // No activation, command route or mutation.
});

test("pending store rejects invalid proof and expired/duplicate requests", async () => {
  const {store,values} = makeStore();
  const request = newEnrollment("safe-device").request;
  assert.equal((await registerPending(store as never, { ...request, proof: "invalid" })).status, 400);
  assert.equal((await registerPending(store as never, request)).status, 202);
  assert.equal((await registerPending(store as never, request)).status, 409);
  const record = values.get("pending:" + request.code_verifier)!;
  record.expires_at = Date.now() - 1;
  assert.equal((await lookupPending(store as never, request.code_verifier)).status, 404);
});


test("P1 security gate: a valid Portal token and automated confirm tool call cannot activate a pending device", async () => {
  const { store, values } = makeStore();
  const owner = new V2OwnerCoordinator({ storage: store } as unknown as DurableObjectState);
  const ns = {
    idFromName() { return "isolated-owner"; },
    get() { return { fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      owner.fetch(input instanceof Request ? input : new Request(input, init)) }; },
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "portal-credential",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy-local-secret",
    V2_OWNER: ns,
  } as Env & { V2_OWNER: DurableObjectNamespace };
  const pending = newEnrollment("sandbox-agent");
  const first = await worker.fetch(new Request("https://localhost.test/agent/pair/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pending.request),
  }), env);
  assert.equal(first.status, 202);

  const rpc = async (token: string, method: string, params?: unknown) =>
    worker.fetch(new Request("https://localhost.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    }), env);
  const tools = await (await rpc("portal-credential", "tools/list")).json() as {
    result: { tools: Array<{ name: string }> };
  };
  assert.equal(tools.result.tools.some(x => x.name === "pairing_lookup"), true);
  // The only pairing tool is observational; a model-generated approval cannot be accepted.
  assert.equal(tools.result.tools.some(x => /confirm|approve|authorize|pairing_complete/.test(x.name)), false);

  const observed = await rpc("portal-credential", "tools/call", {
    name: "pairing_lookup", arguments: { code: pending.code },
  });
  assert.equal(observed.status, 200);
  const envelope = await observed.json() as { result: { content: [{ text: string }] } };
  const details = JSON.parse(envelope.result.content[0].text) as { pairing_id: string; fingerprint: string };
  assert.match(details.fingerprint, /^[a-f0-9]{24}$/);
  const before = [...values.entries()].filter(([key]) => key.startsWith("pending:"));
  assert.equal(before.length, 1);

  for (const [token, name] of [
    ["portal-credential", "pairing_confirm"],
    ["portal-credential", "approve_device"],
    ["wrong-credential", "pairing_confirm"],
  ] as const) {
    const result = await rpc(token, "tools/call", {
      name, arguments: {
        pairing_id: details.pairing_id,
        expected_fingerprint: details.fingerprint,
        approve: true,
      },
    });
    if (token !== "portal-credential") {
      assert.equal(result.status, 401);
    } else {
      assert.equal(result.status, 200);
      assert.match(await result.text(), /rejected/);
    }
  }
  for (const pathname of ["/agent/pair/confirm", "/agent/connect", "/agent/approve"]) {
    const response = await worker.fetch(new Request("https://localhost.test" + pathname, {
      method: "POST", headers: { authorization: "Bearer portal-credential" },
    }), env);
    assert.equal(response.status, 404);
  }
  // The pending record is not transformed into an approved device or public Shell capability.
  const after = [...values.entries()].filter(([key]) => key.startsWith("pending:"));
  assert.deepEqual(after, before);
  assert.equal([...values.keys()].filter(key => key.startsWith("device:")).length, 0);
});
