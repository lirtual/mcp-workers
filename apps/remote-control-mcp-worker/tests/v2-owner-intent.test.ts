import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createPrivateKey,sign} from 'node:crypto';
import {newEnrollment} from '../../remote-control-agent/src/v2-enrollment.ts';
import {signedSessionProof} from '../../remote-control-agent/src/v2-session-client.ts';
import {ownerIntentTranscript,issueOwnerIntentChallenge,commitOwnerIntent} from '../src/v2-owner-intent.ts';
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
