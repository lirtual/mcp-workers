import assert from "node:assert/strict";
import {createHash,createPrivateKey,sign} from "node:crypto";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {exportJWK,generateKeyPair,SignJWT} from "jose";
import {newEnrollment, saveNewPrivateKey} from "./fixtures/device-protocol.ts";
import {recoverDeviceId, signedSessionProof} from "./fixtures/device-protocol.ts";
import {seedUnknownReceipt} from "../agent/tests/fixtures/receipt-ledger.ts";
import {DatabaseSync} from "node:sqlite";
import worker from "../src/worker.ts";
import { OwnerCoordinator } from "../src/pairing.ts";
import {approvalArgs, lookupOwnerPairing, approveOwnerPairing} from "../src/pairing-owner.ts";
import {approvePendingKey} from "../src/pairing.ts";
import {TEMPORARY_GRANT_MS, issueSessionChallenge, authorizeSession, authorizeSocketSession} from "../src/session.ts";
import {createSecureInputRecord, parseSecureInputRequest} from "../src/secure-input.ts";

function fixture(browser=false) {
  let dropApprovalReply=false;
  let dispatches=0;
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
  const owner = new OwnerCoordinator({storage:store} as unknown as DurableObjectState);
  const DEVICE_COORDINATOR = {
    idFromName() {return "single-owner";},
    get() {return {fetch:async(input:RequestInfo|URL,init?:RequestInit) => {
      dispatches++;
      const request=input instanceof Request ? input : new Request(input,init);
      const response=await owner.fetch(request);
      if(dropApprovalReply&&new URL(request.url).pathname==="/approve"&&response.ok){
        dropApprovalReply=false;throw Error("simulated lost approval reply");
      }
      return response;
    }};},
  } as unknown as DurableObjectNamespace;
  const env = {MCP_ACCESS_TOKEN:"owner-test-credential",DEVICE_COORDINATOR,
    REMOTE_CONTROL_DEVICE_TOKEN:"legacy-v1-fixture",
    ...(browser?{CLERK_OWNER_USER_ID:"user_fixture",CLERK_PUBLISHABLE_KEY:"pk_live_"+Buffer.from("clerk.lirtual.dpdns.org$").toString("base64")}:{} )} as unknown as Env;
  const origin=browser?"https://rca.lirtual.dpdns.org/":"https://pairing.test/";
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
  // Protocol/lifecycle scenarios exercise the same owner adapter and real
  // coordinator without coupling to an authentication ingress. Browser HTTP
  // authentication and retired MCP ingress are covered separately below.
  const ownerStub=DEVICE_COORDINATOR.get(DEVICE_COORDINATOR.idFromName("single-owner"));
  const parsed=async(response:Response)=>({response,object:await response.json() as Record<string,unknown>});
  const lookup=async({code}:{code:string})=>parsed(await lookupOwnerPairing(ownerStub,code));
  const approve=async(input:object)=>{
    const args=approvalArgs(input);
    assert.ok(args);
    return parsed(await approveOwnerPairing(ownerStub,args));
  };
  const register=async(request:object)=>send(origin+"agent/pair/start",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request),
  });
  return {rows,store,send,rpc,lookup,approve,register,origin,dispatches:()=>dispatches,dropApprovalReply:()=>{dropApprovalReply=true;}};
}

test("#97 explicit owner approval is separate from lookup and Agent claims by existing signed recovery",async()=>{
  const f=fixture(), pending=newEnrollment("one-code-host");
  const dir=await mkdtemp(path.join(os.tmpdir(),"remote-one-code-"));
  const keyPath=path.join(dir,"identity.pem");
  try {
    await saveNewPrivateKey(keyPath,pending.privateKeyPem);
    assert.equal((await f.register(pending.request)).status,202);
    const looked=await f.lookup({code:pending.code});
    const pairingId=String(looked.object.pairing_id),fingerprint=String(looked.object.fingerprint);
    assert.match(pairingId,/^[a-f0-9-]{36}$/);
    assert.equal(looked.object.grant_type,"permanent");
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);

    const wrong=await f.approve({
      pairing_id:pairingId,expected_fingerprint:"0".repeat(24),expected_grant_type:"permanent",
    });
    assert.equal(wrong.object.status,undefined);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);
    const mode=await f.approve({
      pairing_id:pairingId,expected_fingerprint:fingerprint,expected_grant_type:"temporary",
    });
    assert.equal(mode.object.status,undefined);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);

    const approved=await f.approve({
      pairing_id:pairingId,expected_fingerprint:fingerprint,expected_grant_type:"permanent",
    });
    assert.equal(approved.object.status,"approved");
    const deviceId=String(approved.object.device_id);
    assert.match(deviceId,/^[a-f0-9-]{36}$/);
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,1);
    assert.equal(f.rows.has("pending:"+pending.request.code_verifier),false);
    assert.equal((await f.lookup({code:pending.code})).object.status,undefined);
    assert.equal((await f.approve({
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

test("#76 lost original pending HTTP reply retries same Ed25519 key, invalidates old code and signs one grant",async()=>{
  const f=fixture(), initial=newEnrollment("lost-reply-agent");
  const dir=await mkdtemp(path.join(os.tmpdir(),"real-do-retry-"));
  const keyPath=path.join(dir,"identity.pem");
  try{
    await saveNewPrivateKey(keyPath,initial.privateKeyPem);
    // The backend accepted the first request, but the caller cannot observe
    // the response. No owner approval was performed.
    assert.equal((await f.register(initial.request)).status,202);
    assert.equal([...f.rows.keys()].filter(k=>k.startsWith("device:")).length,0);
    const retried=newEnrollment("lost-reply-agent",await readFile(keyPath,"utf8"));
    assert.notEqual(retried.code,initial.code);
    assert.equal(retried.request.public_key,initial.request.public_key);
    assert.equal((await f.register(retried.request)).status,202);
    assert.equal([...f.rows.keys()].filter(k=>k.startsWith("pending:")).length,1);
    assert.equal(f.rows.has("pending:"+initial.request.code_verifier),false);
    assert.equal(f.rows.has("pending:"+retried.request.code_verifier),true);
    assert.equal((await f.lookup({code:initial.code})).object.status,undefined);
    const looked=await f.lookup({code:retried.code});
    const pairingId=String(looked.object.pairing_id);
    const fingerprint=String(looked.object.fingerprint);
    assert.equal(looked.object.grant_type,"permanent");
    assert.ok(pairingId.length>30 && fingerprint.length===24);
    assert.equal([...f.rows.keys()].filter(k=>k.startsWith("device:")).length,0);
    const approved=await f.approve({
      pairing_id:pairingId,expected_fingerprint:fingerprint,
      expected_grant_type:"permanent",
    });
    assert.equal(approved.object.status,"approved");
    const approvedId=String(approved.object.device_id);
    assert.equal([...f.rows.keys()].filter(k=>k.startsWith("device:")).length,1);
    assert.equal([...f.rows.keys()].filter(k=>k.startsWith("pending:")).length,0);
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),approvedId);
    assert.equal((await readFile(keyPath+".device-id","utf8")).trim(),approvedId);
    assert.equal(await readFile(keyPath,"utf8"),initial.privateKeyPem);
    assert.equal((await f.approve({
      pairing_id:pairingId,expected_fingerprint:fingerprint,
      expected_grant_type:"permanent",
    })).object.status,undefined);
    assert.equal([...f.rows.keys()].filter(k=>k.startsWith("device:")).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("#97 temporary owner approval binds exact grant and fixed server expiry",async()=>{
  const f=fixture(),pending=newEnrollment("temp-approval",undefined,"temporary");
  assert.equal((await f.register(pending.request)).status,202);
  const looked=await f.lookup({code:pending.code});
  assert.equal(looked.object.grant_type,"temporary");
  const args={pairing_id:String(looked.object.pairing_id),
    expected_fingerprint:String(looked.object.fingerprint),expected_grant_type:"temporary"};
  const approved=await f.approve(args);
  assert.equal(approved.object.status,"approved");
  const record=f.rows.get("device:"+approved.object.device_id) as
    {approved_at:number;expires_at:number;grant_type:string};
  assert.equal(record.grant_type,"temporary");
  assert.equal(record.expires_at-record.approved_at,TEMPORARY_GRANT_MS);
});

test("#97 pending legacy two-code preparation cannot be upgraded into approval",async()=>{
  const f=fixture(),material=newEnrollment("old-flow");
  assert.equal((await f.register(material.request)).status,202);
  const lookup=await f.lookup({code:material.code});
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
  const found=await f.lookup({code:pending.code});
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
  const lookup=await f.lookup({code:material.code});
  const id=String(lookup.object.pairing_id),fp=String(lookup.object.fingerprint);
  assert.equal((await approvePendingKey(f.store as never,
    "00000000-0000-4000-8000-000000000000",fp,"permanent")).status,404);
  assert.equal((await approvePendingKey(f.store as never,id,"z".repeat(24),"permanent")).status,400);
  assert.equal((await approvePendingKey(f.store as never,id,fp,"temporary")).status,409);
  // Simulate the server-side clock passing the pending lifetime; DO controls it.
  const pending=f.rows.get("pending:"+material.request.code_verifier) as {expires_at:number};
  pending.expires_at=Date.now()-1;
  assert.equal((await f.lookup({code:material.code})).object.pairing_id,undefined);
  assert.equal((await approvePendingKey(f.store as never,id,fp,"permanent")).status,404);
  assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);
});

test("#97 a legacy approved key without grant_type keeps signed WSS authority after a new one-code approval",async()=>{
  const f=fixture(),old=newEnrollment("approved-before-migration");
  const oldId="7e8855e2-e5d8-4bce-a11e-1833e9a0e6b0";
  f.rows.set("device:"+oldId,{
    device_id:oldId,name:"approved-before-migration",public_key:old.request.public_key,
    fingerprint:"9".repeat(24),approved_at:Date.now()-7200_000,revoked:false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000,
    // Historical device records do not have grant_type.
  });
  const incoming=newEnrollment("new-one-code-device");
  assert.equal((await f.register(incoming.request)).status,202);
  const looked=await f.lookup({code:incoming.code});
  const result=await f.approve({
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
  const looked=await f.lookup({code:old.code});
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
  const directory=await mkdtemp(path.join(os.tmpdir(),"one-code-receipt-"));
  const keyPath=path.join(directory,"identity.pem");
  const databasePath=path.join(directory,"state","operation-receipts.sqlite");
  const operationId="one-code-unknown-receipt-97";
  const digest=createHash("sha256").update('{"arguments":{"path":"/tmp/rc-one-code-readonly-fixture"},"tool":"write_file"}').digest("hex");
  try{
    await saveNewPrivateKey(keyPath,material.privateKeyPem);
    seedUnknownReceipt(databasePath,operationId,"write_file",digest,new Date().toISOString(),"effect is uncertain");
    const before=await readFile(databasePath);
    const originalPem=await readFile(keyPath,"utf8");
    assert.equal((await f.register(material.request)).status,202);
    const looked=await f.lookup({code:material.code});
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,0);
    const approved=await f.approve({
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
    assert.deepEqual(await readFile(databasePath),before);
    const withoutLease = (row: Record<string,unknown>) => (({ idle_expires_at, idle_window_ms, ...rest }) => rest)(row);
    assert.deepEqual(withoutLease(f.rows.get(grantKey) as Record<string,unknown>), withoutLease(originalGrant as Record<string,unknown>));
    assert.ok(Number.isSafeInteger((f.rows.get(grantKey) as {idle_expires_at:number}).idle_expires_at));
    assert.equal((await authorizeSession(f.store as never,consumedProof)).status,401,
      "signed claim nonce cannot be replayed after the upstream reply is lost");
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),deviceId);
    assert.equal((await readFile(keyPath+".device-id","utf8")).trim(),deviceId);
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),deviceId);
    assert.equal(await readFile(keyPath,"utf8"),originalPem);

    assert.deepEqual(withoutLease(f.rows.get(grantKey) as Record<string,unknown>), withoutLease(originalGrant as Record<string,unknown>));
    assert.ok(Number.isSafeInteger((f.rows.get(grantKey) as {idle_expires_at:number}).idle_expires_at));
    assert.equal([...f.rows.keys()].filter(key=>key.startsWith("device:")).length,1);
    assert.deepEqual(await readFile(databasePath),before);
    // The Worker fixture cannot execute an Agent operation. Verify that the
    // historical guarded row is intact; native receipt_contract tests prove
    // same-intent deduplication and restart behavior in the actual runtime.
    const reopened=new DatabaseSync(databasePath,{readOnly:true});
    try{
      assert.deepEqual({...reopened.prepare("SELECT state,argument_digest,guarded FROM receipts WHERE operation_id=?").get(operationId)},
        {state:"unknown",argument_digest:digest,guarded:1});
    }finally{reopened.close();}
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});

test("#1018/#1039 actual Worker browser authorization preserves enrollment and cancels secure input",async t=>{
  const f=fixture(true),origin=f.origin.slice(0,-1);
  const issuer="https://clerk.lirtual.dpdns.org";
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  const other=await generateKeyPair("RS256");
  const jwk={...await exportJWK(publicKey),kid:"browser-fixture-key",alg:"RS256",use:"sig"};
  let keyRequests=0;
  let keyResponse:()=>Response=()=>Response.json({keys:[jwk]});
  t.mock.method(globalThis,"fetch",async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(String(input),issuer+"/.well-known/jwks.json");
    assert.equal(init?.redirect,"manual");
    keyRequests++;return keyResponse();
  });
  const mint=(extra:Record<string,unknown>={},key=privateKey,typ="JWT",kid=jwk.kid)=>{
    const now=Math.floor(Date.now()/1000);
    return new SignJWT({iss:issuer,sub:"user_fixture",azp:origin,sid:"sess_fixture",v:2,iat:now,nbf:now-5,exp:now+60,...extra})
      .setProtectedHeader({alg:"RS256",typ,kid}).sign(key);
  };
  const token=await mint(); // actual accepted Clerk profile does not require jti
  const post=(path:string,body:unknown,bearer=token,requestOrigin:string|null=origin)=>{
    const h=new Headers({"content-type":"application/json",authorization:"Bearer "+bearer});
    if(requestOrigin!==null)h.set("origin",requestOrigin);
    return f.send(origin+path,{method:"POST",headers:h,body:JSON.stringify(body)});
  };
  const count=()=>[...f.rows.keys()].filter(k=>k.startsWith("device:")).length;
  const before=f.dispatches();
  const page=await f.send(origin+"/pair?utm_source=chatgpt.com");
  assert.equal(page.status,200);
  assert.equal(page.headers.get("cache-control"),"no-store");
  assert.match(page.headers.get("content-security-policy")??"",/frame-ancestors 'none'/);
  const html=await page.text();
  assert.match(html,/location.hash\|\|location.search/);
  assert.match(html,/accounts\.lirtual\.dpdns\.org\/sign-in\?redirect_url=/);
  assert.doesNotMatch(html,/user_fixture|owner-test-credential|utm_source/);
  assert.equal((await f.send("https://other.example/pair")).status,404);
  assert.equal((await f.send(origin+"/pair/approve")).status,405);
  assert.equal((await fixture().send(origin+"/pair")).status,404);
  assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},"owner-test-credential")).status,401);
  assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},token,null)).status,403);
  assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},token,"https://other.example")).status,403);
  assert.equal((await f.send(origin+"/pair/lookup",{method:"POST",headers:{origin,cookie:"__session=fixture"}})).status,401);
  assert.equal(f.dispatches(),before);
  const pending=newEnrollment("<img src=x onerror=alert(1)>",undefined,"temporary");
  assert.equal((await f.register(pending.request)).status,202);
  const beforeDenials=f.dispatches();
  for(const overrides of [
    {sub:"user_other"},{azp:"https://other.example"},{azp:undefined},{v:1},{sid:undefined},
    {sts:"pending"},{act:{sub:"user_other"}},{aud:"client",scope:"openid",client_id:"client"},
    {iss:"https://other.example"},{exp:Math.floor(Date.now()/1000)-10},
    {exp:Math.floor(Date.now()/1000)+120},{sub:"mch_fixture",sid:undefined},
  ]) assert.equal((await post("/pair/lookup",{code:pending.code},await mint(overrides))).status,401);
  assert.equal((await post("/pair/lookup",{code:pending.code},await mint({},other.privateKey))).status,401);
  assert.equal((await post("/pair/lookup",{code:pending.code},await mint({},privateKey,"at+jwt"))).status,401);
  assert.equal((await post("/pair/lookup",{code:"x".repeat(5000)})).status,400);
  assert.equal(f.dispatches(),beforeDenials);
  assert.equal((await f.rpc("pairing_lookup",{code:pending.code},token)).response.status,401);
  assert.equal((await post("/agent/pair/start",pending.request)).status,405);
  const looked=await post("/pair/lookup",{code:pending.code});
  assert.equal(looked.status,200);
  const detail=await looked.json() as Record<string,unknown>;
  assert.equal(detail.name,"<img src=x onerror=alert(1)>");
  assert.equal(detail.grant_type,"temporary");
  assert.deepEqual(Object.keys(detail).sort(),["expires_at","fingerprint","grant_type","name","pairing_id"]);
  assert.equal(count(),0);
  const args={pairing_id:detail.pairing_id,expected_fingerprint:detail.fingerprint,expected_grant_type:detail.grant_type};
  assert.equal((await post("/pair/approve",{...args,expected_fingerprint:"0".repeat(24)})).status,404);
  assert.equal((await post("/pair/approve",{...args,expected_grant_type:"permanent"})).status,409);
  assert.equal(count(),0);
  const beforeRetired=f.dispatches();
  assert.equal((await f.rpc("pairing_lookup",{code:pending.code})).object.pairing_id,undefined);
  assert.equal((await f.rpc("pairing_approve",args)).object.status,undefined);
  assert.equal(f.dispatches(),beforeRetired);
  assert.equal(count(),0);
  const results=await Promise.all([post("/pair/approve",args),post("/pair/approve",args)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,404]);
  assert.equal(count(),1);
  const id=[...f.rows.keys()].find(k=>k.startsWith("device:"))!.slice(7);
  const row=f.rows.get("device:"+id) as {grant_type:string;approved_at:number;expires_at:number};
  assert.equal(row.grant_type,"temporary");
  assert.equal(row.expires_at-row.approved_at,TEMPORARY_GRANT_MS);
  const dir=await mkdtemp(path.join(os.tmpdir(),"rca-browser-claim-"));
  try{
    const keyPath=path.join(dir,"identity.pem");
    await saveNewPrivateKey(keyPath,pending.privateKeyPem);
    assert.equal(await recoverDeviceId(f.origin,keyPath,f.send),id);
  }finally{await rm(dir,{recursive:true,force:true});}
  assert.equal((await post("/pair/approve",args)).status,404);
  assert.equal(count(),1);
  const pending2=newEnrollment("lost-browser-reply");
  assert.equal((await f.register(pending2.request)).status,202);
  const detail2=await (await post("/pair/lookup",{code:pending2.code})).json() as Record<string,unknown>;
  const args2={pairing_id:detail2.pairing_id,expected_fingerprint:detail2.fingerprint,expected_grant_type:detail2.grant_type};
  f.dropApprovalReply();
  assert.equal((await post("/pair/approve",args2)).status,503);
  assert.equal(count(),2);
  assert.equal([...f.rows.entries()].filter(([k])=>k.startsWith("device:")).map(([,v])=>(v as {grant_type:string}).grant_type).sort().join(","),"permanent,temporary");
  assert.equal((await post("/pair/approve",args2)).status,404);
  assert.equal(count(),2);
  // Reuse the real Clerk verifier and coordinator, with only synthetic
  // identity/metadata and the same isolated transactional store.
  const deviceId=crypto.randomUUID();
  const request=parseSecureInputRequest({
    purpose:"Synthetic cancellation",is_production:false,execution:{device_id:deviceId},
    target:{kind:"task_process",session_id:crypto.randomUUID(),name:"SYNTHETIC_INPUT"},
  });
  assert.ok(request);
  const input=await createSecureInputRecord(f.store as never,request,"user_fixture",{
    device_id:deviceId,epoch:"fixture-epoch",grant_type:"permanent",
  });
  const route="/secure-input/"+input.request_id;
  const inputPage=await f.send(origin+route);
  assert.equal(inputPage.status,200);
  assert.match(inputPage.headers.get("cache-control")??"",/no-store/);
  assert.equal(inputPage.headers.get("referrer-policy"),"no-referrer");
  assert.match(inputPage.headers.get("content-security-policy")??"",/frame-ancestors 'none'/);
  assert.equal((await post(route+"/details",{})).status,200);
  const beforeCancel=f.dispatches();
  assert.equal((await post(route+"/cancel",{},await mint({sub:"user_other"}))).status,401);
  assert.equal((await post(route+"/cancel",{},token,"https://other.example")).status,403);
  assert.equal((await f.send("https://other.example"+route+"/cancel",{
    method:"POST",headers:{origin,authorization:"Bearer "+token,"content-type":"application/json"},body:"{}",
  })).status,403);
  assert.equal((await post(route+"/cancel",{unexpected:true})).status,400);
  assert.equal((await f.send(origin+route+"/cancel",{
    method:"POST",headers:{origin,authorization:"Bearer "+token,"content-type":"text/plain"},body:"{}",
  })).status,415);
  assert.equal(f.dispatches(),beforeCancel);
  assert.equal((await post(route+"/cancel",{})).status,200);
  const cancelled=await (await post(route+"/details",{})).json() as {state:string};
  assert.equal(cancelled.state,"cancelled");
  assert.equal((await post(route+"/cancel",{})).status,409);
  const marker="synthetic-cancelled-input-1039";
  const rejected=await post(route+"/submit",{secret:marker,target_confirmed:true,production_authorized:false});
  assert.equal(rejected.status,409);
  assert.doesNotMatch(await rejected.text(),new RegExp(marker));
  assert.doesNotMatch(JSON.stringify([...f.rows.values()]),new RegExp(marker));
  assert.match(await inputPage.text(),/Cancel request/);
  assert.equal(keyRequests,1);

  // Exercise the real configured verifier and jose's existing JWKS cache
  // without adding a refresh service or waiting for wall-clock cooldown.
  const rotated={...await exportJWK(other.publicKey),kid:"rotated-fixture-key",alg:"RS256",use:"sig"};
  const rotatedToken=await mint({},other.privateKey,"JWT",rotated.kid);
  const absentToken=await mint({},privateKey,"JWT","unknown-fixture-key");
  keyResponse=()=>Response.json({keys:[rotated]});
  assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},rotatedToken)).status,401);
  assert.equal(keyRequests,1,"unknown kid fails closed within existing cooldown");
  const now=Date.now();
  const time=t.mock.method(Date,"now",()=>now+31_000);
  try{
    assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},rotatedToken)).status,404,
      "after rotation, valid Owner token reaches the nonexistent pairing lookup");
    assert.equal(keyRequests,2);
    assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},token)).status,401,
      "removed key must not authenticate");
    time.mock.mockImplementation(()=>now+62_000);
    keyResponse=()=>new Response(null,{status:503});
    assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},absentToken)).status,401);
    assert.equal(keyRequests,3);
    keyResponse=()=>new Response(null,{status:302,headers:{location:"https://example.invalid/jwks"}});
    assert.equal((await post("/pair/lookup",{code:"AAAAAAAAAA"},absentToken)).status,401);
    assert.equal(keyRequests,4);
    assert.equal(count(),2);
  }finally{time.mock.restore();}
});
