import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {isDropPlan,isSealedDropInputs,type SealedDropInputs} from '../src/drop-file-contract.ts';
import {sealDropFile,startSelectedFile} from '../src/drop-file-ingress.ts';
import {buildMcpServer} from '../src/tools.ts';
import {createMcpHandler} from '@modelcontextprotocol/server';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import type {Plan} from '../src/plan.ts';
import type {Env} from '../src/store.ts';

const attempt='11111111-2222-4333-8444-555555555555';
const digest='a'.repeat(64);
const action={repository:'lirtual/github-actions',repositoryId:123,workflowId:456,
 workflowPath:'.github/workflows/drop.yml',commitSha:'b'.repeat(40),
 type:'task' as const,contractDigest:digest};
const plan:Plan={version:1,name:'drop',github_execution_approved:true,
 github_action_approvals:[action],steps:[{id:'drop',uses:'github.run',needs:[],
 with:{capability:'github.action',action:{...action,ref:'refs/heads/main',
 inputs:{drop_part_0:'',drop_part_1:'',drop_part_2:''}}}}]};
const file={file_id:'opaque',download_url:'https://files.oaiusercontent.com/test.html',
 file_name:'index.html',mime_type:'text/html'};
const keys=generateKeyPairSync('rsa',{modulusLength:2048,
 publicKeyEncoding:{format:'pem',type:'spki'},
 privateKeyEncoding:{format:'pem',type:'pkcs8'}});

function decode(parts:SealedDropInputs,id=attempt,hash=digest){
 const object=JSON.parse(Buffer.from([
  parts.drop_part_0,parts.drop_part_1,parts.drop_part_2].join(''),'base64url').toString());
 assert.equal(object.contract_digest,hash);
 const wrapped=Buffer.from(object.wrapped_key,'base64url');
 const aes=privateDecrypt({key:keys.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash:'sha256'},wrapped);
 const nonce=Buffer.from(object.nonce,'base64url');
 const data=Buffer.from(object.ciphertext,'base64url');
 const decipher=createDecipheriv('aes-256-gcm',aes,nonce);
 decipher.setAAD(Buffer.from('drop-v1\n'+id+'\n'+hash));
 decipher.setAuthTag(data.subarray(data.length-16));
 return JSON.parse(Buffer.concat([
  decipher.update(data.subarray(0,data.length-16)),decipher.final()]).toString());
}
test('Only an exact, approved, manual, one-step Drop Task receives file ingress',()=>{
 assert.equal(isDropPlan(plan),true);
 const check=(mutate:(p:Plan)=>void)=>{
  const p=structuredClone(plan);mutate(p);assert.equal(isDropPlan(p),false);
 };
 check(p=>{p.triggers=[{type:'cron',schedule:'0 0 * * *'}];});
 check(p=>{p.steps.push({...p.steps[0]!,id:'second'});});
 check(p=>{p.steps[0]!.with.action={...(p.steps[0]!.with.action as object),
  workflowPath:'.github/workflows/task.yml'};});
 check(p=>{p.steps[0]!.with.action={...(p.steps[0]!.with.action as object),
  inputs:{drop_part_0:'x',drop_part_1:'',drop_part_2:''}};});
 check(p=>{p.github_execution_approved=undefined;});
 check(p=>{p.github_action_approvals=[];});
 check(p=>{p.steps[0]!.with.action={...(p.steps[0]!.with.action as object),
  ref:'refs/tags/v1'};});
 check(p=>{p.name='unrelated';});
});
test('Signed URL is encrypted for exact physical Attempt; no plaintext reaches dispatch input',async()=>{
 const sealed=await sealDropFile(file,attempt,digest,keys.publicKey,1800000000000);
 assert.equal(isSealedDropInputs(sealed),true);
 assert.equal(sealed.drop_attempt_id,attempt);
 for(const p of [sealed.drop_part_0,sealed.drop_part_1,sealed.drop_part_2])
  assert.ok(p.length<=3500);
 assert.equal(JSON.stringify(sealed).includes(file.download_url),false);
 const opened=decode(sealed);
 assert.equal(opened.attemptId,attempt);
 assert.equal(opened.contractDigest,digest);
 assert.deepEqual(opened.file,file);
 assert.equal(opened.expiresAt-opened.issuedAt,3600000);
 assert.throws(()=>decode(sealed,crypto.randomUUID()));
 assert.throws(()=>decode(sealed,attempt,'f'.repeat(64)));
});
test('ChatGPT fileParams may omit filename and MIME without losing attempt binding',async()=>{
 const required={file_id:file.file_id,download_url:file.download_url};
 const sealed=await sealDropFile(required,attempt,digest,keys.publicKey,1800000000000);
 assert.deepEqual(decode(sealed).file,required);
 await assert.rejects(sealDropFile({...required,file_name:null} as any,
  attempt,digest,keys.publicKey),/drop_file_metadata_invalid/);
});
test('Drop seals selected file URLs from any valid public HTTPS DNS host',async()=>{
 for(const host of ['cdn.example.com','bucket.s3.amazonaws.com',
  'files.oaiusercontent.com.evil.example']){
  const selected={...file,download_url:'https://'+host+'/file.html?token=opaque'};
  const sealed=await sealDropFile(selected,attempt,digest,keys.publicKey,1800000000000);
  assert.deepEqual(decode(sealed).file,selected);
  assert.equal(JSON.stringify(sealed).includes('token=opaque'),false);
 }
});
test('Reject invalid file, public key and truncated or oversized serialized inputs',async()=>{
 await assert.rejects(sealDropFile({...file,file_name:'script.js'},attempt,digest,keys.publicKey));
 await assert.rejects(sealDropFile({...file,file_name:'../index.html'},attempt,digest,keys.publicKey));
 await assert.rejects(sealDropFile({...file,download_url:'https://127.0.0.1/file.html'},
  attempt,digest,keys.publicKey),/drop_file_source_url_invalid/);
 await assert.rejects(sealDropFile({...file,download_url:'http://files.oaiusercontent.com/a'},
  attempt,digest,keys.publicKey),/drop_file_source_url_invalid/);
 await assert.rejects(sealDropFile({...file,file_id:'   '},
  attempt,digest,keys.publicKey),/drop_file_source_descriptor_invalid/);
 await assert.rejects(sealDropFile({...file,download_url:
  'https://selectedblob123.blob.core.windows.net/uploads/a.html?se=not-a-date'},
  attempt,digest,keys.publicKey),/drop_file_expiry_insufficient/);
 await assert.rejects(sealDropFile(file,attempt,'bad-digest',keys.publicKey),
  /drop_file_contract_invalid/);
 await assert.rejects(sealDropFile(file,attempt,digest,'not PEM'),/drop_key_unavailable/);
 const valid=await sealDropFile(file,attempt,digest,keys.publicKey);
 assert.equal(isSealedDropInputs({...valid,drop_part_0:''}),false);
 assert.equal(isSealedDropInputs({...valid,drop_part_0:'x'.repeat(3501)}),false);
 assert.equal(isSealedDropInputs({...valid,drop_part_1:'',drop_part_2:'x'}),false);
 assert.equal(isSealedDropInputs({...valid,unknown:'x'}),false);
});
test('Selected-file entry fails closed before Run reservation without configured key',async()=>{
 let reads=0;
 const env={DB:{prepare:(_sql:string)=>({bind:()=>({first:async()=>{
  reads++;return {state:'active',active_version_id:attempt,plan:JSON.stringify(plan)};
 }})})}} as unknown as Env;
 await assert.rejects(startSelectedFile(env,{workflow_id:attempt,file,
  inputs:{},
  idempotency_key:'drop-test',expected_published_version_id:attempt}),/drop_key_unavailable/);
 assert.equal(reads,1);
 for(const invalidInputs of [{cloudflare_terms_accepted:true},
  {cloudflare_terms_accepted:false},{time:'24h'}]){
  await assert.rejects(startSelectedFile(env,{workflow_id:attempt,file,
   inputs:invalidInputs,idempotency_key:'drop-test'}),/file_inputs_invalid/);
 }
 assert.equal(reads,4);
});
test('MCP workflow_run returns only a safe Drop rejection class before admission',async t=>{
 let planReads=0;
 const env={DB:{prepare:(query:string)=>{
  assert.match(query,/SELECT w.state,w.active_version_id,v.plan/);
  return {bind:()=>({first:async()=>{
   planReads++;
   return {state:'active',active_version_id:attempt,plan:JSON.stringify(plan)};
  }})};
 }},WORKFLOW_GITHUB_DROP_PUBLIC_KEY:'not-needed-before-validation'} as unknown as Env;
 const worker=createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'});
 const client=new Client({name:'drop-rejection-fixture',version:'0.1.0'});
 const transport=new StreamableHTTPClientTransport(new URL('https://workflow-fixture.invalid/mcp'),{
  fetch:async(input,init)=>worker.fetch(new Request(input,init)),
 });
 await client.connect(transport);
 t.after(async()=>client.close());
 const cases=[
  ['http://example.com/private.html','url_invalid'],
  ['https://127.0.0.1/private.html','url_invalid'],
  ['https://localhost/private.html','url_invalid'],
  ['https://public.example/private.html#fragment','url_invalid'],
 ] as const;
 for(const [download_url,reason] of cases){
  const rejected={...file,file_id:'SYNTHETIC_FILE_ID',download_url};
  const response=await client.callTool({name:'workflow_run',arguments:{
   workflow_id:attempt,idempotency_key:'drop-diagnostic-'+reason+'-'+planReads,inputs:{},file:rejected,
  }});
  assert.equal(response.isError,true);
  const output=(response.content?.[0] as {text:string}).text;
  assert.deepEqual(JSON.parse(output),{error:'drop_file_source_'+reason});
  for(const sensitive of [rejected.file_id,rejected.download_url])
   assert.equal(output.includes(sensitive),false);
 }
 assert.equal(planReads,cases.length);
});
