import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runPublishedCloudflareAction} from '../src/cloudflare-action-executor.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import type {Plan,Step} from '../src/plan.ts';
import type {Env} from '../src/store.ts';

const runId='11111111-1111-4111-8111-111111111111';
const deployment='33333333-3333-4333-8333-333333333333';
const message='Koofr 下载完成，云端文件回读校验已通过。';
async function fixture(t:test.TestContext){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
   '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql',
   '0006_action_attempt_capabilities.sql','0007_session_executions.sql',
   '0008_session_locator.sql','0009_fixed_sessions.sql','0011_awaited_child_capacity.sql',
   '0013_cloudflare_action_invocations.sql','0018_cloudflare_action_migration_fence.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const manifest=await cloudflareActionManifest('generic');
 const done:Step={id:'done',uses:'result.emit',needs:[],with:{data:'ok'}};
 const notify:Step={id:'notify',uses:'action.run',needs:['done'],with:{
   executor:'cloudflare',provider:'weixin',action:'weixin.send_text',
   contract_digest:manifest.contract_digest,input:{text:message}}};
 const plan:Plan={version:1,name:'generic',steps:[done,notify],cloudflare_execution_approved:true,
   cloudflare_action_approvals:[{executor:'cloudflare',provider:'weixin',action:'weixin.send_text',
   contract_digest:manifest.contract_digest,deployment_id:deployment}]};
 sql.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES('wf','test','{}',1,'active',1,1)").run();
 sql.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','x',?,1)").run(JSON.stringify(plan));
 sql.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at) VALUES(?,'wf','v','instance','x','{}','running',1,1)").run(runId);
 sql.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,'done','succeeded',1)").run(runId);
 const prepare=(query:string)=>{
  const bound=(args:unknown[])=>({
   first:async<T>()=>(sql.prepare(query).get(...args as [])??null) as T|null,
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args as []).changes)}}),
  });return {...bound([]),bind:(...args:unknown[])=>bound(args)};
 };
 const inputDigest=createHash('sha256').update(message).digest('hex');
 let sends=0,reads=0,uncertain=false;
 const provider={getBinding:async()=>({generation:1,ready:true}),
  getGenericContract:async()=>({deployment_id:deployment,contract_digest:manifest.contract_digest}),
  sendGenericText:async(v:{text:string;contract_digest:string})=>{
   assert.equal(v.text,message);assert.equal(v.contract_digest,manifest.contract_digest);
   sends++;if(uncertain)throw Error('unknown result');
   return {status:'accepted',input_digest:inputDigest};
  },
  getReceipt:async()=>{reads++;return {status:'missing'};}};
 const env={DB:{prepare},WEIXIN_ACTION_PROVIDER:provider,WEIXIN_ACTION_DEPLOYMENT_ID:deployment} as unknown as Env;
 const ctx={inputs:{},steps:{done:{status:'succeeded'}}};
 const run=()=>runPublishedCloudflareAction(env,plan,notify,runId,undefined,ctx);
 return {sql,plan,notify,ctx,env,run,sends:()=>sends,reads:()=>reads,uncertain:()=>{uncertain=true}};
}
test('generic text uses one durable Owner-only dispatch and never stores message text',async t=>{
 const f=await fixture(t);
 assert.equal((await f.run()).status,'succeeded');
 assert.equal((await f.run()).status,'indeterminate');
 assert.equal(f.sends(),1);assert.equal(f.reads(),1);
 const row=f.sql.prepare('SELECT * FROM cloudflare_action_invocations').get()!;
 assert.equal(row.source_attempt_id,row.invocation_id);
 assert.ok(!JSON.stringify(row).includes(message));
});
test('failed prerequisite, missing grant and cancellation all prevent first send',async t=>{
 const f=await fixture(t);f.ctx.steps.done.status='failed';
 assert.equal((await f.run()).status,'failed');f.ctx.steps.done.status='succeeded';
 f.plan.cloudflare_action_approvals=[];assert.equal((await f.run()).status,'failed');
 f.plan.cloudflare_action_approvals=[{executor:'cloudflare',provider:'weixin',
  action:'weixin.send_text',contract_digest:(await cloudflareActionManifest('generic')).contract_digest,
  deployment_id:deployment}];
 f.sql.prepare("INSERT INTO cloudflare_action_cancellations(run_id,step_id,created_at) VALUES(?,'notify',1)").run(runId);
 assert.equal((await f.run()).status,'failed');assert.equal(f.sends(),0);
});
test('ambiguous upstream result stays unknown and never resends',async t=>{
 const f=await fixture(t);f.uncertain();
 assert.equal((await f.run()).status,'indeterminate');
 assert.equal((await f.run()).status,'indeterminate');
 assert.equal(f.sends(),1);
});

test('forged in-memory success without persisted prerequisite is refused',async t=>{
 const f=await fixture(t);
 f.sql.prepare("UPDATE run_steps SET status='failed' WHERE step_id='done'").run();
 assert.equal((await f.run()).status,'failed');
 assert.equal(f.sends(),0);
});

test('v2 immutable Plan can read its old receipt after unified binding replaces legacy Worker',async t=>{
 const f=await fixture(t);
 assert.equal((await f.run()).status,'succeeded');
 let historical=0;
 f.env.ACTIONS={getReceipt:async()=>{historical++;return {status:'accepted'};}} as unknown as Env['ACTIONS'];
 f.env.WEIXIN_ACTION_PROVIDER=undefined;
 f.env.WEIXIN_ACTION_DEPLOYMENT_ID=undefined;
 f.env.ACTIONS_DEPLOYMENT_ID='44444444-4444-4444-8444-444444444444';
 assert.equal((await f.run()).status,'succeeded');
 assert.equal(historical,1);assert.equal(f.sends(),1);
});
test('v3 unified text reserves once, verifies pinned identity and cannot cross a frozen gate',async t=>{
 const f=await fixture(t),m=await cloudflareActionManifest('unified-generic');
 f.notify.with.contract_digest=m.contract_digest;
 f.plan.cloudflare_action_approvals=[{executor:'cloudflare',provider:'weixin',
   action:'weixin.send_text',contract_digest:m.contract_digest,deployment_id:deployment}];
 const digest=createHash('sha256').update(message).digest('hex');let sends=0;
 f.env.ACTIONS_DEPLOYMENT_ID=deployment;
 f.env.ACTIONS={
   getContract:async()=>({deployment_id:deployment,contract_digest:m.contract_digest}),
   getBinding:async()=>({generation:1,ready:true}),
   execute:async(_action:string,request:unknown)=>{sends++;assert.equal((request as {text:string}).text,message);
     return {status:'accepted',input_digest:digest};},
   getReceipt:async()=>({status:'accepted'}),
 } as unknown as Env['ACTIONS'];
 assert.equal((await f.run()).status,'succeeded');
 assert.equal((await f.run()).status,'succeeded');
 assert.equal(sends,1);
 const other=await fixture(t);other.notify.with.contract_digest=m.contract_digest;
 other.plan.cloudflare_action_approvals=f.plan.cloudflare_action_approvals;
 other.env.ACTIONS_DEPLOYMENT_ID=deployment;other.env.ACTIONS=f.env.ACTIONS;
 other.sql.prepare("UPDATE cloudflare_action_gate SET state='frozen' WHERE id=1").run();
 assert.equal((await other.run()).status,'failed');assert.equal(sends,1);
});

test('migration freeze refuses new legacy v2 sends but retains read-only historical receipts',async t=>{
 const f=await fixture(t);
 f.sql.prepare("UPDATE cloudflare_action_gate SET state='frozen' WHERE id=1").run();
 assert.equal((await f.run()).status,'failed');assert.equal(f.sends(),0);
 const existing=await fixture(t);
 assert.equal((await existing.run()).status,'succeeded');
 existing.sql.prepare("UPDATE cloudflare_action_gate SET state='frozen' WHERE id=1").run();
 assert.equal((await existing.run()).status,'indeterminate');
 assert.equal(existing.sends(),1);
});
