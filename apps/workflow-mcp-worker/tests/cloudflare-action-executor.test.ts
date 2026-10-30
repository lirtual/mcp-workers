import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {runPublishedCloudflareAction} from '../src/cloudflare-action-executor.ts';
import {WorkflowService,type Env} from '../src/store.ts';
import type {Plan,Step} from '../src/plan.ts';

const runId='11111111-1111-4111-8111-111111111111';
const attemptId='22222222-2222-4222-8222-222222222222';
const version='33333333-3333-4333-8333-333333333333';
const url='https://safe.trycloudflare.com/';
const bodyHash=createHash('sha256').update('OpenList Session Ready\n'+url).digest('hex');
const github={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
 workflowPath:'.github/workflows/openlist.yml',commitSha:'a'.repeat(40),
 type:'session' as const,contractDigest:'b'.repeat(64),ref:'refs/tags/v1',
 inputs:{duration_minutes:5}};
async function fixture(t:test.TestContext){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
   '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql',
   '0006_action_attempt_capabilities.sql','0007_session_executions.sql','0008_session_locator.sql',
   '0009_fixed_sessions.sql','0011_awaited_child_capacity.sql','0013_cloudflare_action_invocations.sql','0017_cloudflare_action_migration_fence.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const m=await cloudflareActionManifest();
 const notify:Step={id:'notify',uses:'action.run',needs:['openlist'],with:{
  executor:'cloudflare',provider:'weixin',action:'weixin.send_text',
  contract_digest:m.contract_digest,input:{session_step_id:'openlist'}}};
 const openlist:Step={id:'openlist',uses:'github.run',needs:[],with:{
  capability:'github.action',action:github}};
 const plan:Plan={version:1,name:'Notification',steps:[openlist,notify],
  cloudflare_execution_approved:true,cloudflare_action_approvals:[{
   executor:'cloudflare',provider:'weixin',action:'weixin.send_text',
   contract_digest:m.contract_digest,deployment_id:version}]};
 sql.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES('wf','test','{}',1,'active',1,1)").run();
 sql.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','x',?,1)").run(JSON.stringify(plan));
 sql.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at) VALUES(?,'wf','v','instance','x','{}','running',1,1)").run(runId);
 sql.prepare("INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at) VALUES(?,?,'openlist','github.action','dispatch','claimed','lirtual/session-actions','123','lirtual/session-actions/.github/workflows/openlist.yml@refs/tags/v1','refs/tags/v1',42,1,42,1,1,1)").run(attemptId,runId);
 sql.prepare("INSERT INTO session_executions(run_id,step_id,slot,state,created_at,updated_at,session_url) VALUES(?,'openlist',1,'ready',1,1,?)").run(runId,url);
 const prepare=(query:string)=>{
  const statements=(args:unknown[])=>({
   first:async<T>()=>(sql.prepare(query).get(...(args as []))??null) as T|null,
   all:async()=>({results:sql.prepare(query).all(...(args as []))}),
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...(args as [])).changes)}}),
  });
  return {...statements([]),bind:(...args:unknown[])=>statements(args)};
 };
 let sends=0,receipts=0,upstreamStatus:'accepted'|'rejected'|'unknown'='accepted';
 let historical:'accepted'|'rejected'|'unknown'|'missing'='accepted';
 let failSend=false;
 const provider={
  getBinding:async(_action_id:string)=>({generation:1,ready:true}),
  getContract:async(_action_id:string)=>({deployment_id:version,contract_digest:m.contract_digest}),
  async execute(_action_id:string,input:{invocation_id:string;binding_generation:number;session_url:string;deployment_id:string;contract_digest:string}){
   sends++;assert.equal(input.binding_generation,1);assert.equal(input.session_url,url);
   assert.equal(input.deployment_id,version);assert.equal(input.contract_digest,m.contract_digest);
   if(failSend)throw Error('secret! must not be logged');
   return {status:upstreamStatus,input_digest:bodyHash};
  },
  async getReceipt(_action_id:string,input:{invocation_id:string;binding_generation:number;input_digest:string}){
   receipts++;assert.equal(input.input_digest,bodyHash);
   return {status:historical};
  },
 };
 const env={DB:{prepare},WORKFLOW_GITHUB_DISPATCH_TOKEN:'fixture-token',
  ACTIONS_DEPLOYMENT_ID:version,ACTIONS:provider} as unknown as Env;
 const inspect=async()=>({state:'running' as const});
 return {sql,plan,notify,env,inspect,
  sends:()=>sends,receipts:()=>receipts,
  receipt:(s:typeof historical)=>{historical=s;},
  upstream:(s:typeof upstreamStatus)=>{upstreamStatus=s;},
  fail:()=>{failSend=true}};
}
test('first invocation reserves one durable identity, replays only read history, never stores URL',async t=>{
 const f=await fixture(t);
 const first=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
 assert.deepEqual(first,{status:'succeeded',output:{status:'accepted'}});
 const replay=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
 assert.equal(replay.status,'succeeded');
 assert.equal(f.sends(),1);assert.equal(f.receipts(),1);
 const row=f.sql.prepare('SELECT * FROM cloudflare_action_invocations').get()!;
 assert.equal(row.source_attempt_id,attemptId);
 assert.equal(row.input_digest,bodyHash);
 assert.equal(row.binding_generation,1);
 assert.ok(!JSON.stringify(row).includes(url));
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations').get()!.n,1);
});
test('lost response, missing receipt, unknown and rejected never trigger second send',async t=>{
 const f=await fixture(t);f.fail();f.receipt('missing');
 const first=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
 assert.equal(first.status,'indeterminate');
 const second=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
 assert.equal(second.status,'indeterminate');
 assert.equal(f.sends(),1);
 f.receipt('rejected');
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'failed');
 assert.equal(f.sends(),1);
});
test('unverified physical state and untrusted ready must not reserve or send',async t=>{
 const f=await fixture(t);
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,
  async()=>({state:'unknown' as const}))).status,'failed');
 f.sql.prepare("UPDATE session_executions SET session_url='https://attacker.example/'").run();
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'failed');
 assert.equal(f.sends(),0);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations').get()!.n,0);
});
test('cancellation before first dispatch prevents new sends',async t=>{
 const f=await fixture(t);
 f.sql.prepare('INSERT INTO cloudflare_action_cancellations(run_id,step_id,created_at) VALUES(?,?,1)').run(runId,'notify');
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'failed');
 assert.equal(f.sends(),0);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations').get()!.n,0);
});
test('missing reviewed deployment grant must fail closed',async t=>{
 const f=await fixture(t);
 f.plan.cloudflare_action_approvals=[];
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'failed');
 assert.equal(f.sends(),0);
});
test('concurrent replay contenders cannot each obtain the first-dispatch right',async t=>{
 const f=await fixture(t);
 const outcomes=await Promise.all(Array.from({length:6},()=>
  runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)));
 assert.equal(f.sends(),1);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations').get()!.n,1);
 assert.ok(outcomes.every(x=>['succeeded','indeterminate'].includes(x.status)));
});
test('cancellation after reservation does not permit resending; historical receipt remains queryable',async t=>{
 const f=await fixture(t);
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'succeeded');
 f.sql.prepare('INSERT INTO cloudflare_action_cancellations(run_id,step_id,created_at) VALUES(?,?,1)').run(runId,'notify');
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'succeeded');
 assert.equal(f.sends(),1);assert.equal(f.receipts(),1);
});
test('recovery rejects a previously frozen different deployment identity',async t=>{
 const f=await fixture(t);
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'succeeded');
 f.sql.prepare("UPDATE cloudflare_action_invocations SET deployment_id='44444444-4444-4444-8444-444444444444'").run();
 const x=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
 assert.equal(x.status,'indeterminate');assert.equal(f.sends(),1);assert.equal(f.receipts(),0);
});
test('bare Quick Tunnel root URL normalizes for Provider without altering signed D1 evidence',async t=>{
 const f=await fixture(t);
 f.sql.prepare("UPDATE session_executions SET session_url='https://safe.trycloudflare.com'").run();
 const x=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
 assert.equal(x.status,'succeeded');assert.equal(f.sends(),1);
 assert.equal(f.sql.prepare('SELECT input_digest FROM cloudflare_action_invocations').get()!.input_digest,bodyHash);
 assert.equal(f.sql.prepare('SELECT session_url FROM session_executions').get()!.session_url,'https://safe.trycloudflare.com');
});
test('non-root, invalid or ambiguous Quick Tunnel URLs are rejected before send',async t=>{
 for(const bad of ['https://safe.trycloudflare.com//','https://safe.trycloudflare.com/?k=v',
  'https://safe.trycloudflare.com/path','https://evil.example/','http://safe.trycloudflare.com/']){
  const f=await fixture(t);
  f.sql.prepare('UPDATE session_executions SET session_url=?').run(bad);
  const x=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
  assert.equal(x.status,'failed');assert.equal(f.sends(),0);
 }
});

test('public workflow_cancel durably blocks unsent Cloudflare Action and preserves physical Session',async t=>{
 const f=await fixture(t);
 const service=new WorkflowService(f.env);
 const result=await service.cancel(runId,'notify');
 assert.equal(result.cancellation,'requested');
 assert.equal(result.physical_terminated,false);
 assert.equal(f.sql.prepare('SELECT outcome FROM runs WHERE id=?').get(runId)!.outcome,'cancelled');
 assert.equal(f.sql.prepare('SELECT state FROM session_executions WHERE run_id=?').get(runId)!.state,'ready');
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'failed');
 assert.equal(f.sends(),0);
});
test('public workflow_cancel after a send reservation cannot claim external retraction',async t=>{
 const f=await fixture(t);
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'succeeded');
 const result=await new WorkflowService(f.env).cancel(runId,'notify');
 assert.equal(result.cancellation,'dispatched_may_complete');
 assert.equal(result.physical_terminated,false);
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'succeeded');
 assert.equal(f.sends(),1);
});

test('unreviewed live Provider Version ID fails before Workflow reserves a send',async t=>{
 const f=await fixture(t);
 f.env.ACTIONS!.getContract=async()=>({
  deployment_id:'44444444-4444-4444-8444-444444444444',
  contract_digest:(await cloudflareActionManifest()).contract_digest});
 const x=await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect);
 assert.equal(x.status,'failed');assert.equal(f.sends(),0);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations').get()!.n,0);
});

test('migration freeze wins atomically before a Weixin send reservation',async t=>{
 const f=await fixture(t);
 f.sql.prepare("UPDATE cloudflare_action_gate SET state='frozen',changed_at=1 WHERE id=1").run();
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'failed');
 assert.equal(f.sends(),0);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations').get()!.n,0);
});
test('old published Weixin grant can recover historical receipt after new active version',async t=>{
 const f=await fixture(t);
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'succeeded');
 f.env.ACTIONS_DEPLOYMENT_ID='44444444-4444-4444-8444-444444444444';
 f.sql.prepare("UPDATE cloudflare_action_gate SET state='frozen',changed_at=2 WHERE id=1").run();
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.notify,runId,f.inspect)).status,'succeeded');
 assert.equal(f.sends(),1);
 assert.equal(f.receipts(),1);
});
