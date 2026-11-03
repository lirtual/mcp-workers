import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {compilePlan} from '../src/plan.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {runBarkAction} from '../src/bark-action-executor.ts';
import type {Env} from '../src/store.ts';
import type {Plan,Step} from '../src/plan.ts';

const runId='11111111-1111-4111-8111-111111111111';
const attemptId='22222222-2222-4222-8222-222222222222';
const version='33333333-3333-4333-8333-333333333333';
const rawUrl='https://safe.trycloudflare.com';
const url=rawUrl+'/';
const sourceAction={repository:'lirtual/github-actions',repositoryId:123,
 workflowId:456,workflowPath:'.github/workflows/chrome.yml',
 commitSha:'a'.repeat(40),type:'session',contractDigest:'b'.repeat(64),
 ref:'refs/tags/v1',inputs:{duration_minutes:{ref:'inputs.duration_minutes'},duration_mode:'explicit'}};

async function fixture(t:test.TestContext){
 const manifest=await cloudflareActionManifest('bark');
 const chrome:Step={id:'chrome_session',uses:'github.run',needs:[],
  with:{capability:'github.action',action:sourceAction}};
 const bark:Step={id:'notify_bark',uses:'action.run',needs:['chrome_session'],
  with:{executor:'cloudflare',provider:'bark',action:'bark.send_notification',
   contract_digest:manifest.contract_digest,
   input:{session_step_id:'chrome_session',notification:{
    title:'Chrome Session Ready',body:'Open the temporary session',ttl:600}}}};
 const plan:Plan={version:1,name:'Chrome via Bark',inputs:{duration_minutes:300},
  steps:[chrome,bark],cloudflare_execution_approved:true,
  cloudflare_action_approvals:[{executor:'cloudflare',provider:'bark',
   action:'bark.send_notification',contract_digest:manifest.contract_digest,
   deployment_id:version}]};
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT);");
 sql.prepare('INSERT INTO runs VALUES(?,?)').run(runId,'running');
 for(const n of ['0013_cloudflare_action_invocations.sql','0018_cloudflare_action_migration_fence.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
 sql.exec("CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT,session_url TEXT);");
 sql.exec("CREATE TABLE step_attempts(run_id TEXT,step_id TEXT,attempt_id TEXT,state TEXT,capability_id TEXT,repository TEXT,workflow_ref TEXT,owner_run_id INTEGER,candidate_run_id INTEGER,owner_run_attempt INTEGER,candidate_run_attempt INTEGER);");
 sql.exec("CREATE TABLE github_action_cancellations(attempt_id TEXT);");
 sql.prepare('INSERT INTO session_executions VALUES(?,?,?,?)').run(runId,'chrome_session','ready',rawUrl);
 sql.prepare('INSERT INTO step_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(runId,'chrome_session',attemptId,'claimed','github.action','lirtual/github-actions','lirtual/github-actions/.github/workflows/chrome.yml@refs/tags/v1',42,42,1,1);
 const prepare=(query:string)=>{
  const bound=(args:unknown[])=>({
   first:async<T>()=>(sql.prepare(query).get(...(args as []))??null) as T|null,
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...(args as [])).changes)}}),
  });
  return {...bound([]),bind:(...args:unknown[])=>bound(args)};
 };
 let sends=0;
 const provider={getContract:async()=>({deployment_id:version,contract_digest:manifest.contract_digest}),
  execute:async(_action:string,input:any)=>{
   sends++;
   assert.equal(input.notification.url,url);
   assert.equal(input.notification.body,'Open the temporary session');
   return {status:'accepted',input_digest:input.input_digest};
  }};
 const env={DB:{prepare},ACTIONS:provider,ACTIONS_DEPLOYMENT_ID:version,
  WORKFLOW_GITHUB_DISPATCH_TOKEN:'fixture-token'} as unknown as Env;
 const ctx={inputs:{duration_minutes:10},steps:{chrome_session:{status:'succeeded'}}};
 const inspect=async()=>({state:'running' as const});
 return {sql,plan,bark,manifest,env,ctx,inspect,sends:()=>sends};
}
test('compiler accepts reviewed Chrome Ready to Bark and rejects unreviewed sources and URL injection',async t=>{
 const f=await fixture(t);
 const reviewed=structuredClone(f.plan);
 delete reviewed.cloudflare_execution_approved;
 delete reviewed.cloudflare_action_approvals;
 assert.equal((await compilePlan(reviewed)).plan.steps[1]?.uses,'action.run');
 for(const change of [
  (p:Plan)=>{p.steps[1]!.needs=[];},
  (p:Plan)=>{(p.steps[0]!.with.action as any).workflowPath='.github/workflows/windows.yml';},
  (p:Plan)=>{(p.steps[0]!.with.action as any).repository='untrusted/repo';},
  (p:Plan)=>{(p.steps[1]!.with.input as any).session_step_id='another';},
  (p:Plan)=>{(p.steps[1]!.with.input as any).notification.url='https://evil.example';},
 ]){
  const plan=structuredClone(reviewed);change(plan);
  await assert.rejects(compilePlan(plan));
 }
});
test('Bark sends signed live Chrome URL once; D1 receipt keeps only source ID and digest',async t=>{
 const f=await fixture(t);
 const first=await runBarkAction(f.env,f.plan,f.bark,runId,f.ctx,f.inspect);
 assert.equal(first.status,'succeeded');
 assert.equal((await runBarkAction(f.env,f.plan,f.bark,runId,f.ctx,f.inspect)).status,'indeterminate');
 assert.equal(f.sends(),1);
 const row=f.sql.prepare('SELECT * FROM cloudflare_action_invocations').get() as any;
 assert.equal(row.source_attempt_id,attemptId);
 assert.equal(row.binding_generation,0);
 assert(!JSON.stringify(row).includes(rawUrl));
});
test('Bark blocks mismatched tag, unready session, cancelled attempt, or ended physical Run',async t=>{
 for(const broken of ['tag','url','cancelled','physical'] as const){
  const f=await fixture(t);
  if(broken==='tag')f.sql.exec("UPDATE step_attempts SET workflow_ref='lirtual/github-actions/.github/workflows/chrome.yml@refs/tags/other'");
  if(broken==='url')f.sql.exec("UPDATE session_executions SET session_url='https://evil.example'");
  if(broken==='cancelled')f.sql.prepare('INSERT INTO github_action_cancellations VALUES(?)').run(attemptId);
  const inspect=async()=>({state:broken==='physical'?'unknown' as const:'running' as const});
  const result=await runBarkAction(f.env,f.plan,f.bark,runId,f.ctx,inspect);
  assert.equal(result.status,'failed',broken);
  assert.equal(f.sends(),0);
  assert.equal((f.sql.prepare('SELECT COUNT(*) AS c FROM cloudflare_action_invocations').get() as any).c,0);
 }
});
test('concurrent Ready or attempt revocation during live inspection blocks Bark D1 reservation',async t=>{
 for(const state of ['session_revoked','attempt_revoked'] as const){
  const f=await fixture(t);
  const inspect=async()=>{
   if(state==='session_revoked')
    f.sql.exec("UPDATE session_executions SET state='terminated' WHERE step_id='chrome_session'");
   else f.sql.exec("UPDATE step_attempts SET state='cancelled' WHERE step_id='chrome_session'");
   return {state:'running' as const};
  };
  const result=await runBarkAction(f.env,f.plan,f.bark,runId,f.ctx,inspect);
  assert.equal(result.status,'failed',state);
  assert.equal(f.sends(),0);
  assert.equal((f.sql.prepare('SELECT COUNT(*) AS n FROM cloudflare_action_invocations').get() as any).n,0);
 }
});

test('OpenList signed live Session uses the same Bark admission as Chrome',async t=>{
 const f=await fixture(t);
 (f.plan.steps[0]!.with.action as {workflowPath:string}).workflowPath='.github/workflows/openlist.yml';
 f.sql.exec("UPDATE step_attempts SET workflow_ref='lirtual/github-actions/.github/workflows/openlist.yml@refs/tags/v1'");
 const draft=structuredClone(f.plan);
 delete draft.cloudflare_execution_approved;
 delete draft.cloudflare_action_approvals;
 assert.equal((await compilePlan(draft)).plan.steps[1]!.uses,'action.run');
 assert.equal((await runBarkAction(f.env,f.plan,f.bark,runId,f.ctx,f.inspect)).status,'succeeded');
 assert.equal(f.sends(),1);
});
