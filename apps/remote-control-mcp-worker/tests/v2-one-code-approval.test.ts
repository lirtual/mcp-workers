import assert from "node:assert/strict";
import {createPrivateKey,sign} from "node:crypto";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {newEnrollment, saveNewPrivateKey} from "../../remote-control-agent/src/v2-enrollment.ts";
import {recoverDeviceId, signedSessionProof} from "../../remote-control-agent/src/v2-session-client.ts";
import {ReceiptStore, operationDigest} from "../../remote-control-agent/src/operations.ts";
import worker, {V2OwnerCoordinator} from "../src/worker.ts";
import {approvePendingKey} from "../src/v2-pairing.ts";
import {TEMPORARY_GRANT_MS, issueSessionChallenge, authorizeSession, authorizeSocketSession} from "../src/v2-session.ts";

function fixture() {
  const rows = new Map<string,unknown>();
  // Simulate Durable Object storage's transaction serialization. This test
  // fixture cannot model every DO failure, but simultaneous owner requests
  // must never observe the same unconsumed pending record in separate commits.
  let transactionTail:Promise<void> = Promise.resolve();
  const store = {
    get: async <T>(key:string) => rows.get(key) as T | undefined,
    put: async (key:string, value:unknown) => {rows.set(key,value);},
    delete: async (key:string) => rows.delete(key),
    list: async <T>({prefix,limit}:{prefix:string;limit:number}) =>
      new Map([...rows].filter(([key])=>key.startsWith(prefix)).slice(0,limit)) as Map<string,T>,
    transaction: async <T>(fn:(tx:unknown)=>Promise<T>) => {
      const previous=transactionTail;
      let release!:()=>void;
      transactionTail=new Promise<void>(resolve=>{release=resolve;});
      await previous;
      try{return await fn(store);} finally{release();}
    },
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

test("#97 concurrent owner approvals serialize to one grant; replay cannot mint another ID",async()=>{
  const f=fixture(),pending=newEnrollment("race-approval");
  assert.equal((await f.register(pending.request)).status,202);
  const found=await f.rpc("pairing_lookup",{code:pending.code});
  const args={pairing_id:String(found.object.pairing_id),
    expected_fingerprint:String(found.object.fingerprint),expected_grant_type:"permanent"};
  const results=await Promise.all(Array.from({length:5},()=>
    approvePendingKey(f.store as never,args.pairing_id,args.expected_fingerprint,args.expected_grant_type)));
  assert.equal(results.filter(r=>r.status===200).length,1);
  assert.equal(results.filter(r=>r.status===404).length,4);
  const devices=[...f.rows].filter(([key])=>key.startsWith("device:"));
  assert.equal(devices.length,1);
  assert.equal(f.rows.has("pending:"+pending.request.code_verifier),false);
  const original=(results.find(r=>r.status===200)!.body as {device_id:string}).device_id;
  assert.equal((devices[0]![1] as {device_id:string}).device_id,original);
  assert.equal((await approvePendingKey(f.store as never,args.pairing_id,
    args.expected_fingerprint,args.expected_grant_type)).status,404);
  assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,1);
});

test("#97 expired code, wrong pairing ID and malformed fingerprint cannot approve",async()=>{
  const f=fixture(),material=newEnrollment("expires");
  assert.equal((await f.register(material.request)).status,202);
  const lookup=await f.rpc("pairing_lookup",{code:material.code});
  const id=String(lookup.object.pairing_id),fp=String(lookup.object.fingerprint);
  assert.equal((await approvePendingKey(f.store as never,
    "00000000-0000-4000-8000-000000000000",fp,"permanent")).status,404);
  assert.equal((await approvePendingKey(f.store as never,id,"z".repeat(24),"permanent")).status,400);
  assert.equal((await approvePendingKey(f.store as never,id,fp,"temporary")).status,409);
  // Simulate the server-side clock passing the pending lifetime; DO controls it.
  const pending=f.rows.get("pending:"+material.request.code_verifier) as {expires_at:number};
  pending.expires_at=Date.now()-1;
  assert.equal((await f.rpc("pairing_lookup",{code:material.code})).object.pairing_id,undefined);
  assert.equal((await approvePendingKey(f.store as never,id,fp,"permanent")).status,404);
  assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);
});

test("#97 a legacy approved key without grant_type keeps signed WSS authority after a new one-code approval",async()=>{
  const f=fixture(),old=newEnrollment("approved-before-migration");
  const oldId="7e8855e2-e5d8-4bce-a11e-1833e9a0e6b0";
  f.rows.set("device:"+oldId,{
    device_id:oldId,name:"approved-before-migration",public_key:old.request.public_key,
    fingerprint:"9".repeat(24),approved_at:Date.now()-7200_000,revoked:false,
    // Historical v2 Preview records do not have grant_type.
  });
  const incoming=newEnrollment("new-one-code-device");
  assert.equal((await f.register(incoming.request)).status,202);
  const looked=await f.rpc("pairing_lookup",{code:incoming.code});
  const result=await f.rpc("pairing_approve",{
    pairing_id:String(looked.object.pairing_id),expected_fingerprint:String(looked.object.fingerprint),
    expected_grant_type:"permanent",
  });
  assert.equal(result.object.status,"approved");
  assert.notEqual(result.object.device_id,oldId);
  assert.equal([...f.rows.keys()].filter(k=>k.startsWith("device:")).length,2);
  const unchanged=f.rows.get("device:"+oldId) as {public_key:string;grant_type?:string;revoked:boolean};
  assert.equal(unchanged.public_key,old.request.public_key);
  assert.equal(unchanged.grant_type,undefined);
  assert.equal(unchanged.revoked,false);
  const nonce1=await issueSessionChallenge(f.store as never,{device_id:oldId});
  assert.equal(nonce1.status,200);
  const ch1=(nonce1.body as {nonce:string}).nonce;
  assert.equal((await authorizeSession(f.store as never,{
    device_id:oldId,nonce:ch1,proof:signedSessionProof(old.privateKeyPem,oldId,ch1).proof,
  })).status,200);
  // A fresh signed WSS login for the existing device must still work; the
  // new owner approval must not rewrite or revoke this prior grant.
  const nonce2=await issueSessionChallenge(f.store as never,{device_id:oldId});
  const ch2=(nonce2.body as {nonce:string}).nonce;
  const ws=await authorizeSocketSession(f.store as never,{
    device_id:oldId,nonce:ch2,proof:signedSessionProof(old.privateKeyPem,oldId,ch2).proof,
  });
  assert.equal(ws?.device_id,oldId);
  assert.ok(ws?.epoch);
});

test("#97 old signed pending code without new protocol proof cannot be silently approved",async()=>{
  const f=fixture(),old=newEnrollment("pre-migration-pending");
  // Verify actual old signature format, not just an arbitrary invalid blob.
  const req=old.request;
  const oldTranscript="remote-control:v2:pending:"+req.code_verifier+":"+
    req.public_key+":"+req.name+":"+req.issued_at;
  const oldProof=Buffer.from(sign(null,Buffer.from(oldTranscript),createPrivateKey(old.privateKeyPem))).toString("base64");
  const oldRequest:Record<string,unknown>={...req,proof:oldProof};
  delete oldRequest.pairing_protocol;
  assert.equal((await f.register(oldRequest)).status,400,"obsolete Agent cannot create an ambiguously approvable pending record");
  assert.equal((await f.register({...oldRequest,pairing_protocol:"single-code-v1"})).status,400,
    "an attacker cannot upgrade the old signed transcript by injecting an unsigned marker");
  assert.equal((await f.register({...req,pairing_protocol:"unknown-protocol"})).status,400);
  assert.equal([...f.rows.keys()].filter(k=>k.startsWith("pending:")).length,0);
  // A pre-migration pending record already stored in DO must fail closed,
  // even when it never reached the old pairing_prepare challenge step.
  const newValid=await f.register(req);
  assert.equal(newValid.status,202);
  const looked=await f.rpc("pairing_lookup",{code:old.code});
  const pending=f.rows.get("pending:"+req.code_verifier) as Record<string,unknown>;
  delete pending.pairing_protocol;
  assert.equal(pending.confirmation_hash,undefined);
  const result=await approvePendingKey(f.store as never,
    looked.object.pairing_id,looked.object.fingerprint,"permanent");
  assert.equal(result.status,409);
  assert.equal((result.body as {error:string}).error,"legacy_pairing_in_progress");
  assert.equal([...f.rows.keys()].filter(k=>k.startsWith("device:")).length,0);
});

test("#97 lost signed claim response preserves same Agent key, grant, ID and real SQLite guarded receipts",async()=>{
  const f=fixture(),material=newEnrollment("receipt-preserving-permanent");
  const directory=await mkdtemp(path.join(os.tmpdir(),"remote-v2-one-code-receipt-"));
  const keyPath=path.join(directory,"identity.pem");
  const databasePath=path.join(directory,"state");
  const receipts=new ReceiptStore(databasePath);
  const operationId="one-code-unknown-receipt-97";
  const digest=operationDigest("write_file",{path:"/tmp/rc-one-code-readonly-fixture"});
  try{
    await saveNewPrivateKey(keyPath,material.privateKeyPem);
    await receipts.open();
    assert.equal((await receipts.admit(operationId,"write_file",digest)).kind,"new");
    await receipts.update(operationId,"unknown","effect is uncertain");
    const before=await receipts.get(operationId);
    assert.equal(before?.state,"unknown");
    const originalPem=await readFile(keyPath,"utf8");
    assert.equal((await f.register(material.request)).status,202);
    const looked=await f.rpc("pairing_lookup",{code:material.code});
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);
    const approved=await f.rpc("pairing_approve",{
      pairing_id:String(looked.object.pairing_id),
      expected_fingerprint:String(looked.object.fingerprint),
      expected_grant_type:"permanent",
    });
    assert.equal(approved.object.status,"approved");
    const deviceId=String(approved.object.device_id);
    const grantKey="device:"+deviceId;
    const originalGrant=structuredClone(f.rows.get(grantKey));
    assert.equal((originalGrant as {grant_type:string}).grant_type,"permanent");
    let dropped=false;
    let consumedProof:Record<string,unknown>|undefined;
    const droppedOnce:typeof fetch=async(input,init)=>{
      const request=input instanceof Request?input:new Request(input,init);
      const isRecover=new URL(request.url).pathname==="/agent/session/recover";
      if(isRecover && !dropped) consumedProof=await request.clone().json() as Record<string,unknown>;
      const response=await f.send(request);
      if(isRecover && !dropped && response.status===200){
        dropped=true;
        throw new Error("simulated lost approved key proof response");
      }
      return response;
    };
    await assert.rejects(recoverDeviceId(f.origin,keyPath,droppedOnce),/simulated lost approved key proof response/);
    assert.equal(dropped,true);
    assert.equal(await readFile(keyPath,"utf8"),originalPem);
    await assert.rejects(readFile(keyPath+".device-id","utf8"),{code:"ENOENT"});
    assert.deepEqual(await receipts.get(operationId),before);
    assert.deepEqual(f.rows.get(grantKey),originalGrant);
    assert.equal((await authorizeSession(f.store as never,consumedProof)).status,401,
      "signed claim nonce cannot be replayed after the upstream reply is lost");
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),deviceId);
    assert.equal((await readFile(keyPath+".device-id","utf8")).trim(),deviceId);
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),deviceId);
    assert.equal(await readFile(keyPath,"utf8"),originalPem);
    assert.deepEqual(f.rows.get(grantKey),originalGrant);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,1);
    assert.deepEqual(await receipts.get(operationId),before);
    await receipts.close();
    const reopened=new ReceiptStore(databasePath);
    try{
      await reopened.open();
      assert.deepEqual(await reopened.get(operationId),before);
      const guard=await reopened.admit(operationId,"write_file",digest);
      assert.equal(guard.kind,"same");
      assert.equal(guard.receipt?.state,"unknown","an uncertain effect must never be re-executed by pairing retries");
    }finally{await reopened.close();}
  }finally{
    await receipts.close();
    await rm(directory,{recursive:true,force:true});
  }
});
