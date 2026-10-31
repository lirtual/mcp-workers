import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {DOWNLOAD_COMPLETED_TEXT,runDownloadNotification} from '../src/download-notification-executor.ts';
import type {Plan,Step} from '../src/plan.ts';
import type {Env} from '../src/store.ts';

const runId='11111111-1111-4111-8111-111111111111';
const attempt='22222222-2222-4222-8222-222222222222';
const version='33333333-3333-4333-8333-333333333333';
const inputDigest=createHash('sha256').update(DOWNLOAD_COMPLETED_TEXT).digest('hex');
const sourceId='download_task',childId='download_task_0_submit_download';
const source:Step={id:sourceId,uses:'flow.foreach',needs:[],with:{
 items:{ref:'inputs.download_batches'},max_items:1,
 template:{id:'submit_download',uses:'github.run',
  with:{capability:'github.action',action:{repository:'lirtual/github-actions',
   repositoryId:10,workflowId:20,workflowPath:'.github/workflows/download.yml',
   commitSha:'a'.repeat(40),type:'task',contractDigest:'b'.repeat(64),
   ref:'refs/tags/v1',inputs:{batch_json:{ref:'item.value'}}}}}}};
async function fixture(t:test.TestContext){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
  '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql',
  '0006_action_attempt_capabilities.sql','0007_session_executions.sql',
  '0008_session_locator.sql','0009_fixed_sessions.sql',
  '0011_awaited_child_capacity.sql','0013_cloudflare_action_invocations.sql',
  '0018_cloudflare_action_migration_fence.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const m=await cloudflareActionManifest('download');
 const notify:Step={id:'notify',uses:'action.run',needs:[sourceId],with:{
  executor:'cloudflare',provider:'weixin',action:'weixin.notify_download',
  contract_digest:m.contract_digest,input:{download_step_id:sourceId}}};
 const plan:Plan={version:1,name:'download',steps:[source,notify],
  cloudflare_execution_approved:true,cloudflare_action_approvals:[{
   executor:'cloudflare',provider:'weixin',action:'weixin.notify_download',
   contract_digest:m.contract_digest,deployment_id:version}]};
 sql.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES('wf','test','{}',1,'active',1,1)").run();
 sql.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','x',?,1)").run(JSON.stringify(plan));
 sql.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at) VALUES(?,'wf','v','instance','x','{}','running',1,1)").run(runId);
 for(const id of [sourceId,childId])
  sql.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'succeeded',1)").run(runId,id);
 sql.prepare("INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at) VALUES(?,? ,?,'github.action','dispatch','succeeded','lirtual/github-actions','10','lirtual/github-actions/.github/workflows/download.yml@refs/tags/v1','refs/tags/v1',42,1,42,1,1,1)").run(attempt,runId,childId);

 const prepare=(query:string)=>{
  // Production D1 rejects the long LIKE prefix with SQLITE_ERROR; the vetted
  // exact Workflow source check must use instr(...)=1 instead.
  if(/a\.workflow_ref\s+LIKE\b/.test(query))throw Error('D1 incompatible LIKE source check');
  const bound=(args:unknown[])=>({
   first:async<T>()=>(sql.prepare(query).get(...(args as []))??null) as T|null,
   all:async()=>({results:sql.prepare(query).all(...(args as []))}),
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...(args as [])).changes)}}),
  });
  return {...bound([]),bind:(...args:unknown[])=>bound(args)};
 };
 let sends=0,receipts=0;
 let failSend=false;
 let sendStatus='accepted';
 const provider={
  getContract:async(actionId:string)=>{
   assert.equal(actionId,'weixin.notify_download');
   return {deployment_id:version,contract_digest:m.contract_digest};
  },
  getBinding:async(actionId:string)=>{
   assert.equal(actionId,'weixin.notify_download');
   return {generation:1,ready:true};
  },
  execute:async(actionId:string,input:{invocation_id:string;binding_generation:number;deployment_id:string;contract_digest:string})=>{
   assert.equal(actionId,'weixin.notify_download');
   assert.equal(input.contract_digest,m.contract_digest);assert.equal(input.binding_generation,1);
   assert.equal(input.deployment_id,version);sends++;
   if(failSend)throw Error('upstream response lost');
   return {status:sendStatus,input_digest:inputDigest};
  },
  getReceipt:async(actionId:string,input:{input_digest:string})=>{
   assert.equal(actionId,'weixin.notify_download');
   assert.equal(input.input_digest,inputDigest);receipts++;return {status:'missing'};
  },
 };
 const env={DB:{prepare},ACTIONS:provider,
  ACTIONS_DEPLOYMENT_ID:version} as unknown as Env;
 const ctx={inputs:{},steps:{[sourceId]:{status:'succeeded'}}};
 const call=()=>runDownloadNotification(env,plan,notify,runId,ctx);
 return {sql,plan,notify,env,ctx,call,sends:()=>sends,receipts:()=>receipts,
  fail:()=>{failSend=true},setStatus:(v:string)=>{sendStatus=v}};
}
test('OIDC claimed and physically confirmed Task permits exactly one Owner send',async t=>{
 const f=await fixture(t);
 assert.equal((await f.call()).status,'succeeded');
 assert.equal((await f.call()).status,'indeterminate'); // missing read-only receipt is unknown
 assert.equal(f.sends(),1);assert.equal(f.receipts(),1);
 assert.equal(f.sql.prepare('SELECT source_attempt_id,input_digest FROM cloudflare_action_invocations').get()?.source_attempt_id,attempt);
 assert.equal(f.sql.prepare('SELECT input_digest FROM cloudflare_action_invocations').get()?.input_digest,inputDigest);
});
test('missing OIDC ownership, failed physical Task, and failed parent cannot trigger a send',async t=>{
 for(const query of [
  "UPDATE step_attempts SET owner_run_id=NULL",
  "UPDATE step_attempts SET state='failed'",
  "UPDATE run_steps SET status='failed' WHERE step_id='download_task'",
  "UPDATE run_steps SET status='indeterminate' WHERE step_id='download_task_0_submit_download'"
 ]){
  const f=await fixture(t);f.sql.exec(query);
  assert.equal((await f.call()).status,'failed');
  assert.equal(f.sends(),0);
 }
});
test('run context, grant and cancellation independently deny notification',async t=>{
 const f=await fixture(t);
 f.ctx.steps[sourceId].status='failed';
 assert.equal((await f.call()).status,'failed');f.ctx.steps[sourceId].status='succeeded';
 f.plan.cloudflare_action_approvals=[];
 assert.equal((await f.call()).status,'failed');
 f.plan.cloudflare_action_approvals=[{executor:'cloudflare',provider:'weixin',
  action:'weixin.notify_download',contract_digest:(await cloudflareActionManifest('download')).contract_digest,deployment_id:version}];
 f.sql.prepare('INSERT INTO cloudflare_action_cancellations(run_id,step_id,created_at) VALUES(?,?,1)').run(runId,'notify');
 assert.equal((await f.call()).status,'failed');assert.equal(f.sends(),0);
});
test('ambiguous send response is not replayed',async t=>{
 const f=await fixture(t);f.fail();
 assert.equal((await f.call()).status,'indeterminate');
 assert.equal((await f.call()).status,'indeterminate');
 assert.equal(f.sends(),1);assert.equal(f.receipts(),2);
});
