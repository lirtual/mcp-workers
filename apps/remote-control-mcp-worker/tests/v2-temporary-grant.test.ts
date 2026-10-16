import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import { newEnrollment } from "../../remote-control-agent/src/v2-enrollment.ts";
import {
  registerPending, lookupPending, prepareLocalConfirmation, completeLocalConfirmation,
  verifyRegistration,
} from "../src/v2-pairing.ts";
import { deviceIsAuthorized, issueSessionChallenge, listApprovedDevices, TEMPORARY_GRANT_MS } from "../src/v2-session.ts";

function setup() {
  const rows = new Map<string, unknown>();
  const store = {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async <T>({prefix, limit}: {prefix:string; limit:number}) =>
      new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string,T>,
    transaction: async <T>(callback: (txn: unknown) => Promise<T>) => callback(store),
  };
  return { rows, store };
}

test("#72 signed temporary mode cannot be downgraded, and MCP owner must review it explicitly", async () => {
  const {store} = setup();
  const temporary = newEnrollment("ephemeral-test", undefined, "temporary");
  assert.equal(temporary.request.grant_type, "temporary");
  assert.equal((await verifyRegistration(temporary.request))?.record.grant_type, "temporary");
  assert.equal(await verifyRegistration({...temporary.request, grant_type: undefined}), null);
  assert.equal(await verifyRegistration({...temporary.request, grant_type: "permanent"}), null);
  assert.equal((await registerPending(store as never, temporary.request)).status, 202);
  const detail = await lookupPending(store as never, temporary.request.code_verifier);
  const pending = detail.body as {pairing_id:string; fingerprint:string; grant_type:string};
  assert.equal(pending.grant_type, "temporary");
  const refused = await prepareLocalConfirmation(store as never, pending.pairing_id, pending.fingerprint);
  assert.equal(refused.status, 409);
  assert.equal((refused.body as {error:string}).error, "grant_type_mismatch");
  const prepared = await prepareLocalConfirmation(store as never, pending.pairing_id, pending.fingerprint, "temporary");
  assert.equal(prepared.status, 200);
  assert.equal((prepared.body as {grant_type:string}).grant_type, "temporary");
  const challenge = (prepared.body as {challenge:string}).challenge;
  const payload = "remote-control:v2:local-confirm:" + temporary.request.code_verifier + ":" +
    challenge + ":" + temporary.request.public_key;
  const proof = Buffer.from(sign(null, Buffer.from(payload), createPrivateKey(temporary.privateKeyPem))).toString("base64");
  const approval = await completeLocalConfirmation(store as never, {
    verifier:temporary.request.code_verifier, challenge, proof,
  });
  assert.equal(approval.status, 200);
  const deviceId = (approval.body as {device_id:string}).device_id;
  const record = await store.get<{approved_at:number; expires_at:number; grant_type:string; revoked:boolean}>("device:"+deviceId);
  assert.equal(record?.grant_type,"temporary");
  assert.equal(record!.expires_at-record!.approved_at, TEMPORARY_GRANT_MS);
  assert.equal(deviceIsAuthorized(record as never, record!.expires_at-1),true);
  assert.equal(deviceIsAuthorized(record as never, record!.expires_at),false);
  // Approval and expiry are fixed by the server, not an Agent duration claim.
  assert.equal((await issueSessionChallenge(store as never,{device_id:deviceId})).status,200);
});

test("#72 expired grant blocks reconnect, disappears from list and releases capacity without alarm", async () => {
  const {store, rows} = setup();
  const id="00000000-0000-4000-8000-000000000001";
  const approvedAt=Date.now()-TEMPORARY_GRANT_MS;
  rows.set("device:"+id, {
    device_id:id,name:"expired",public_key:"expired",fingerprint:"b".repeat(24),
    approved_at:approvedAt,expires_at:approvedAt+TEMPORARY_GRANT_MS,grant_type:"temporary",revoked:false,
  });
  rows.set("session:epoch:"+id,"old-epoch");
  assert.equal((await issueSessionChallenge(store as never,{device_id:id})).status,404);
  const status=await listApprovedDevices({
    storage:store,getWebSockets:()=>[],
  } as never);
  assert.deepEqual(status.body,[]);
  assert.equal(rows.has("device:"+id),false);
  assert.equal(rows.has("session:epoch:"+id),false);
  const permanent=newEnrollment("permanent-legacy");
  assert.equal((await registerPending(store as never,permanent.request)).status,202);
  assert.equal((await verifyRegistration(permanent.request))?.record.grant_type,undefined);
});

test("#72 malformed temporary expiry is denied, including wrong duration or a missing timestamp", () => {
  const id="00000000-0000-4000-8000-000000000002";
  const base={device_id:id,name:"x",public_key:"key",fingerprint:"c".repeat(24),
    approved_at:Date.now(),revoked:false,grant_type:"temporary" as const};
  assert.equal(deviceIsAuthorized({...base,expires_at:base.approved_at+TEMPORARY_GRANT_MS}),true);
  assert.equal(deviceIsAuthorized({...base,expires_at:base.approved_at+TEMPORARY_GRANT_MS+1}),false);
  assert.equal(deviceIsAuthorized({...base}),false);
});
