import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {compilePlan} from '../src/plan.ts';
import {WorkflowService} from '../src/store.ts';
import {waitForRuntimeApproval,recordRuntimeApproval} from '../src/runtime-approval.ts';
import type {Env} from '../src/store.ts';
import type {WorkflowStep,WorkflowEvent} from 'cloudflare:workers';
const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkflowEntrypoint {constructor(ctx,env){this.env=env}}',shortCircuit:true};
  return next(specifier,context);
}});
const {WorkflowOrchestrator}=await import('../src/runner.ts');
hook.deregister();

const workflowId='11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
const versionId='33333333-3333-4333-8333-333333333333';
const action={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
 workflowPath:'.github/workflows/ubuntu.yml',commitSha:'a'.repeat(40),
 type:'task',contractDigest:'b'.repeat(64),ref:'refs/tags/v1',inputs:{}};
const definition={version:1,name:'Reviewed approved Task',steps:[
 {id:'run_task',uses:'github.run',approval:{required:true},
  with:{capability:'github.action',action}},
]};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const name of ['0001_s1.sql','0003_s3_attempt_claim.sql','0015_runtime_approval.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const prepare=(sql:string)=>{
  let args:unknown[]=[];
  return {bind(...values:unknown[]){args=values;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...args as any[])??null) as T|null;},
   async all<T>(){return {results:sqlite.prepare(sql).all(...args as any[]) as T[]};},
   async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as any[]).changes)}};}};
 };
 let wake:((value:unknown)=>void)|null=null;
 let wakeCount=0;
 const step={async do(_name:string,_opts:unknown,fn:()=>Promise<unknown>){return fn();},
  async waitForEvent(){return new Promise(resolve=>{wake=resolve;});}} as unknown as WorkflowStep;
 const batch=async(statements:Array<{run:()=>Promise<{meta:{changes:number}}>}> )=>{
  sqlite.exec('BEGIN');
  try{
    const results=[] as Array<{meta:{changes:number}}>;
    for(const statement of statements)results.push(await statement.run());
    sqlite.exec('COMMIT');
    return results;
  }catch(error){sqlite.exec('ROLLBACK');throw error;}
 };
 const env={DB:{prepare,batch},WORKFLOW:{async get(){return {async status(){return {status:'running'};},
  async sendEvent(){wakeCount++;wake?.({});}};}}} as unknown as Env;
 const service=new WorkflowService(env);
 const setup=async()=>{
  const {plan}=await compilePlan(definition);
  sqlite.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run(workflowId,'Approved Task',JSON.stringify(definition),1,'active',1,1);
  sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
   .run(versionId,workflowId,'testdigest',JSON.stringify({...plan,github_execution_approved:true}),1);
  sqlite.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'started','running',?,?)`)
   .run(runId,workflowId,versionId,runId,'inputdigest','{}',1,1);
 };
 const decide=(decision:'approve'|'deny',version=versionId,stepId='run_task',id=runId)=>
   service.approve(id,stepId,version,decision);
 const waiting=()=>waitForRuntimeApproval(env.DB,step,runId,'run_task',versionId,async()=>false);
 return {sqlite,prepare,env,service,step,setup,decide,waiting,get wakeCount(){return wakeCount;}};
}
test('compiler binds one optional GitHub approval and rejects unauthorized or widened shapes',async()=>{
 const {plan,digest}=await compilePlan(definition);
 assert.deepEqual(plan.steps[0].approval,{required:true});
 assert.equal(plan.github_execution_approved,undefined);
 assert.equal((await compilePlan(definition)).digest,digest);
 const fail=async(step:unknown)=>assert.rejects(()=>compilePlan({version:1,name:'bad',steps:[step]}));
 await fail({id:'x',uses:'result.emit',approval:{required:true},with:{data:'x'}});
 await fail({...definition.steps[0],approval:{required:true,scope:'admin'}});
 await fail({...definition.steps[0],approval:{required:false}});
 await fail({...definition.steps[0],with:{...definition.steps[0].with,approval:{required:true}}});
 await assert.rejects(()=>compilePlan({...definition,steps:[definition.steps[0],{
  ...definition.steps[0],id:'second_task'}]}),/multiple_approval_gates_unsupported/);
});
test('matching one-use decision unlocks waiting Run; wrong identity, repeat and conflicts fail closed',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  await assert.rejects(()=>ctx.decide('approve'),/approval_not_open/);
  const pending=ctx.waiting();
  for(let n=0;n<30;n++){
   if(ctx.sqlite.prepare('SELECT COUNT(*) n FROM runtime_approval_gates').get()!.n)break;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  assert.equal(ctx.sqlite.prepare('SELECT status FROM run_steps').get()!.status,'waiting_approval');
  await assert.rejects(()=>ctx.decide('approve','44444444-4444-4444-8444-444444444444'),/approval_binding_mismatch/);
  await assert.rejects(()=>ctx.decide('approve',versionId,'unknown'),/approval_not_required/);
  await assert.rejects(()=>ctx.decide('approve',versionId,'run_task','55555555-5555-4555-8555-555555555555'),/run_not_found/);
  const result=await ctx.decide('approve');assert.equal(result.recorded,true);
  assert.equal(result.dispatch_confirmed,false);
  assert.equal(ctx.wakeCount,1);
  await assert.rejects(()=>ctx.decide('approve'),/approval_already_recorded/);
  await assert.rejects(()=>ctx.decide('deny'),/approval_conflict/);
  assert.deepEqual(await pending,{ok:true});
  const row=ctx.sqlite.prepare('SELECT decision,consumed_at FROM runtime_approvals').get()!;
  assert.equal(row.decision,'approved');assert.equal(typeof row.consumed_at,'number');
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM runtime_approvals').get()!.n,1);
  assert.equal(ctx.wakeCount,1);
 }finally{ctx.sqlite.close();}
});
test('denial, expiry, and inactive Run cannot authorize dispatch',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  const pending=ctx.waiting();
  for(let n=0;n<30;n++){
   if(ctx.sqlite.prepare('SELECT COUNT(*) n FROM runtime_approval_gates').get()!.n)break;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  await ctx.decide('deny');
  assert.deepEqual(await pending,{ok:false,error_code:'approval_denied'});
  assert.equal(ctx.sqlite.prepare('SELECT consumed_at FROM runtime_approvals').get()!.consumed_at,null);
  ctx.sqlite.prepare('UPDATE runtime_approval_gates SET deadline_at=0').run();
  await assert.rejects(()=>ctx.decide('approve'),/approval_not_open/);
  ctx.sqlite.prepare("UPDATE runs SET outcome='failed'").run();
  await assert.rejects(()=>ctx.decide('approve'),/approval_run_not_active/);
 }finally{ctx.sqlite.close();}
});

test('full native runner refuses GitHub dispatch when owner explicitly denies the waiting gate',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  let settled=false;
  const execute=new WorkflowOrchestrator({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:runId}} as WorkflowEvent<{run_id:string}>,ctx.step)
    .then(()=>{settled=true;});
  for(let n=0;n<100;n++){
   if(ctx.sqlite.prepare("SELECT status FROM run_steps WHERE step_id='run_task'").get()?.status==='waiting_approval')break;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  assert.equal(ctx.sqlite.prepare("SELECT status FROM run_steps WHERE step_id='run_task'").get()?.status,'waiting_approval');
  assert.equal(settled,false,'no external action or terminal result before decision');
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM step_attempts").get()!.n,0);
  await ctx.decide('deny');
  await execute;
  const run=ctx.sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(runId)!;
  const step=ctx.sqlite.prepare('SELECT status,error_code FROM run_steps WHERE run_id=?').get(runId)!;
  assert.equal(run.outcome,'failed');
  assert.equal(step.status,'failed');
  assert.equal(step.error_code,'approval_denied');
  assert.equal(ctx.wakeCount,1);
 }finally{ctx.sqlite.close();}
});
test('a lost native wake is never treated as approval; durable D1 decision is authoritative',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  let wakeAttempts=0;
  const step={
   async do(_name:string,_opts:unknown,fn:()=>Promise<unknown>){return fn();},
   async waitForEvent(){
    wakeAttempts++;
    if(wakeAttempts===1){
     // Simulate an externally recorded approval followed by a dropped wake ACK.
     await ctx.decide('approve');
     throw Error('transport_wake_lost');
    }
    throw Error('unexpected_wait');
   },
  } as unknown as WorkflowStep;
  const r=await waitForRuntimeApproval(ctx.env.DB,step,runId,'run_task',versionId,async()=>false);
  assert.deepEqual(r,{ok:true});
  assert.equal(wakeAttempts,1);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_approvals').get()!.n,1);
  assert.equal(typeof ctx.sqlite.prepare('SELECT consumed_at FROM runtime_approvals').get()!.consumed_at,'number');
 }finally{ctx.sqlite.close();}
});
test('native approval timeout never authorizes GitHub action without a decision',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  let polls=0;
  const step={
   async do(_name:string,_opts:unknown,fn:()=>Promise<unknown>){return fn();},
   async waitForEvent(){polls++;throw Error('native_timeout');},
  } as unknown as WorkflowStep;
  const decision=await waitForRuntimeApproval(ctx.env.DB,step,runId,'run_task',versionId,async()=>false);
  assert.deepEqual(decision,{ok:false,error_code:'approval_timeout'});
  assert.equal(polls,20);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_approvals').get()!.n,0);
  assert.equal(ctx.sqlite.prepare('SELECT status FROM run_steps').get()!.status,'waiting_approval');
 }finally{ctx.sqlite.close();}
});
test('approved native gate still cannot elevate missing published GitHub grants',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  const execute=new WorkflowOrchestrator({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:runId}} as WorkflowEvent<{run_id:string}>,ctx.step);
  for(let n=0;n<100;n++){
   if(ctx.sqlite.prepare("SELECT status FROM run_steps WHERE step_id='run_task'").get()?.status==='waiting_approval')break;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  assert.equal(ctx.sqlite.prepare("SELECT status FROM run_steps WHERE step_id='run_task'").get()?.status,'waiting_approval');
  await ctx.decide('approve');
  await execute;
  assert.equal(ctx.sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(runId)?.outcome,'failed');
  const result=ctx.sqlite.prepare('SELECT status,error_code FROM run_steps WHERE run_id=?').get(runId)!;
  assert.equal(result.status,'failed');
  assert.equal(result.error_code,'github_action_approval_missing');
  assert.equal(typeof ctx.sqlite.prepare('SELECT consumed_at FROM runtime_approvals').get()?.consumed_at,'number');
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM step_attempts").get()?.n,0);
 }finally{ctx.sqlite.close();}
});

test('cancelling a pending approval atomically prevents late approval and native GitHub dispatch',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  const execute=new WorkflowOrchestrator({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:runId}} as WorkflowEvent<{run_id:string}>,ctx.step);
  for(let n=0;n<100;n++){
   if(ctx.sqlite.prepare("SELECT status FROM run_steps WHERE step_id='run_task'").get()?.status==='waiting_approval')break;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  assert.equal(ctx.sqlite.prepare('SELECT status FROM run_steps').get()?.status,'waiting_approval');
  const cancelled=await ctx.service.cancel(runId,'run_task');
  assert.equal(cancelled.cancellation,'requested');
  assert.equal(cancelled.physical_terminated,false);
  await assert.rejects(()=>ctx.decide('approve'),/approval_run_not_active/);
  // Simulate an already in-flight approval handler that passed its initial
  // Run read before cancellation: the authoritative SQL INSERT still rejects it.
  await assert.rejects(()=>recordRuntimeApproval(ctx.env.DB,runId,'run_task',
    versionId,'approved',Date.now()),/approval_not_open/);
  await execute;
  assert.equal(ctx.sqlite.prepare('SELECT outcome FROM runs').get()?.outcome,'cancelled');
  assert.equal(ctx.sqlite.prepare('SELECT status FROM run_steps').get()?.status,'cancelled');
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM runtime_approvals').get()?.n,0);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) n FROM step_attempts').get()?.n,0);
 }finally{ctx.sqlite.close();}
});
test('cancel cannot revoke a recorded approval or terminate a parallel active Step',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  const pending=ctx.waiting();
  for(let n=0;n<100;n++){
   if(ctx.sqlite.prepare('SELECT status FROM run_steps').get()?.status==='waiting_approval')break;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  await ctx.decide('approve');
  await assert.rejects(()=>ctx.service.cancel(runId,'run_task'),/approval_cancel_conflict/);
  assert.equal(ctx.sqlite.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
  assert.deepEqual(await pending,{ok:true});
 }finally{ctx.sqlite.close();}
});

test('pending approval cancellation refuses to terminate another active Step',async()=>{
 const ctx=fixture();try{
  await ctx.setup();
  const pending=ctx.waiting();
  for(let n=0;n<100;n++){
   if(ctx.sqlite.prepare('SELECT status FROM run_steps').get()?.status==='waiting_approval')break;
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  ctx.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,?,?)")
   .run(runId,'other_step','running',Date.now());
  await assert.rejects(()=>ctx.service.cancel(runId,'run_task'),/approval_cancel_conflict/);
  assert.equal(ctx.sqlite.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
  assert.equal(ctx.sqlite.prepare("SELECT status FROM run_steps WHERE step_id='other_step'").get()?.status,'running');
  await ctx.decide('deny');
  assert.deepEqual(await pending,{ok:false,error_code:'approval_denied'});
 }finally{ctx.sqlite.close();}
});
