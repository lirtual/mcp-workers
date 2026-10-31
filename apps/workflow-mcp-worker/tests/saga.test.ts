import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {compilePlan,PlanError} from '../src/plan.ts';
import {WORKFLOW_DEFINITION_SCHEMA,workflowCapabilities} from '../src/capabilities.ts';
import {compensateSession,compensateCancelledSessions,sagaReceiptId} from '../src/saga.ts';
import type {Env} from '../src/store.ts';
import type {requestGitHubActionCancellation} from '../src/github-action-cancel.ts';

const ACTION={
 repository:'lirtual/session-actions',repositoryId:1430925009,
 workflowId:395929968,workflowPath:'.github/workflows/ubuntu.yml',
 commitSha:'a'.repeat(40),type:'session' as const,contractDigest:'b'.repeat(64),
 ref:'refs/tags/v0.1.42-rc.8',inputs:{session_mode:'temporary',duration_mode:'explicit',duration_minutes:5},
};
const step=(id:string,needs:string[]=[])=>({
 id,uses:'github.run' as const,needs,
 with:{capability:'github.action',action:ACTION},
 compensate:{kind:'github.session.cancel'},
});
const sample=()=>({version:1,name:'Temporary Session saga',saga:{on:['failure','cancel']},
 steps:[step('first'),step('second',['first']),
  {id:'last',needs:['second'],uses:'result.emit',with:{data:'ok'}}],
});

test('Saga compiler requires declared policy, reviewed temporary Session compensation and ordered DAG',async()=>{
 const compiled=await compilePlan(sample());
 assert.deepEqual(compiled.plan.saga,{on:['failure','cancel']});
 assert.deepEqual(compiled.plan.steps.slice(0,2).map(x=>x.id),['first','second']);
 assert.equal(compiled.plan.steps[0]?.compensate?.kind,'github.session.cancel');
 assert.equal((await compilePlan(sample())).digest,compiled.digest);
 for(const invalid of [
  {...sample(),saga:undefined},
  {...sample(),saga:{on:['unexpected']}},
  {...sample(),steps:[{...step('first'),compensate:undefined}]},
  {...sample(),steps:[{...step('first'),with:{capability:'github.action',
    action:{...ACTION,inputs:{...ACTION.inputs,session_mode:'fixed'}}}}]},
  {...sample(),steps:[{...step('first'),with:{capability:'github.action',
    action:{...ACTION,workflowPath:'.github/workflows/download.yml'}}}]},
  {...sample(),steps:[{...step('first'),with:{capability:'github.action',
    action:{...ACTION,workflowPath:'.github/workflows/windows.yml',
      inputs:{...ACTION.inputs,session_mode:'fixed'}}}}]},
  {...sample(),steps:[{...step('first'),compensate:{kind:'arbitrary.write'}}]},
  {...sample(),steps:[step('first'),{id:'effect',uses:'http.request',with:{url:'https://example.com/',method:'POST',body:{}}}]},
 ])await assert.rejects(()=>compilePlan(invalid),PlanError);
 const props=WORKFLOW_DEFINITION_SCHEMA.properties;
 assert.ok(props.saga);
 assert.deepEqual(props.steps.items.properties.compensate.properties.kind.const,'github.session.cancel');
 const details=await workflowCapabilities({} as Env,'flow.saga');
 assert.equal(details.availability,'supported_with_grant');
 assert.equal((details.design_contract as {executable:boolean}).executable,true);
 assert.match((details.design_contract as {authorization:string}).authorization,/approve_heavy_execution/);
});

test('Compensator persists exactly one reservation; a cancellation ACK remains only requested',async t=>{
 const sql=new DatabaseSync(':memory:');
 t.after(()=>sql.close());
 sql.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY);
  CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT,updated_at INTEGER,PRIMARY KEY(run_id,step_id));
  CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT);
  INSERT INTO runs VALUES ('run');
  INSERT INTO run_steps VALUES ('run','first','succeeded',0),('run','second','succeeded',0);
  INSERT INTO session_executions VALUES ('run','first','ready'),('run','second','ready');`);
 const db={
  prepare(query:string){
   let args:unknown[]=[];
   return {
    bind(...values:unknown[]){args=values;return this;},
    async run(){return {meta:{changes:sql.prepare(query).run(...args as string[]).changes}};},
    async first<T>(){return sql.prepare(query).get(...args as string[]) as T|null;},
   };
  }
 } as unknown as Env['DB'];
 const {plan}=await compilePlan(sample());
 const granted={...plan,github_execution_approved:true as const,saga_compensation_approved:true as const,
  github_action_approvals:[{repository:ACTION.repository,repositoryId:ACTION.repositoryId,
   workflowId:ACTION.workflowId,workflowPath:ACTION.workflowPath,
   commitSha:ACTION.commitSha,type:ACTION.type,contractDigest:ACTION.contractDigest}]};
 const env={DB:db,WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token'} as Env;
 let calls=0;
 const cancel=(async()=>{calls++;return 'cancel_requested';}) as typeof requestGitHubActionCancellation;
 assert.equal(await compensateSession(env,{...granted,github_execution_approved:undefined},
   'run',plan.steps[1]!,cancel),'uncleared',
   'compensation requires both the exact Action grant and GitHub execution approval');
 assert.equal(calls,0,'an unapproved compensation must not dispatch a cancel POST');
 assert.equal(sql.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
   .get('run',sagaReceiptId('second'))?.status,'uncleared',
   'denied compensation must persist a truthful uncleared receipt');
 assert.equal(await compensateSession(env,granted,'run',plan.steps[1]!,cancel),'uncleared',
   'later approval must not silently replay an already-denied compensation');
 assert.equal(calls,0);
 assert.equal(await compensateSession(env,granted,'run',plan.steps[0]!,cancel),'requested');
 assert.equal(await compensateSession(env,granted,'run',plan.steps[0]!,cancel),'requested');
 assert.equal(calls,1,'unknown/replayed rollback must not send a second cancellation');
 assert.equal(sql.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
   .get('run',sagaReceiptId('first'))?.status,'requested');
 assert.equal(await compensateSession(env,{...granted,saga_compensation_approved:undefined},
   'run',plan.steps[0]!,cancel),'uncleared');
 assert.equal(calls,1,'removed exact Publish grant must never dispatch');
});


test('explicit cancellation fallback handles RollbackMissing in reverse order without crossing grant boundaries',async()=>{
 const {plan}=await compilePlan(sample());
 const approved={...plan,saga_compensation_approved:true as const};
 const called:string[]=[];
 const callback=(async (_env:Env,_plan:typeof plan,_runId:string,step:typeof plan.steps[number])=>{
   called.push(step.id);
   if(step.id==='second')throw Error('rollback_transport_unknown');
   return 'requested' as const;
 }) as typeof compensateSession;
 await compensateCancelledSessions({} as Env,approved,'test-run',callback);
 assert.deepEqual(called,['second','first'],
   'independent earlier compensation must proceed despite later failure');
 called.length=0;
 await compensateCancelledSessions({} as Env,{...approved,saga:{on:['failure']}},'test-run',callback);
 await compensateCancelledSessions({} as Env,{...approved,saga_compensation_approved:undefined},
   'test-run',callback);
 assert.deepEqual(called,[],'no undeclared cancellation trigger or missing grant');
});

test('partial Session compensation continues in reverse order without replaying an unknown cancellation',async t=>{
 const sql=new DatabaseSync(':memory:');
 t.after(()=>sql.close());
 sql.exec(`CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT,updated_at INTEGER,
   PRIMARY KEY(run_id,step_id));
  CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT);
  INSERT INTO run_steps VALUES ('run','first','succeeded',0),('run','second','succeeded',0);
  INSERT INTO session_executions VALUES ('run','first','ready'),('run','second','ready');`);
 const db={prepare(query:string){
  let args:unknown[]=[];
  return {
   bind(...values:unknown[]){args=values;return this;},
   async run(){return {meta:{changes:sql.prepare(query).run(...args as string[]).changes}};},
   async first<T>(){return sql.prepare(query).get(...args as string[]) as T|null;},
  };
 }} as unknown as Env['DB'];
 const {plan}=await compilePlan(sample());
 const granted={...plan,github_execution_approved:true as const,saga_compensation_approved:true as const,
  github_action_approvals:[{repository:ACTION.repository,repositoryId:ACTION.repositoryId,
   workflowId:ACTION.workflowId,workflowPath:ACTION.workflowPath,
   commitSha:ACTION.commitSha,type:ACTION.type,contractDigest:ACTION.contractDigest}]};
 const env={DB:db,WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token'} as Env;
 const calls:string[]=[];
 const cancel=(async (_db:Parameters<typeof requestGitHubActionCancellation>[0],_runId:string,stepId:string)=>{
  calls.push(stepId);
  if(stepId==='second')throw Error('lost_cancel_ack');
  return 'cancel_requested';
 }) as typeof requestGitHubActionCancellation;
 const compensate=(async (target:Env,p:typeof plan,run:string,current:typeof plan.steps[number])=>
  compensateSession(target,p,run,current,cancel)) as typeof compensateSession;
 await compensateCancelledSessions(env,granted,'run',compensate);
 assert.deepEqual(calls,['second','first'],'one unknown compensation must not block an earlier step');
 const receipt=(id:string)=>sql.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
   .get('run',sagaReceiptId(id))?.status;
 assert.equal(receipt('second'),'indeterminate');
 assert.equal(receipt('first'),'requested');
 await compensateCancelledSessions(env,granted,'run',compensate);
 assert.deepEqual(calls,['second','first'],'replay must not issue a second external cancellation');
});

test('independent parallel Saga branches preserve each exact grant and an uncleared branch cannot block approved cancellation',async t=>{
 const sql=new DatabaseSync(':memory:');
 t.after(()=>sql.close());
 sql.exec(`CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT,updated_at INTEGER,
   PRIMARY KEY(run_id,step_id));
  CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT);
  INSERT INTO run_steps VALUES ('run','alpha','succeeded',0),('run','beta','succeeded',0);
  INSERT INTO session_executions VALUES ('run','alpha','ready'),('run','beta','ready');`);
 const db={prepare(query:string){
  let args:unknown[]=[];
  return {
   bind(...values:unknown[]){args=values;return this;},
   async run(){return {meta:{changes:sql.prepare(query).run(...args as string[]).changes}};},
   async first<T>(){return sql.prepare(query).get(...args as string[]) as T|null;},
  };
 }} as unknown as Env['DB'];
 // Two independent forward branches share a later fan-in; only alpha retains
 // the exact reviewed GitHub Action grant when compensation is requested.
 const betaAction={...ACTION,commitSha:'c'.repeat(40)};
 const definition={...sample(),steps:[
  step('alpha'),
  {...step('beta'),with:{capability:'github.action',action:betaAction}},
  {id:'join',needs:['alpha','beta'],uses:'result.emit',with:{data:'ok'}},
 ]};
 const {plan}=await compilePlan(definition);
 assert.deepEqual(plan.steps.slice(0,2).map(s=>s.id),['alpha','beta']);
 assert.deepEqual(plan.steps.find(s=>s.id==='alpha')?.needs,[]);
 assert.deepEqual(plan.steps.find(s=>s.id==='beta')?.needs,[]);
 const granted={...plan,github_execution_approved:true as const,saga_compensation_approved:true as const,
  github_action_approvals:[{repository:ACTION.repository,repositoryId:ACTION.repositoryId,
   workflowId:ACTION.workflowId,workflowPath:ACTION.workflowPath,commitSha:ACTION.commitSha,
   type:ACTION.type,contractDigest:ACTION.contractDigest}]};
 const env={DB:db,WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token'} as Env;
 const calls:string[]=[];
 const cancel=(async (_db:Parameters<typeof requestGitHubActionCancellation>[0],
    _runId:string,stepId:string)=>{
  calls.push(stepId);return 'cancel_requested' as const;
 }) as typeof requestGitHubActionCancellation;
 const compensate=(async(target:Env,p:typeof plan,run:string,current:typeof plan.steps[number])=>
  compensateSession(target,p,run,current,cancel)) as typeof compensateSession;
 await compensateCancelledSessions(env,granted,'run',compensate);
 const receipt=(id:string)=>sql.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
   .get('run',sagaReceiptId(id))?.status;
 assert.deepEqual(calls,['alpha'],'the revoked branch must not dispatch or prevent an independent approved branch');
 assert.equal(receipt('beta'),'uncleared','the unsafe live resource must remain visibly uncleaned');
 assert.equal(receipt('alpha'),'requested','ACK is not proof of physical termination');
 await compensateCancelledSessions(env,granted,'run',compensate);
 assert.deepEqual(calls,['alpha'],'neither branch may silently replay a compensation');
});


test('source-reviewed temporary Windows Session uses the same one-shot GitHub cancellation fence',async t=>{
 const windows={...ACTION,workflowPath:'.github/workflows/windows.yml',
  workflowId:395929969,commitSha:'c'.repeat(40),contractDigest:'d'.repeat(64),
  ref:'refs/tags/v0.1.42-rc.9'};
 const {plan}=await compilePlan({version:1,name:'Windows Session Saga',
  saga:{on:['failure','cancel']},steps:[
   {...step('windows'),with:{capability:'github.action',action:windows}},
   {id:'fail',needs:['windows'],uses:'result.emit',with:{data:'done'}},
  ]});
 const sql=new DatabaseSync(':memory:');
 t.after(()=>sql.close());
 sql.exec(`CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT,updated_at INTEGER,
    PRIMARY KEY(run_id,step_id));
   CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT);
   INSERT INTO run_steps VALUES ('run','windows','succeeded',0);
   INSERT INTO session_executions VALUES ('run','windows','ready');`);
 const db={prepare(query:string){
  let args:unknown[]=[];
  return {
   bind(...values:unknown[]){args=values;return this;},
   async run(){return {meta:{changes:sql.prepare(query).run(...args as string[]).changes}};},
   async first<T>(){return sql.prepare(query).get(...args as string[]) as T|null;},
  };
 }} as unknown as Env['DB'];
 const granted={...plan,github_execution_approved:true as const,saga_compensation_approved:true as const,
  github_action_approvals:[{repository:windows.repository,repositoryId:windows.repositoryId,
   workflowId:windows.workflowId,workflowPath:windows.workflowPath,commitSha:windows.commitSha,
   type:windows.type,contractDigest:windows.contractDigest}]};
 const env={DB:db,WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token'} as Env;
 let calls=0;
 const cancel=(async()=>{calls++;return 'cancel_requested';}) as typeof requestGitHubActionCancellation;
 assert.equal(await compensateSession(env,granted,'run',plan.steps[0]!,cancel),'requested');
 assert.equal(await compensateSession(env,granted,'run',plan.steps[0]!,cancel),'requested');
 assert.equal(calls,1,'a Windows Session cancel ACK never establishes physical termination or permits replay');
 assert.equal(sql.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
  .get('run',sagaReceiptId('windows'))?.status,'requested');
});
