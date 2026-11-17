import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedFilePlan} from '../src/selected-file-plan.ts';
import {publishedRunInterface} from '../src/published-run-interface.ts';
import {sealDropFile,startSelectedFile} from '../src/drop-file-ingress.ts';
import type {Env} from '../src/store.ts';
import type {Plan} from '../src/plan.ts';

const action={repository:'lirtual/github-actions',repositoryId:123,workflowId:456,
 workflowPath:'.github/workflows/new-preview.yml',commitSha:'b'.repeat(40),
 type:'task' as const,contractDigest:'a'.repeat(64)};
const selectedFile={delivery:'github_encrypted_locator_v1' as const,
 extensions:['.html','.zip'],max_bytes:10485760,
 input_slots:['drop_part_0','drop_part_1','drop_part_2'] as ['drop_part_0','drop_part_1','drop_part_2'],
 consent:'cloudflare_terms_v1' as const,receipt:'owner_claim_v1' as const};
const inputs={drop_part_0:'',drop_part_1:'',drop_part_2:''};
const plan:Plan={version:1,name:'new-preview',github_execution_approved:true,
 github_action_approvals:[action],
 github_dynamic_input_contracts:{upload:{name:'Other Task',type:'task',
  inputs:{drop_part_0:{type:'string',required:true},
    drop_part_1:{type:'string',required:false,default:''},
    drop_part_2:{type:'string',required:false,default:''}},
  selectedFile}},
 steps:[{id:'upload',uses:'github.run',needs:[],
  with:{capability:'github.action',action:{...action,ref:'refs/heads/main',inputs}}}]};

test('generic reviewed file Task accepts no redundant Terms input, regardless of Action name',async()=>{
 let reads=0;
 const version='11111111-2222-4333-8444-555555555555';
 const env={DB:{prepare:()=>({bind:()=>({first:async()=>{
  reads++;return {state:'active',active_version_id:version,plan:JSON.stringify(plan)};
 }})})}} as unknown as Env;
 const file={file_id:'opaque',download_url:'https://files.oaiusercontent.com/file.html',
  file_name:'index.html',mime_type:'text/html'};
 const run=(inputs:Record<string,unknown>)=>startSelectedFile(env,{workflow_id:version,
  file,inputs,idempotency_key:'file-contract-test'});
 await assert.rejects(run({}),/drop_key_unavailable/);
 for(const invalid of [{cloudflare_terms_accepted:true},
  {cloudflare_terms_accepted:false},{time:'24h'}])
  await assert.rejects(run(invalid),/file_inputs_invalid/);
 assert.equal(reads,4);
});

test('Published file interface derives consent and policy from the reviewed Action, not its name',()=>{
 const value=publishedRunInterface(plan,'11111111-2222-4333-8444-555555555555');
 assert.equal(value.kind,'manual_selected_file');
 assert.ok('top_level_file' in value);
 if(!('top_level_file' in value))throw Error('missing file capability');
 assert.deepEqual(value.top_level_file.extensions,['.html','.zip']);
 assert.equal(value.top_level_file.max_bytes,10485760);
 assert.deepEqual(value.inputs,{});
 assert.ok('terms' in value);
 assert.equal(value.terms,'one_time_cloudflare_terms_and_privacy_acceptance_before_first_deployment');
 assert.equal(value.idempotency_key,'required');
});

test('selected file admission follows the published reviewed Action capability, not its name',()=>{
 const capability=selectedFilePlan(plan);
 assert.deepEqual(capability,{delivery:'github_encrypted_locator_v1',step_id:'upload',
  file:selectedFile,contract_digest:action.contractDigest});
});

test('alternate reviewed GitHub file policy changes disclosure, file types and result handling',async()=>{
 const alternative={...selectedFile,extensions:['.txt'],max_bytes:2048,
  consent:'owner_public_upload_v1' as const,receipt:'reviewed_output_v1' as const};
 const newPlan:Plan={...plan,github_dynamic_input_contracts:{
  upload:{...plan.github_dynamic_input_contracts!.upload!,selectedFile:alternative}}};
 const capability=selectedFilePlan(newPlan);
 assert.equal(capability?.file,alternative);
 const published=publishedRunInterface(newPlan,'11111111-2222-4333-8444-555555555555');
 assert.equal(published.kind,'manual_selected_file');
 assert.deepEqual(published.inputs,{public_file_upload_accepted:{
  type:'boolean',required:true,const:true,
  note:'Fresh authorization to send this file to the reviewed public GitHub Action'}});
 assert.ok('top_level_file' in published);
 if(!('top_level_file' in published))throw Error('missing file capability');
 assert.deepEqual(published.top_level_file.extensions,['.txt']);
 assert.equal(published.top_level_file.max_bytes,2048);
 assert.equal('terms' in published,false);
 assert.equal('approval' in published,true);
 const version='11111111-2222-4333-8444-555555555555';
 const env={DB:{prepare:()=>({bind:()=>({first:async()=>({
  state:'active',active_version_id:version,plan:JSON.stringify(newPlan)})})})}} as unknown as Env;
 const file={file_id:'opaque',download_url:'https://files.oaiusercontent.com/note.txt',
  file_name:'note.txt',mime_type:'text/plain'};
 const run=(inputs:Record<string,unknown>)=>startSelectedFile(env,{workflow_id:version,
  file,inputs,idempotency_key:'alternate-file'});
 for(const inputs of [{},{public_file_upload_accepted:false},
  {public_file_upload_accepted:true,extra:true}])
  await assert.rejects(run(inputs),/selected_file_public_upload_consent_required/);
 await assert.rejects(run({public_file_upload_accepted:true}),/drop_key_unavailable/);
 const attempt='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const digest='a'.repeat(64);
 await assert.rejects(sealDropFile(file,attempt,digest,'invalid'),/drop_file_metadata_invalid/);
 await assert.rejects(sealDropFile(file,attempt,digest,'invalid',Date.now(),['.txt']),
  /drop_key_unavailable/);
});
