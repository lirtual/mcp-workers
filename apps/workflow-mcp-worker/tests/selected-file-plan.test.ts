import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedFilePlan} from '../src/selected-file-plan.ts';
import {publishedRunInterface} from '../src/published-run-interface.ts';
import {startSelectedFile} from '../src/drop-file-ingress.ts';
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

test('generic reviewed file Task validates fresh Terms before any Run, regardless of Action name',async()=>{
 let reads=0;
 const version='11111111-2222-4333-8444-555555555555';
 const env={DB:{prepare:()=>({bind:()=>({first:async()=>{
  reads++;return {state:'active',active_version_id:version,plan:JSON.stringify(plan)};
 }})})}} as unknown as Env;
 const file={file_id:'opaque',download_url:'https://files.oaiusercontent.com/file.html',
  file_name:'index.html',mime_type:'text/html'};
 const run=(inputs:Record<string,unknown>)=>startSelectedFile(env,{workflow_id:version,
  file,inputs,idempotency_key:'file-contract-test'});
 await assert.rejects(run({cloudflare_terms_accepted:true}),/drop_key_unavailable/);
 for(const invalid of [{},{cloudflare_terms_accepted:false},{cloudflare_terms_accepted:'true'},
  {cloudflare_terms_accepted:true,extra:1}])
  await assert.rejects(run(invalid),/drop_terms_acceptance_required/);
 assert.equal(reads,5);
});

test('Published file interface derives consent and policy from the reviewed Action, not its name',()=>{
 const value=publishedRunInterface(plan,'11111111-2222-4333-8444-555555555555');
 assert.equal(value.kind,'manual_selected_file');
 assert.ok('top_level_file' in value);
 if(!('top_level_file' in value))throw Error('missing file capability');
 assert.deepEqual(value.top_level_file.extensions,['.html','.zip']);
 assert.equal(value.top_level_file.max_bytes,10485760);
 assert.deepEqual(value.inputs.cloudflare_terms_accepted,{type:'boolean',required:true,const:true,
  note:'Fresh acceptance of Cloudflare Terms and Privacy for this one temporary deployment'});
 assert.equal(value.idempotency_key,'required');
});

test('selected file admission follows the published reviewed Action capability, not its name',()=>{
 const capability=selectedFilePlan(plan);
 assert.deepEqual(capability,{delivery:'github_encrypted_locator_v1',step_id:'upload',
  file:selectedFile,contract_digest:action.contractDigest});
});
