import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {WorkflowService,type Env} from '../src/store.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';

const wf='11111111-1111-4111-8111-111111111111';
const version='22222222-2222-4222-8222-222222222222';
const run='33333333-3333-4333-8333-333333333333';
const digest=createHash('sha256').update('{}').digest('hex');

async function fixture(t:test.TestContext,state='active',outcome='succeeded',start='started'){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
  '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql',
  '0006_action_attempt_capabilities.sql','0007_session_executions.sql',
  '0011_awaited_child_capacity.sql',
  '0013_cloudflare_action_invocations.sql','0018_cloudflare_action_migration_fence.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const legacy=await cloudflareActionManifest('unified-generic');
 const plan={version:1,name:'Immutable Weixin history',steps:[{id:'notify',uses:'action.run',
  with:{executor:'cloudflare',provider:'weixin',action:'weixin.send_text',
   contract_digest:legacy.contract_digest,input:{text:'recorded old payload'}}}],
  cloudflare_execution_approved:true,cloudflare_action_approvals:[{
   executor:'cloudflare',provider:'weixin',action:'weixin.send_text',
   contract_digest:legacy.contract_digest,deployment_id:version}]};
 const planJSON=JSON.stringify(plan);
 sqlite.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,active_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(wf,'Legacy',planJSON,1,state,version,1,1);
 sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
  .run(version,wf,'old_digest',planJSON,1);
 sqlite.prepare('INSERT INTO runs(id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  .run(run,wf,version,run,'old-key',digest,'{}',start,outcome,1,1);
 sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,?,1)")
  .run(run,'notify',outcome);
 const counters={create:0,get:0,write:0};
 const db={prepare(sql:string){
  let binds:unknown[]=[];
  return {bind(...args:unknown[]){binds=args;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...binds as any[])??null) as T|null;},
   async all<T>(){return {results:sqlite.prepare(sql).all(...binds as any[]) as T[]};},
   async run(){counters.write++;return {meta:{changes:Number(sqlite.prepare(sql).run(...binds as any[]).changes)}};}};
 }} as unknown as Env['DB'];
 const service=new WorkflowService({DB:db,WORKFLOW:{
  create(){counters.create++;return {};},
  get(){counters.get++;throw Error('native get forbidden');},
 }} as unknown as Env);
 return {sqlite,service,counters,planJSON};
}

test('old terminal idempotency keys preserve identity, Run/Step status and immutable Plan without native access',async t=>{
 for(const outcome of ['succeeded','failed','indeterminate','cancelled']){
  await t.test(outcome,async sub=>{
   const f=await fixture(sub,'active',outcome,'start_unknown');
   const before=f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version) as {plan:string};
   const result=await f.service.start(wf,{},'old-key');
   assert.equal(result.run_id,run);
   assert.equal(result.status,outcome);
   assert.equal(result.start_state,'start_unknown');
   assert.equal(result.idempotent_replay,true);
   const status=await f.service.status(run);
   assert.equal(status.run_id,run);
   assert.equal(status.status,outcome);
   assert.equal(status.steps[0]?.status,outcome);
   assert.equal((f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version) as {plan:string}).plan,before.plan);
   assert.deepEqual(f.counters,{create:0,get:0,write:0});
  });
 }
});

test('old start_unknown and queued reservations can be inspected but never repaired or re-created',async t=>{
 for(const [outcome,start] of [['queued','start_unknown'],['queued','reserved'],['running','started']]){
  await t.test(outcome+'/'+start,async sub=>{
   const f=await fixture(sub,'active',outcome,start);
   const original=await f.service.status(run);
   assert.equal(original.start_state==='started'?'started':original.status,
    original.start_state==='started'?'started':'start_unknown');
   await assert.rejects(f.service.start(wf,{},'old-key'),/weixin_action_retired/);
   assert.deepEqual(f.counters,{create:0,get:0,write:0});
  });
 }
});

test('retired Published Weixin Plan cannot resume or accept new Run with any idempotency key',async t=>{
 const paused=await fixture(t,'paused','succeeded','started');
 await assert.rejects(paused.service.resume(wf),/weixin_action_retired/);
 assert.equal((paused.sqlite.prepare('SELECT state FROM workflows WHERE id=?').get(wf) as {state:string}).state,'paused');
 const active=await fixture(t,'active','succeeded','started');
 await assert.rejects(active.service.start(wf,{},'another-key'),/weixin_action_retired/);
 assert.equal(active.counters.create,0);
 assert.equal((active.sqlite.prepare('SELECT COUNT(*) AS count FROM runs').get() as {count:number}).count,1);
});


test('stale historical Weixin start cannot block unrelated reviewed Workflow admission',async t=>{
 const f=await fixture(t,'active','queued','start_unknown');
 const other='44444444-4444-4444-8444-444444444444';
 const newVersion='55555555-5555-4555-8555-555555555555';
 const current={version:1,name:'Unaffected new workflow',
  steps:[{id:'emit',uses:'result.emit',with:{data:'safe'}}]};
 const json=JSON.stringify(current);
 f.sqlite.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,active_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(other,'Other',json,1,'active',newVersion,1,1);
 f.sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,1)')
  .run(newVersion,other,'new',json);
 const result=await f.service.start(other,{},'new-safe-key');
 assert.equal(result.status,'queued');
 assert.equal(result.start_state,'started');
 assert.equal(f.counters.create,1,'only the unrelated new workflow was created');
 const old=f.sqlite.prepare('SELECT outcome,start_state FROM runs WHERE id=?').get(run) as
  {outcome:string;start_state:string};
 assert.equal(old.outcome,'queued');
 assert.equal(old.start_state,'start_unknown');
});
