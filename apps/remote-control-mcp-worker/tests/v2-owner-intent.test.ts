import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createPrivateKey,sign} from 'node:crypto';
import {newEnrollment} from '../agent/src/v2-enrollment.ts';
import {signedSessionProof} from '../agent/src/v2-session-client.ts';
import {ownerIntentTranscript,secureInputOwnerIntentTranscript,issueOwnerIntentChallenge,commitOwnerIntent} from '../src/v2-owner-intent.ts';
import {createSecureInputRecord,parseSecureInputRequest} from '../src/v2-secure-input.ts';
import {issueSessionChallenge,authorizeSocketSession,deviceIsAuthorized,listLiveGrants,listApprovedDevices} from '../src/v2-session.ts';
const DAY=86_400_000;
test('signed local Stop fences old WSS, duplicate Stop cannot renew, owner Resume grants fresh epoch only',async()=>{
 const initial=Date.now,id=randomUUID(),material=newEnrollment('owner-local');
 let now=1_820_000_000_000;Date.now=()=>now;
 try{
  const rows=new Map<string,unknown>([['device:'+id,{device_id:id,name:'owner-local',revoked:false,
   grant_type:'permanent',approved_at:now,public_key:material.request.public_key,
   fingerprint:'f'.repeat(24),last_verified_online_at:now,idle_window_ms:14*DAY}]]);
  const storage={get:async<T>(k:string)=>rows.get(k) as T,
   put:async(k:string,v:unknown)=>{rows.set(k,v)},delete:async(k:string)=>rows.delete(k),
   list:async<T>({prefix,limit}:{prefix:string;limit:number})=>new Map([...rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit)) as Map<string,T>};
  const store={...storage,transaction:async<T>(fn:(tx:typeof storage)=>Promise<T>)=>fn(storage)};
  const intent=async(action:'stop'|'resume')=>{
   const challenge=await issueOwnerIntentChallenge(store as never,{action,device_id:id});
   assert.equal(challenge.status,200);
   const c=challenge.body as {nonce:string;generation:number};
   const signature=Buffer.from(sign(null,Buffer.from(ownerIntentTranscript(action,id,c.nonce,c.generation,material.request.public_key)),
    createPrivateKey(material.privateKeyPem))).toString('base64url');
   const body={action,device_id:id,nonce:c.nonce,generation:c.generation,proof:signature};
   return {body,response:await commitOwnerIntent(store as never,body)};
  };
  const ch1=await issueSessionChallenge(store as never,{device_id:id});
  assert.equal(ch1.status,200);
  const nonce1=(ch1.body as {nonce:string}).nonce;
  const epoch1=await authorizeSocketSession(store as never,{device_id:id,nonce:nonce1,
   proof:signedSessionProof(material.privateKeyPem,id,nonce1).proof});
  assert.ok(epoch1);
  const stop=await intent('stop');assert.equal(stop.response.status,200);
  const expiry=(stop.response.body as {idle_expires_at:number}).idle_expires_at;
  assert.equal(deviceIsAuthorized(rows.get('device:'+id) as never),false);
  const visible=await listApprovedDevices({storage:store,getWebSockets:()=>[]} as unknown as DurableObjectState);
  assert.equal(visible.status,200);
  const ownerRow=(visible.body as Array<{owner_stopped?:boolean;status:string;idle_expires_at?:number}>)[0]!;
  assert.equal(ownerRow.owner_stopped,true);
  assert.equal(ownerRow.status,'offline');
  assert.equal(ownerRow.idle_expires_at,expiry);
  assert.equal((await issueSessionChallenge(store as never,{device_id:id})).status,404);
  assert.equal((await commitOwnerIntent(store as never,stop.body)).status,401,'replayed intent');
  const second=await intent('stop');assert.equal(second.response.status,200);
  assert.equal((second.response.body as {idle_expires_at:number}).idle_expires_at,expiry);
  now+=DAY;
  const resume=await intent('resume');assert.equal(resume.response.status,200);
  assert.equal(deviceIsAuthorized(rows.get('device:'+id) as never),false,'Resume alone cannot dispatch operations');
  const ch2=await issueSessionChallenge(store as never,{device_id:id});assert.equal(ch2.status,200);
  const nonce2=(ch2.body as {nonce:string}).nonce;
  const epoch2=await authorizeSocketSession(store as never,{device_id:id,nonce:nonce2,
   proof:signedSessionProof(material.privateKeyPem,id,nonce2).proof});
  assert.ok(epoch2);assert.notEqual(epoch1.epoch,epoch2.epoch);
  assert.equal(deviceIsAuthorized(rows.get('device:'+id) as never),true);
  assert.equal((rows.get('device:'+id) as {idle_expires_at?:number}).idle_expires_at,undefined);
  assert.equal((await commitOwnerIntent(store as never,stop.body)).status,401,'old intent cannot stop new epoch');
  await intent('stop');now+=14*DAY;
  assert.equal((await issueOwnerIntentChallenge(store as never,{action:'resume',device_id:id})).status,404);
  assert.equal((await listLiveGrants(store as never)).active.size,0);
 }finally{Date.now=initial;}
});

test('secure input Owner Intent binds the exact request and atomically consumes it once',async()=>{
 const initial=Date.now,ownerId=randomUUID(),targetId=randomUUID(),material=newEnrollment('secure-input-owner');
 let now=1_820_000_000_000;Date.now=()=>now;
 try{
  const owner={device_id:ownerId,name:'owner',revoked:false,grant_type:'permanent' as const,
   approved_at:now,public_key:material.request.public_key,fingerprint:'o'.repeat(24),
   last_verified_online_at:now,idle_window_ms:14*DAY};
  const target={device_id:targetId,name:'target',revoked:false,grant_type:'permanent' as const,
   approved_at:now,public_key:newEnrollment('secure-input-target').request.public_key,
   fingerprint:'t'.repeat(24),last_verified_online_at:now,idle_window_ms:14*DAY};
  const rows=new Map<string,unknown>([
   ['device:'+ownerId,owner],['device:'+targetId,target],['session:epoch:'+targetId,'target-epoch-1'],
  ]);
  const storage={get:async<T>(k:string)=>rows.get(k) as T,
   put:async(k:string,v:unknown)=>{rows.set(k,v)},delete:async(k:string)=>rows.delete(k),
   list:async<T>({prefix,limit}:{prefix:string;limit:number})=>new Map([...rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit)) as Map<string,T>};
  const store={...storage,transaction:async<T>(fn:(tx:typeof storage)=>Promise<T>)=>fn(storage)};
  const parsed=parseSecureInputRequest({
   purpose:'Set a staging deployment secret',
   execution:{device_id:targetId},
   target:{kind:'github_repository_secret',repository:'lirtual/mcp-workers',name:'DEPLOY_TOKEN'},
  });
  assert.ok(parsed);
  const record=await createSecureInputRecord(store as never,parsed,'user_owner',{
   device_id:targetId,epoch:'target-epoch-1',grant_type:'permanent',
  },{provider:'github',identity:'lirtual',repository:'lirtual/mcp-workers',permission:'admin'},now);
  const challenge=await issueOwnerIntentChallenge(store as never,{
   action:'secure_input',device_id:ownerId,request_id:record.request_id,
  });
  assert.equal(challenge.status,200);
  const c=challenge.body as {nonce:string;generation:number;target_binding:string};
  const proof=Buffer.from(sign(null,Buffer.from(secureInputOwnerIntentTranscript(
   record.request_id,ownerId,c.generation,c.target_binding,c.nonce,true,true,owner.public_key,
  )),createPrivateKey(material.privateKeyPem))).toString('base64url');
  const input={action:'secure_input',device_id:ownerId,request_id:record.request_id,
   nonce:c.nonce,generation:c.generation,target_confirmed:true,production_authorized:true,proof,secret:'one-time-value'};
  const nonProductionProof=Buffer.from(sign(null,Buffer.from(secureInputOwnerIntentTranscript(
   record.request_id,ownerId,c.generation,c.target_binding,c.nonce,true,false,owner.public_key,
  )),createPrivateKey(material.privateKeyPem))).toString('base64url');
  const denied=await commitOwnerIntent(store as never,{...input,production_authorized:false,proof:nonProductionProof});
  assert.equal(denied.status,401);
  assert.equal((rows.get('secure-input:'+record.request_id) as {state:string}).state,'pending');
  const committed=await commitOwnerIntent(store as never,input);
  assert.equal(committed.status,200);
  assert.deepEqual(committed.body,{status:'unknown',request_id:record.request_id});
  assert.equal(committed.secureInput?.secret,'one-time-value');
  const stored=rows.get('secure-input:'+record.request_id) as Record<string,unknown>;
  assert.equal(stored.state,'unknown');
  assert.equal(typeof stored.consumed_at,'number');
  assert.equal(typeof stored.production_authorized_at,'number');
  assert.equal(Object.hasOwn(stored,'secret'),false);
  assert.equal(Object.hasOwn(stored,'secret_digest'),false);
  assert.equal((await commitOwnerIntent(store as never,input)).status,401);
 }finally{Date.now=initial;}
});

test('secure input intent refuses a changed target epoch before consuming the request',async()=>{
 const initial=Date.now,ownerId=randomUUID(),targetId=randomUUID(),material=newEnrollment('secure-input-owner');
 let now=1_820_000_000_000;Date.now=()=>now;
 try{
  const owner={device_id:ownerId,name:'owner',revoked:false,grant_type:'permanent' as const,
   approved_at:now,public_key:material.request.public_key,fingerprint:'o'.repeat(24),
   last_verified_online_at:now,idle_window_ms:14*DAY};
  const target={device_id:targetId,name:'target',revoked:false,grant_type:'permanent' as const,
   approved_at:now,public_key:newEnrollment('secure-input-target').request.public_key,
   fingerprint:'t'.repeat(24),last_verified_online_at:now,idle_window_ms:14*DAY};
  const rows=new Map<string,unknown>([['device:'+ownerId,owner],['device:'+targetId,target],
   ['session:epoch:'+targetId,'target-epoch-1']]);
  const storage={get:async<T>(k:string)=>rows.get(k) as T,
   put:async(k:string,v:unknown)=>{rows.set(k,v)},delete:async(k:string)=>rows.delete(k),
   list:async<T>({prefix,limit}:{prefix:string;limit:number})=>new Map([...rows].filter(([k])=>k.startsWith(prefix)).slice(0,limit)) as Map<string,T>};
  const store={...storage,transaction:async<T>(fn:(tx:typeof storage)=>Promise<T>)=>fn(storage)};
  const parsed=parseSecureInputRequest({purpose:'Rotate a test secret',execution:{device_id:targetId},
   target:{kind:'task_process',session_id:targetId,name:'DEPLOY_TOKEN'}});
  assert.ok(parsed);
  const record=await createSecureInputRecord(store as never,parsed,'user_owner',{
   device_id:targetId,epoch:'target-epoch-1',grant_type:'permanent',
  },undefined,now);
  const challenge=await issueOwnerIntentChallenge(store as never,{action:'secure_input',device_id:ownerId,request_id:record.request_id});
  assert.equal(challenge.status,200);
  const c=challenge.body as {nonce:string;generation:number;target_binding:string};
  const proof=Buffer.from(sign(null,Buffer.from(secureInputOwnerIntentTranscript(
   record.request_id,ownerId,c.generation,c.target_binding,c.nonce,true,true,owner.public_key,
  )),createPrivateKey(material.privateKeyPem))).toString('base64url');
  rows.set('session:epoch:'+targetId,'target-epoch-2');
  const result=await commitOwnerIntent(store as never,{action:'secure_input',device_id:ownerId,
   request_id:record.request_id,nonce:c.nonce,generation:c.generation,
   target_confirmed:true,production_authorized:true,proof,secret:'value'});
  assert.equal(result.status,409);
  assert.equal((rows.get('secure-input:'+record.request_id) as {state:string}).state,'pending');
 }finally{Date.now=initial;}
});
