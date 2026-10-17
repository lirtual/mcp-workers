import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {newEnrollment, saveNewPrivateKey} from "../../remote-control-agent/src/v2-enrollment.ts";
import {recoverDeviceId} from "../../remote-control-agent/src/v2-session-client.ts";
import worker, {V2OwnerCoordinator} from "../src/worker.ts";
import {approvePendingKey} from "../src/v2-pairing.ts";
import {TEMPORARY_GRANT_MS} from "../src/v2-session.ts";

function fixture() {
  const rows = new Map<string,unknown>();
  const store = {
    get: async <T>(key:string) => rows.get(key) as T | undefined,
    put: async (key:string, value:unknown) => {rows.set(key,value);},
    delete: async (key:string) => rows.delete(key),
    list: async <T>({prefix,limit}:{prefix:string;limit:number}) =>
      new Map([...rows].filter(([key])=>key.startsWith(prefix)).slice(0,limit)) as Map<string,T>,
    transaction: async <T>(fn:(tx:unknown)=>Promise<T>) => fn(store),
  };
  const owner = new V2OwnerCoordinator({storage:store} as unknown as DurableObjectState);
  const V2_OWNER = {
    idFromName() {return "single-owner";},
    get() {return {fetch:(input:RequestInfo|URL,init?:RequestInit) =>
      owner.fetch(input instanceof Request ? input : new Request(input,init))};},
  } as unknown as DurableObjectNamespace;
  const env = {MCP_ACCESS_TOKEN:"owner-test-credential",V2_OWNER,
    REMOTE_CONTROL_DEVICE_TOKEN:"legacy-v1-fixture"} as unknown as Env;
  const origin="https://pairing.test/";
  const send:typeof fetch=async(input,init)=>worker.fetch(
    input instanceof Request ? input : new Request(input,init),env);
  const rpc=async(name:string,args:object,token="owner-test-credential")=>{
    const response=await send(origin+"mcp",{
      method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}),
    });
    const json=await response.json() as {result?:{isError?:boolean;content:Array<{text:string}>}};
    const payload=json.result?.content?.[0]?.text||"{}";
    return {response,payload,object:(()=>{try{return JSON.parse(payload) as Record<string,unknown>;}catch{return {};}})()};
  };
  const register=async(request:object)=>send(origin+"agent/pair/start",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request),
  });
  return {rows,store,send,rpc,register,origin};
}

test("#97 explicit MCP approval is separate from lookup and Agent claims by existing signed recovery",async()=>{
  const f=fixture(), pending=newEnrollment("one-code-host");
  const dir=await mkdtemp(path.join(os.tmpdir(),"remote-v2-one-code-"));
  const keyPath=path.join(dir,"identity.pem");
  try {
    await saveNewPrivateKey(keyPath,pending.privateKeyPem);
    assert.equal((await f.register(pending.request)).status,202);
    assert.equal((await f.rpc("pairing_lookup",{code:pending.code},"wrong-token")).response.status,401);
    const looked=await f.rpc("pairing_lookup",{code:pending.code});
    const pairingId=String(looked.object.pairing_id),fingerprint=String(looked.object.fingerprint);
    assert.match(pairingId,/^[a-f0-9-]{36}$/);
    assert.equal(looked.object.grant_type,"permanent");
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);

    const wrong=await f.rpc("pairing_approve",{
      pairing_id:pairingId,expected_fingerprint:"0".repeat(24),expected_grant_type:"permanent",
    });
    assert.equal(wrong.object.status,undefined);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);
    const mode=await f.rpc("pairing_approve",{
      pairing_id:pairingId,expected_fingerprint:fingerprint,expected_grant_type:"temporary",
    });
    assert.equal(mode.object.status,undefined);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);

    const approved=await f.rpc("pairing_approve",{
      pairing_id:pairingId,expected_fingerprint:fingerprint,expected_grant_type:"permanent",
    });
    assert.equal(approved.object.status,"approved");
    const deviceId=String(approved.object.device_id);
    assert.match(deviceId,/^[a-f0-9-]{36}$/);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,1);
    assert.equal(f.rows.has("pending:"+pending.request.code_verifier),false);
    assert.equal((await f.rpc("pairing_lookup",{code:pending.code})).object.status,undefined);
    assert.equal((await f.rpc("pairing_approve",{
      pairing_id:pairingId,expected_fingerprint:fingerprint,expected_grant_type:"permanent",
    })).object.status,undefined);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,1);

    // The existing session/recovery protocol performs a fresh Ed25519 signed
    // server challenge and obtains exactly the same device ID without any
    // human-entered confirmation challenge or new public claim endpoint.
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),deviceId);
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),deviceId);
    const foreign=newEnrollment("foreign-key");
    const foreignPath=path.join(dir,"foreign.pem");
    await saveNewPrivateKey(foreignPath,foreign.privateKeyPem);
    await assert.rejects(recoverDeviceId(f.origin,foreignPath,f.send));
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("#97 temporary owner approval binds exact grant and fixed server expiry",async()=>{
  const f=fixture(),pending=newEnrollment("temp-approval",undefined,"temporary");
  assert.equal((await f.register(pending.request)).status,202);
  const looked=await f.rpc("pairing_lookup",{code:pending.code});
  assert.equal(looked.object.grant_type,"temporary");
  const args={pairing_id:String(looked.object.pairing_id),
    expected_fingerprint:String(looked.object.fingerprint),expected_grant_type:"temporary"};
  const approved=await f.rpc("pairing_approve",args);
  assert.equal(approved.object.status,"approved");
  const record=f.rows.get("device:"+approved.object.device_id) as
    {approved_at:number;expires_at:number;grant_type:string};
  assert.equal(record.grant_type,"temporary");
  assert.equal(record.expires_at-record.approved_at,TEMPORARY_GRANT_MS);
});

test("#97 pending legacy two-code preparation cannot be upgraded into approval",async()=>{
  const f=fixture(),material=newEnrollment("old-flow");
  assert.equal((await f.register(material.request)).status,202);
  const lookup=await f.rpc("pairing_lookup",{code:material.code});
  const id=String(lookup.object.pairing_id),fp=String(lookup.object.fingerprint);
  // Simulate an in-flight old two-code record preserved in DO storage
  // through rollout; never upgrade it automatically into the new flow.
  const row=f.rows.get("pending:"+material.request.code_verifier) as Record<string,unknown>;
  row.confirmation_hash="d".repeat(64);
  row.confirmation_expires_at=Date.now()+60_000;
  const rejected=await approvePendingKey(f.store as never,id,fp,"permanent");
  assert.equal(rejected.status,409);
  assert.equal((rejected.body as {error:string}).error,"legacy_pairing_in_progress");
  assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);
});
