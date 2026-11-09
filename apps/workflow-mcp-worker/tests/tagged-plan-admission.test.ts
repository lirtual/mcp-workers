import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {WorkflowService,type Env} from '../src/store.ts';
import {hasHistoricalTaggedGitHubAction} from '../src/github-action-main.ts';
import {canonicalJsonString} from '../src/plan.ts';

const wf='11111111-1111-4111-8111-111111111111';
const version='22222222-2222-4222-8222-222222222222';
const run='33333333-3333-4333-8333-333333333333';
const action={repository:'lirtual/github-actions',repositoryId:1430925009,workflowId:1,
 workflowPath:'.github/workflows/ubuntu.yml',commitSha:'a'.repeat(40),type:'session',
 contractDigest:'b'.repeat(64)};

function taggedPlan(ref='refs/tags/v0.1.43-rc.2'){
 return {version:1,name:'Historical tag',github_execution_approved:true,
  github_action_approvals:[action],steps:[{id:'ubuntu_session',uses:'github.run',with:{
   capability:'github.action',action:{...action,ref,inputs:{duration_minutes:5}}}}]};
}

async function digest(value:unknown){
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJsonString(value)));
 return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function fixture(t:test.TestContext,state:string,plan:unknown,withRun=false){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
  '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql',
  '0006_action_attempt_capabilities.sql','0007_session_executions.sql',
  '0008_session_locator.sql','0009_fixed_sessions.sql',
  '0011_awaited_child_capacity.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const planJSON=JSON.stringify(plan);
 sqlite.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,active_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(wf,'Legacy',planJSON,1,state,version,1,1);
 sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
  .run(version,wf,'old_digest',planJSON,1);
 if(withRun)sqlite.prepare('INSERT INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run(run,wf,version,run,'old-key',await digest({}),'{}','started','succeeded',1,1);
 const counters={create:0};
 const db={prepare(sql:string){
  let binds:unknown[]=[];
  return {bind(...args:unknown[]){binds=args;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...binds as never[])??null) as T|null;},
   async all<T>(){return {results:sqlite.prepare(sql).all(...binds as never[]) as T[]};},
   async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...binds as never[]).changes)}};}};
 }} as unknown as Env['DB'];
 const service=new WorkflowService({DB:db,WORKFLOW:{
  create(){counters.create++;return {};},
  get(){throw Error('native get forbidden');},
 }} as unknown as Env);
 return {sqlite,service,counters,planJSON};
}

test('tag detection sees top-level and foreach actions, not ordinary text',()=>{
 assert.equal(hasHistoricalTaggedGitHubAction(taggedPlan()),true);
 assert.equal(hasHistoricalTaggedGitHubAction(taggedPlan('refs/heads/main')),false);
 assert.equal(hasHistoricalTaggedGitHubAction({steps:[{id:'note',uses:'result.emit',
  with:{data:'refs/tags/v1'}}]}),false);
 assert.equal(hasHistoricalTaggedGitHubAction({steps:[{id:'each',flow:'foreach',with:{
  template:{steps:[{id:'task',uses:'github.run',with:{action:{ref:'refs/tags/task-v1'}}}]}}}]}),true);
});

test('paused tagged Plan cannot resume and its row stays unchanged',async t=>{
 const f=await fixture(t,'paused',taggedPlan());
 await assert.rejects(f.service.resume(wf),/tagged_plan_admission_retired/);
 assert.equal((f.sqlite.prepare('SELECT state FROM workflows WHERE id=?').get(wf) as {state:string}).state,'paused');
 assert.equal((f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version) as {plan:string}).plan,f.planJSON);
 assert.equal(f.counters.create,0);
});

test('active tagged Plan rejects a new Run and still replays the old one',async t=>{
 const f=await fixture(t,'active',taggedPlan(),true);
 await assert.rejects(f.service.start(wf,{},'new-key'),/tagged_plan_admission_retired/);
 const replay=await f.service.start(wf,{},'old-key');
 assert.equal(replay.run_id,run);
 assert.equal(replay.status,'succeeded');
 assert.equal(replay.idempotent_replay,true);
 const status=await f.service.status(run);
 assert.equal(status.status,'succeeded');
 assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get() as {n:number}).n,1);
 assert.equal((f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version) as {plan:string}).plan,f.planJSON);
 assert.equal(f.counters.create,0);
});

test('current main Plan can resume',async t=>{
 const f=await fixture(t,'paused',taggedPlan('refs/heads/main'));
 assert.deepEqual(await f.service.resume(wf),{workflow_id:wf,state:'active'});
 assert.equal((f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version) as {plan:string}).plan,f.planJSON);
});
