import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {registerSessionDevice} from '../src/session-device-registration.ts';
import type {WorkflowSessionAuthorization} from '../src/session-workflow-authorization.ts';
import type {V2Device} from '../src/v2-session.ts';

const attemptId='123e4567-e89b-42d3-a456-426614174001';
const decision=()=>({allowed:true as const,attempt_id:attemptId,github_run_id:112233,
  github_run_attempt:1,workflow_name:'ubuntu' as const,expires_at:Date.now()+120000});
function request(meta=decision()){
 const pair=generateKeyPairSync('ed25519');
 const public_key=Buffer.from(pair.publicKey.export({type:'spki',format:'der'}) as Buffer).toString('base64');
 const nonce=Buffer.from(randomBytes(18)).toString('base64url');
 const transcript='remote-control:github-session-enrollment:v1:'+
   [attemptId,meta.github_run_id,meta.github_run_attempt,meta.workflow_name,public_key,nonce].join(':');
 const proof=Buffer.from(sign(null,Buffer.from(transcript),pair.privateKey)).toString('base64');
 return {kind:'github_session' as const,attempt_id:attemptId,
   oidc_jwt:'signed-test-oidc-not-a-real-jwt-0123456789',public_key,nonce,proof};
}
function fixture(opts?:{initial?:Map<string,unknown>}){
 const rows=opts?.initial??new Map<string,unknown>();
 let lock:Promise<void>=Promise.resolve();
 const store={
  get:async (key:string)=>rows.get(key),
  put:async (key:string,value:unknown)=>{rows.set(key,value);},
  delete:async (key:string)=>rows.delete(key),
  list:async ({prefix,limit}:{prefix:string;limit:number})=>new Map([...rows]
    .filter(([key])=>key.startsWith(prefix)).slice(0,limit)),
  transaction:async <T>(f:(tx:unknown)=>Promise<T>):Promise<T>=>{
    let done!:()=>void;const preceding=lock;
    lock=new Promise<void>(resolve=>{done=resolve;});
    await preceding;try{return await f(store);}finally{done();}
  },
 };
 return {rows,store:store as unknown as DurableObjectStorage};
}

test('one reviewed physical Attempt gets exactly one durable Session device and idempotent recovery',async()=>{
 const {rows,store}=fixture();const meta=decision(),body=request(meta);
 let oauth=0,live=0;
 const auth:WorkflowSessionAuthorization={authorizeSessionAttempt:async input=>{
   if(input.oidc_jwt){oauth++;assert.equal(input.oidc_jwt,body.oidc_jwt);}else live++;
   return meta;
 }};
 const replies=await Promise.all(Array.from({length:12},()=>registerSessionDevice(store,body,auth)));
 const ids=replies.map(r=>(r.body as {device_id?:string}).device_id);
 assert.equal(new Set(ids).size,1);
 assert.equal(replies.filter(r=>r.status===201).length,1);
 assert.equal(replies.filter(r=>r.status===200).length,11);
 assert.equal(rows.size,1,'no separate Attempt ledger or growing index');
 assert.equal([...rows.keys()].filter(x=>x.startsWith('device:')).length,1);
 const device=rows.get('device:'+ids[0]) as V2Device;
 assert.equal(device.grant_type,'session');
 assert.equal(device.expires_at,meta.expires_at);
 assert.equal(device.session_attempt_id,attemptId);
 assert.equal(device.session_run_id,meta.github_run_id);
 assert.equal(oauth,12);assert.equal(live,12);
});

test('changed public key and Attempt metadata can never take over existing grant',async()=>{
 const {store}=fixture(),meta=decision(),body=request(meta);
 const auth={authorizeSessionAttempt:async()=>meta};
 const first=await registerSessionDevice(store,body,auth);
 assert.equal(first.status,201);
 assert.equal((await registerSessionDevice(store,request(meta),auth)).status,409);
 assert.equal((await registerSessionDevice(store,body,{authorizeSessionAttempt:async()=>({...meta,github_run_attempt:2})})).status,403);
});

test('signature substitution, missing OIDC and tampered body deny without storing devices',async()=>{
 const {store,rows}=fixture(),meta=decision(),body=request(meta);
 const auth={authorizeSessionAttempt:async()=>meta};
 for(const broken of [
  {...body,proof:request(meta).proof},
  {...body,nonce:'short'},
  {...body,oidc_jwt:''},
  {...body,grant_type:'permanent'},
  {...body,attempt_id:'bad'},
 ]) {
  const result=await registerSessionDevice(store,broken,auth);
  assert.ok(result.status>=400);
 }
 assert.equal(rows.size,0);
 assert.equal((await registerSessionDevice(store,body)).status,503);
});

test('cancellation after durable registration cannot falsely claim ready or grant future access',async()=>{
 const {rows,store}=fixture(),meta=decision(),body=request(meta);
 let reads=0;
 const auth={authorizeSessionAttempt:async()=>++reads===1?meta:{allowed:false}};
 const first=await registerSessionDevice(store,body,auth);
 assert.equal(first.status,403);
 assert.equal(rows.size,1,'the residual device is fail-closed after cross-store race');
 const repeat=await registerSessionDevice(store,body,{authorizeSessionAttempt:async()=>({allowed:false})});
 assert.equal(repeat.status,403);
});

test('unavailable Workflow and expired physical window fail closed',async()=>{
 const {rows,store}=fixture(),body=request();
 assert.equal((await registerSessionDevice(store,body,{authorizeSessionAttempt:async()=>{throw Error('unavailable');}})).status,503);
 assert.equal((await registerSessionDevice(store,body,{authorizeSessionAttempt:async()=>({...decision(),expires_at:Date.now()-1})})).status,403);
 assert.equal(rows.size,0);
});

test('existing public pairing ingress can register Session without exposing private Workflow RPC',async()=>{
 const {store,rows}=fixture(),meta=decision(),body=request(meta);
 const {V2OwnerCoordinator}=await import('../src/v2-pairing.ts');
 const {default:worker}=await import('../src/worker.ts');
 const owner=new V2OwnerCoordinator({storage:store,getWebSockets:()=>[]} as unknown as DurableObjectState,{
   WORKFLOW_SESSION_AUTHORIZATION:{authorizeSessionAttempt:async input=>{
      assert.equal(input.attempt_id,attemptId);
      return meta;
   }},
 });
 const env={MCP_ACCESS_TOKEN:'only-owner',DEVICE_COORDINATOR:{
   idFromName:()=> 'single-owner-v2',
   get:()=>({fetch:(input:RequestInfo|URL,init?:RequestInit)=>owner.fetch(
     input instanceof Request?input:new Request(input,init))}),
 }} as any;
 const response=await worker.fetch(new Request('https://rca.example/agent/pair/start',{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
 }),env);
 assert.equal(response.status,201);
 const result=await response.json() as {device_id:string};
 assert.equal((rows.get('device:'+result.device_id) as V2Device).grant_type,'session');
});
