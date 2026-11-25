import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createPublicKey,createPrivateKey,verify} from 'node:crypto';
import {newEnrollment} from '../src/v2-enrollment.ts';
import {getSecureInputOwnerChallenge,sendSignedSecureInputOwnerIntent,secureInputOwnerIntentProof,
 sendSignedOwnerIntent,signedOwnerIntentProof,verifyPermanentOwnerStopChallenge} from '../src/v2-session-client.ts';

test('explicit local owner Stop/Resume uses distinct fresh Ed25519 domain, not WSS proof',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'rca666-signed-'));
 try{
  const id=randomUUID(),identity=newEnrollment('owner');
  const key=path.join(directory,'id.pem');
  await writeFile(key,identity.privateKeyPem,{mode:0o600});
  await writeFile(key+'.device-id',id,{mode:0o600});
  const generation=2,nonce='A'.repeat(24),calls:string[]=[];
  const mock=async(input:string|URL|Request,init?:RequestInit)=>{
   const route=new URL(String(input)).pathname;
   calls.push(route);
   const body=JSON.parse(String(init?.body));
   if(route==='/agent/owner/intent/challenge'){
    assert.deepEqual(body,{action:'stop',device_id:id});
    return Response.json({device_id:id,action:'stop',nonce,generation});
   }
   assert.equal(route,'/agent/owner/intent');
   assert.deepEqual(Object.keys(body).sort(),['action','device_id','generation','nonce','proof']);
   const publicKey=createPublicKey(createPrivateKey(identity.privateKeyPem));
   const message=`remote-control:v2:owner-intent:v1:stop:${id}:${generation}:${nonce}:${identity.request.public_key}`;
   assert.equal(verify(null,Buffer.from(message),publicKey,Buffer.from(body.proof,'base64url')),true);
   assert.notEqual(body.proof,signedOwnerIntentProof(identity.privateKeyPem,'resume',id,nonce,generation));
   return Response.json({device_id:id,status:'stopped',idle_expires_at:Date.now()+14*86_400_000});
  };
  const result=await sendSignedOwnerIntent('https://rca.example.test/',key,'stop',mock as typeof fetch);
  assert.equal(result.status,'stopped');
  assert.deepEqual(calls,['/agent/owner/intent/challenge','/agent/owner/intent']);
  await assert.rejects(sendSignedOwnerIntent('http://evil.example/',key,'stop',mock as typeof fetch));
 }finally{await rm(directory,{recursive:true,force:true});}
});


test("legacy mode verifies permanent-only challenge without signed Stop/Resume mutation",async()=>{
  const id=randomUUID(),origin="https://rca.example.test/";
  const accepted={device_id:id,action:"stop",nonce:"A".repeat(24),generation:1};
  let calls=0;
  const mock=async(input:string|URL|Request,init?:RequestInit)=>{
    assert.equal(new URL(String(input)).pathname,"/agent/owner/intent/challenge");
    assert.deepEqual(JSON.parse(String(init?.body)),{action:"stop",device_id:id});
    assert.equal(init?.redirect,"error");
    calls++;
    return Response.json(accepted);
  };
  await verifyPermanentOwnerStopChallenge(origin,id,mock as typeof fetch);
  assert.equal(calls,1);
  for(const response of [
    {status:404,body:{error:"not_found"}},
    {status:503,body:{error:"unavailable"}},
    {status:200,body:{...accepted,device_id:randomUUID()}},
    {status:200,body:{...accepted,action:"resume"}},
    {status:200,body:{...accepted,nonce:"not-a-nonce"}},
    {status:200,body:{...accepted,generation:-1}},
  ]){
    const stub=async()=>Response.json(response.body,{status:response.status});
    await assert.rejects(verifyPermanentOwnerStopChallenge(origin,id,stub as typeof fetch));
  }
  await assert.rejects(verifyPermanentOwnerStopChallenge("https://evil.test/path",id,mock as typeof fetch));
  await assert.rejects(verifyPermanentOwnerStopChallenge(origin,"bad-id",mock as typeof fetch));
});


test("secure input CLI uses request-bound Owner Intent and sends the secret only in the commit body",async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"rca666-secure-owner-"));
 try{
  const ownerId=randomUUID(),requestId=randomUUID(),targetId=randomUUID(),identity=newEnrollment("owner");
  const key=path.join(directory,"id.pem");
  await writeFile(key,identity.privateKeyPem,{mode:0o600});
  await writeFile(key+".device-id",ownerId,{mode:0o600});
  const nonce="N".repeat(24),generation=5,binding="a".repeat(64),secret="synthetic-secret-never-log";
  const challenge={
   action:"secure_input",device_id:ownerId,request_id:requestId,nonce,generation,
   expires_at:Date.now()+60_000,target_binding:binding,purpose:"Test credential input",
   target:{kind:"github_repository_secret",repository:"owner/repo",name:"API_TOKEN"},
   execution:{device_id:targetId,grant_type:"session",session_run_id:"run-1",
     session_run_attempt:2,session_attempt_id:randomUUID(),session_workflow_name:"Test",expires_at:Date.now()+300_000},
   provider_principal:{provider:"github",identity:"owner",repository:"owner/repo",permission:"admin"},
   is_production:true,
  };
  const calls:string[]=[];
  const mock=async(input:string|URL|Request,init?:RequestInit)=>{
   const route=new URL(String(input)).pathname; calls.push(route);
   const body=JSON.parse(String(init?.body));
   assert.equal(init?.redirect,"error");
   if(route==="/agent/owner/intent/challenge"){
     assert.deepEqual(body,{action:"secure_input",device_id:ownerId,request_id:requestId});
     return Response.json(challenge);
   }
   assert.equal(route,"/agent/owner/intent");
   assert.deepEqual(Object.keys(body).sort(),[
     "action","device_id","generation","nonce","production_authorized","proof","request_id",
     "secret","target_confirmed",
   ]);
   assert.equal(body.secret,secret);
   assert.equal(body.target_confirmed,true);
   assert.equal(body.production_authorized,true);
   const transcript="remote-control:v2:secure-input-owner-intent:v1:"+requestId+":"+ownerId+":"+generation+":"+binding+":"+nonce+":1:1:"+identity.request.public_key;
   assert.equal(verify(null,Buffer.from(transcript),createPublicKey(createPrivateKey(identity.privateKeyPem)),
     Buffer.from(body.proof,"base64url")),true);
   assert.notEqual(body.proof,secureInputOwnerIntentProof(identity.privateKeyPem,
     {...shown,target_binding:"b".repeat(64)},true,true));
   return Response.json({request_id:requestId,state:"unknown"});
  };
  const shown=await getSecureInputOwnerChallenge("https://rca.example.test/",key,requestId,mock as typeof fetch);
  assert.deepEqual(shown.target,challenge.target);
  const submitted=await sendSignedSecureInputOwnerIntent("https://rca.example.test/",key,shown,secret,true,true,mock as typeof fetch);
  assert.deepEqual(submitted,{request_id:requestId,state:"unknown"});
  assert.deepEqual(calls,["/agent/owner/intent/challenge","/agent/owner/intent"]);
  await assert.rejects(sendSignedSecureInputOwnerIntent("https://rca.example.test/",key,shown,secret,true,false,mock as typeof fetch));
  await assert.rejects(getSecureInputOwnerChallenge("http://evil.example/",key,requestId,mock as typeof fetch));
 }finally{await rm(directory,{recursive:true,force:true});}
});
