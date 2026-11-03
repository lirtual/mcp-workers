import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {WorkflowService,type Env} from '../src/store.ts';
import {cloudflareActionManifest,isRetiredWeixinAction} from '../src/cloudflare-action-contract.ts';

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

test('a reserved old Weixin send stays possibly dispatched when cancellation is requested',async t=>{
 for(const reserved of [true,false]){
  await t.test(reserved?'reserved':'not reserved',async sub=>{
   const f=await fixture(sub,'active','running','started');
   if(reserved)f.sqlite.prepare(`INSERT INTO cloudflare_action_invocations
     (run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,
      contract_digest,deployment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(run,'notify','legacy-reservation','original-attempt',digest,1,'reviewed-old-contract',version,1);
   const result=await f.service.cancel(run,'notify');
   assert.equal(result.cancellation,reserved?'dispatched_may_complete':'requested');
   assert.equal(result.physical_terminated,false);
   const current=f.sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(run) as {outcome:string};
   assert.equal(current.outcome,reserved?'running':'cancelled');
   const count=f.sqlite.prepare('SELECT COUNT(*) AS n FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?')
    .get(run,'notify') as {n:number};
   assert.equal(count.n,reserved?1:0,'preserve the original send-reservation identity');
  });
 }
});

test('Weixin reservation attribution follows the original Run/Version/Step, not binding generation',async t=>{
 const f=await fixture(t,'active','indeterminate','started');
 const otherWf='44444444-4444-4444-8444-444444444444';
 const otherVersion='55555555-5555-4555-8555-555555555555';
 const otherRun='66666666-6666-4666-8666-666666666666';
 const barkPlan=JSON.stringify({version:1,name:'Different provider',steps:[{
  id:'notify',uses:'action.run',with:{executor:'cloudflare',provider:'bark',
   action:'bark.send_notification',input:{body:'synthetic'}}}]});
 f.sqlite.prepare('INSERT INTO workflows(id,name,draft,state,active_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .run(otherWf,'Other',barkPlan,'active',otherVersion,1,1);
 f.sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
  .run(otherVersion,otherWf,'synthetic-digest',barkPlan,1);
 f.sqlite.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,
  start_state,outcome,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  .run(otherRun,otherWf,otherVersion,otherRun,digest,'{}','started','succeeded',1,1);
 const insert=f.sqlite.prepare(`INSERT INTO cloudflare_action_invocations
  (run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,
   contract_digest,deployment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
 insert.run(run,'notify','weixin-invocation','attempt-1',digest,1,'shared-contract','same-deployment',1);
 insert.run(otherRun,'notify','bark-invocation','attempt-2',digest,1,'shared-contract','same-deployment',1);
 // Historical aliases are broader than two exact Action names. Reuse the
 // runtime identity predicate against the original compiled Plan Step instead
 // of drifting into an independently maintained SQL Action allowlist.
 const aliasWf='77777777-7777-4777-8777-777777777777';
 const aliasVersion='88888888-8888-4888-8888-888888888888';
 const aliasRun='99999999-9999-4999-8999-999999999999';
 const aliasPlan=JSON.stringify({version:1,name:'Legacy alias',steps:[{
  id:'notify',uses:'action.run',with:{executor:'cloudflare',provider:'bark',
   action:'WeIxIn_legacy',input:{text:'synthetic'}}}]});
 f.sqlite.prepare('INSERT INTO workflows(id,name,draft,state,active_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .run(aliasWf,'Alias',aliasPlan,'paused',aliasVersion,1,1);
 f.sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
  .run(aliasVersion,aliasWf,'alias-digest',aliasPlan,1);
 f.sqlite.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,
  start_state,outcome,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  .run(aliasRun,aliasWf,aliasVersion,aliasRun,digest,'{}','started','indeterminate',1,1);
 insert.run(aliasRun,'notify','weixin-alias-invocation','attempt-3',digest,0,
  'shared-contract','same-deployment',1);
 // An unmatched Step is indeterminate, not a certified non-Weixin reservation.
 insert.run(aliasRun,'not-a-plan-step','unknown-step-invocation','attempt-4',digest,0,
  'shared-contract','same-deployment',1);
 const attribution=f.sqlite.prepare(`SELECT i.invocation_id,s.value AS step_json
  FROM cloudflare_action_invocations i
  JOIN runs r ON r.id=i.run_id
  JOIN workflow_versions v ON v.id=r.version_id
  LEFT JOIN json_each(v.plan,'$.steps') s
   ON json_extract(s.value,'$.id')=i.step_id
  ORDER BY i.invocation_id`);
 const rows=attribution.all() as Array<{invocation_id:string;step_json:string|null}>;
 const total=(f.sqlite.prepare('SELECT COUNT(*) n FROM cloudflare_action_invocations')
  .get() as {n:number}).n;
 assert.equal(rows.length,total,'all reservation rows must be accounted for');
 const matches=rows.filter(x=>x.step_json!==null&&
  isRetiredWeixinAction(JSON.parse(x.step_json))).map(x=>x.invocation_id);
 assert.deepEqual(matches,['weixin-alias-invocation','weixin-invocation']);
 assert.deepEqual(rows.filter(x=>x.step_json===null).map(x=>x.invocation_id),
  ['unknown-step-invocation'],'unmatched original Step remains indeterminate');
 assert.equal(total,4);
 // A corrupted immutable Plan with duplicate Step IDs creates a one-to-many
 // join. The reservation cardinality check must stop attribution, not treat
 // either matched Step as safe evidence for deleting that invocation.
 const duplicateAliasPlan=JSON.stringify({version:1,name:'Ambiguous old Plan',steps:[
  {id:'notify',uses:'action.run',with:{executor:'cloudflare',
   provider:'bark',action:'WeIxIn_legacy'}},
  {id:'notify',uses:'action.run',with:{executor:'cloudflare',
   provider:'bark',action:'bark.send_notification'}},
 ]});
 f.sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
  .run(duplicateAliasPlan,aliasVersion);
 const ambiguousRows=attribution.all() as Array<{invocation_id:string;step_json:string|null}>;
 assert.equal(ambiguousRows.length,total+1);
 assert.throws(()=>assert.equal(ambiguousRows.length,total,
  'each reservation must resolve to at most one original Plan Step'),
 {name:'AssertionError'});
 // An invalid stored Plan cannot be interpreted as a safe nonmatch.
 f.sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
  .run('{invalid historical json',aliasVersion);
 assert.throws(()=>attribution.all(),/malformed JSON/i);
 f.sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
  .run(aliasPlan,aliasVersion);
 // The shared reservation schema has no run_id FK. If a historic Run is
 // missing, the inner join loses a row; total cardinality still rejects it.
 insert.run('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','notify',
  'orphan-invocation','attempt-5',digest,0,'shared-contract','same-deployment',1);
 const orphanRows=attribution.all() as Array<{invocation_id:string;step_json:string|null}>;
 assert.equal(orphanRows.length,total);
 const nowTotal=(f.sqlite.prepare('SELECT COUNT(*) n FROM cloudflare_action_invocations')
  .get() as {n:number}).n;
 assert.equal(nowTotal,total+1);
 assert.throws(()=>assert.equal(orphanRows.length,nowTotal,
  'all original reservations require a complete Run/Plan link'),
 {name:'AssertionError'});
 // No WorkflowService writes or physical sends were made by classification.
 assert.equal(f.counters.write,0);
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
