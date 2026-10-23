import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../src/store.ts';
import {reconcileRunCancellation} from '../src/run-cancel.ts';
import {REGISTERED_GITHUB_ACTION,registeredWorkflowRef} from '../src/github-registry.ts';

const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {
    url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit:true,
  };
  return next(specifier,context);
}});
const [{default:ownerWorker},{WorkflowRunner}]=await Promise.all([
  import('../src/index.ts'), import('../src/runner.ts'),
]);
hook.deregister();

const TOKEN='disposable-portal-token-run-cancel';
const GITHUB_TOKEN='fixture-token';
const ORIGIN='https://owner.example.org/mcp';
const REPO='lirtual/test-executor';
const RUN=424242;
const GITHUB_DEFINITION=JSON.stringify({version:1,name:'Cancel GitHub',steps:[
  {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
]});
const LOCAL_DEFINITION=JSON.stringify({version:1,name:'Cancel local',steps:[
  {id:'emit',uses:'result.emit',with:{data:{kept:true}}},
]});

type GithubFixture={
  run:'in_progress'|'completed';
  conclusion:string|null;
  cancel:'accept'|'throw'|'redirect';
};

function setup(t:test.TestContext, github:GithubFixture){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql','0007_run_cancel.sql','0008_grant_revocation.sql','0009_runtime_approval.sql','0010_child_run.sql','0011_cron_due.sql','0012_cron_due_bounds.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  function prepare(sql:string){
    let args:unknown[]=[];
    return {
      bind(...values:unknown[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args as never[])??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args as never[])};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as never[]).changes)}}},
    };
  }
  let native='running';
  let terminates=0;
  const calls:string[]=[];
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    WORKFLOW_EXECUTOR_GITHUB_TOKEN:GITHUB_TOKEN,
    GITHUB_EXECUTOR_REPOSITORY:REPO,
    GITHUB_EXECUTOR_REPOSITORY_ID:'987654321',
    GITHUB_EXECUTOR_REF:'refs/heads/main',
    GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test',
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(item=>item.run()));}},
    WORKFLOW:{
      async create(){},
      async get(){return {
        async status(){return {status:native};},
        async terminate(){terminates++; native='terminated';},
      };},
    },
  } as unknown as Env;
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    calls.push(request.method+' '+request.url);
    assert.equal(request.headers.get('authorization'),'Bearer '+GITHUB_TOKEN);
    assert.equal(request.redirect,'manual');
    assert.equal(request.url.includes('force-cancel'),false);
    if(request.url==='https://api.github.com/repos/'+REPO+'/actions/workflows/workflow-github-executor.yml/dispatches')
      return Response.json({workflow_run_id:RUN},{status:200});
    if(request.url==='https://api.github.com/repos/'+REPO+'/actions/runs/'+RUN+'/cancel'){
      if(github.cancel==='throw') throw Error('cancel_transport_failed');
      if(github.cancel==='redirect') return new Response(null,{status:302,headers:{location:'https://api.github.com/elsewhere'}});
      return new Response(null,{status:202});
    }
    if(request.url==='https://api.github.com/repos/'+REPO+'/actions/runs/'+RUN+'/jobs?per_page=100'){
      const done=github.run==='completed';
      return Response.json({total_count:1,jobs:[{id:7,status:done?'completed':'in_progress',conclusion:done?github.conclusion:null}]});
    }
    if(request.url==='https://api.github.com/repos/'+REPO+'/actions/runs/'+RUN)
      return Response.json({id:RUN,status:github.run,conclusion:github.conclusion});
    throw Error('unexpected_github_call:'+request.method+' '+request.url);
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  return {sqlite,env,calls,github,terminates:()=>terminates,setNative(status:string){native=status;}};
}

async function connect(t:test.TestContext, env:Env){
  const client=new Client({name:'run-cancel-test',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(ORIGIN),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>ownerWorker.fetch(new Request(input,init),env)) as typeof fetch,
  });
  await client.connect(transport);
  t.after(()=>client.close());
  async function call(name:string,args:Record<string,unknown>,error?:string):Promise<any>{
    const output=await client.callTool({name,arguments:args});
    const first=output.content[0];
    if(!first||first.type!=='text')throw Error('unexpected_tool_content');
    assert.equal(first.text.includes(GITHUB_TOKEN),false);
    assert.equal(first.text.includes(TOKEN),false);
    const value=JSON.parse(first.text);
    if(error){
      assert.equal(output.isError,true);
      assert.equal(value.error,error);
    }else assert.notEqual(output.isError,true,first.text);
    return value;
  }
  return {client,call};
}

function cancelCount(calls:string[]){
  return calls.filter(line=>line.includes('/cancel')).length;
}

function insertCancellationRun(ctx:ReturnType<typeof setup>,plan:unknown,outcome='running'){
  const runId=crypto.randomUUID(),workflowId='cancel-fixture-'+runId,versionId='version-'+runId,stamp=Date.now()-1_000;
  ctx.sqlite.prepare("INSERT INTO workflows(id,name,draft,state,created_at,updated_at) VALUES(?, 'Cancel fixture','{}','active',?,?)")
    .run(workflowId,stamp,stamp);
  ctx.sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
    .run(versionId,workflowId,'digest-'+runId,JSON.stringify(plan),stamp);
  ctx.sqlite.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,cancel_requested_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'started',?,?,?,?)`).run(runId,workflowId,versionId,runId,'digest-'+runId,'{}',outcome,stamp,stamp,stamp);
  return {runId,workflowId,versionId,stamp};
}

function insertAttempt(ctx:ReturnType<typeof setup>,run:{runId:string;versionId:string;stamp:number},options:{stepId:string;capabilityId?:string;state:string;repository?:string;workflowRef?:string;ref?:string;candidateRunId?:number|null}){
  const id=crypto.randomUUID(),registered=options.capabilityId===REGISTERED_GITHUB_ACTION.id;
  ctx.sqlite.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,run.runId,options.stepId,options.capabilityId??'github.workflow.check',crypto.randomUUID(),options.state,
      options.repository??(registered?REGISTERED_GITHUB_ACTION.repository:REPO),registered?REGISTERED_GITHUB_ACTION.repositoryId:'987654321',
      options.workflowRef??(registered?registeredWorkflowRef():REPO+'/.github/workflows/workflow-github-executor.yml@refs/heads/main'),
      options.ref??(registered?REGISTERED_GITHUB_ACTION.ref:'refs/heads/main'),options.candidateRunId??null,options.candidateRunId==null?null:1,run.stamp,run.stamp);
  return id;
}

async function waitingGithub(t:test.TestContext, github:GithubFixture){
  const ctx=setup(t,github);
  const {client,call}=await connect(t,ctx.env);
  const listed=await client.listTools();
  const tool=listed.tools.find(item=>item.name==='workflow_cancel');
  assert.ok(tool);
  assert.match(tool.description??'',/requested/);
  assert.match(tool.description??'',/force-cancel/);
  assert.match(client.getInstructions()??'',/workflow_cancel/);
  const created=await call('workflow_create',{definition:GITHUB_DEFINITION});
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1,approve_heavy_execution:true});
  const admitted=await call('workflow_run',{workflow_id:created.workflow_id});
  let release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let waits=0;
  const execution=new WorkflowRunner({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {async do(_name:unknown,_options:unknown,fn:()=>Promise<unknown>){return fn();},
      async waitForEvent(){waits++;await gate;throw Error('resume');},
    } as unknown as WorkflowStep,
  );
  const finished=execution.then(()=>undefined,()=>undefined);
  t.after(async()=>{release();await finished;});
  for(let i=0;i<50;i++){
    const row=ctx.sqlite.prepare('SELECT state,candidate_run_id FROM step_attempts').get() as {state:string;candidate_run_id:number}|undefined;
    if(row?.state==='confirmed'&&row.candidate_run_id===RUN)break;
    if(i===49)throw Error('attempt_not_confirmed');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  return {...ctx,call,admitted,release,finished,waits:()=>waits,workflowId:created.workflow_id};
}

test('workflow_cancel keeps a GitHub 202 as requested and does not replay or force-cancel',async t=>{
  const ctx=await waitingGithub(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const first=await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id});
  assert.equal(first.cancellation,'requested');
  assert.equal(first.status,'running');
  assert.equal(first.steps[0].async_action.phase,'dispatch_accepted');
  assert.equal(first.steps[0].async_action.external_execution_id,String(RUN));
  assert.equal(cancelCount(ctx.calls),1);
  assert.equal(ctx.calls.some(line=>line.includes('force-cancel')),false);
  ctx.github.run='in_progress';
  const second=await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id});
  assert.equal(second.cancellation,'requested');
  assert.equal(second.status,'running');
  assert.equal(cancelCount(ctx.calls),1);
  const polled=await ctx.call('workflow_status',{run_id:ctx.admitted.run_id});
  assert.equal(polled.cancellation,'requested');
  assert.equal(cancelCount(ctx.calls),1);
  ctx.release();
  await ctx.finished;
  await new WorkflowRunner({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:ctx.admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {async do(){throw Error('resume_must_not_dispatch');}} as unknown as WorkflowStep,
  );
  assert.equal(ctx.calls.filter(line=>line.includes('/dispatches')).length,1);
  assert.equal(ctx.waits(),1);
  const stored=ctx.sqlite.prepare('SELECT outcome,cancel_requested_at FROM runs WHERE id=?').get(ctx.admitted.run_id) as {outcome:string;cancel_requested_at:number};
  assert.equal(stored.outcome,'running');
  assert.equal(typeof stored.cancel_requested_at,'number');
});

test('observed GitHub run and job cancellation becomes cancelled only after the terminal read',async t=>{
  const ctx=await waitingGithub(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const requested=await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id});
  assert.equal(requested.cancellation,'requested');
  assert.notEqual(requested.status,'cancelled');
  ctx.github.run='completed';
  ctx.github.conclusion='cancelled';
  const stopped=await ctx.call('workflow_status',{run_id:ctx.admitted.run_id});
  assert.equal(stopped.cancellation,'cancelled');
  assert.equal(stopped.status,'cancelled');
  ctx.release();
  await ctx.finished;
  const attempt=ctx.sqlite.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
  ctx.sqlite.prepare(`INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,created_at)
    VALUES('f8835141-0b3a-4fcb-a9ae-b4b75bfae93c',?,'succeeded','{"echo":"late"}',?)`)
    .run(attempt.attempt_id,Date.now());
  const late=await ctx.call('workflow_result',{run_id:ctx.admitted.run_id});
  assert.equal(late.cancellation,'cancelled');
  assert.equal(late.status,'cancelled');
  assert.equal(cancelCount(ctx.calls),1);
  assert.equal(ctx.calls.filter(line=>line.includes('/dispatches')).length,1);
  await new WorkflowRunner({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:ctx.admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {async do(){throw Error('resume_must_not_dispatch');}} as unknown as WorkflowStep,
  );
  assert.equal(ctx.calls.filter(line=>line.includes('/dispatches')).length,1);
});

test('a receipt that wins the race is completed and is not cancelled or redispatched',async t=>{
  const ctx=await waitingGithub(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  assert.equal((await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id})).cancellation,'requested');
  const attempt=ctx.sqlite.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
  ctx.sqlite.prepare(`INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,created_at)
    VALUES('f8835141-0b3a-4fcb-a9ae-b4b75bfae93c',?,'succeeded','{"echo":"done"}',?)`)
    .run(attempt.attempt_id,Date.now());
  ctx.github.run='completed';
  ctx.github.conclusion='success';
  const done=await ctx.call('workflow_result',{run_id:ctx.admitted.run_id});
  assert.equal(done.cancellation,'completed');
  assert.equal(done.status,'succeeded');
  assert.deepEqual(done.result,{echo:'done'});
  assert.equal(done.steps[0].async_action.phase,'external_terminal');
  assert.equal(done.steps[0].async_action.receipt_outcome,'succeeded');
  ctx.release();
  await ctx.finished;
  const again=await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id});
  assert.equal(again.cancellation,'completed');
  assert.equal(again.status,'succeeded');
  assert.equal(cancelCount(ctx.calls),1);
  assert.equal(ctx.calls.filter(line=>line.includes('/dispatches')).length,1);
});

test('GitHub success without a receipt is completed business-indeterminate, not cancelled',async t=>{
  const ctx=await waitingGithub(t,{run:'completed',conclusion:'success',cancel:'accept'});
  await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id});
  const view=await ctx.call('workflow_result',{run_id:ctx.admitted.run_id});
  assert.equal(view.cancellation,'completed');
  assert.equal(view.status,'indeterminate');
  assert.equal(view.error_code,'github_callback_unconfirmed');
  assert.notEqual(view.status,'cancelled');
  ctx.release();
  await ctx.finished;
  assert.equal(cancelCount(ctx.calls),1);
  assert.equal((await ctx.call('workflow_status',{run_id:ctx.admitted.run_id})).cancellation,'completed');
  assert.equal(cancelCount(ctx.calls),1);
});

test('an ambiguous GitHub cancel response is indeterminate and is not retried',async t=>{
  const ctx=await waitingGithub(t,{run:'in_progress',conclusion:null,cancel:'throw'});
  const first=await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id});
  assert.equal(first.cancellation,'indeterminate');
  assert.equal(first.status,'running');
  assert.notEqual(first.status,'cancelled');
  const second=await ctx.call('workflow_status',{run_id:ctx.admitted.run_id});
  assert.equal(second.cancellation,'indeterminate');
  assert.equal(cancelCount(ctx.calls),1);
  assert.equal(ctx.calls.some(line=>line.includes('force-cancel')),false);
  ctx.release();
  await ctx.finished;
  assert.equal(ctx.calls.filter(line=>line.includes('/dispatches')).length,1);
});

test('a redirect is not acknowledgement and does not authorize another cancel',async t=>{
  const ctx=await waitingGithub(t,{run:'in_progress',conclusion:null,cancel:'redirect'});
  assert.equal((await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id})).cancellation,'indeterminate');
  assert.equal((await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id})).cancellation,'indeterminate');
  assert.equal(cancelCount(ctx.calls),1);
  ctx.release();
  await ctx.finished;
});

test('a succeeded receipt contradicted by a cancelled GitHub run stays indeterminate',async t=>{
  const ctx=await waitingGithub(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  await ctx.call('workflow_cancel',{run_id:ctx.admitted.run_id});
  const attempt=ctx.sqlite.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
  ctx.sqlite.prepare(`INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,created_at)
    VALUES('f8835141-0b3a-4fcb-a9ae-b4b75bfae93c',?,'succeeded','{"echo":"race"}',?)`)
    .run(attempt.attempt_id,Date.now());
  ctx.github.run='completed';
  ctx.github.conclusion='cancelled';
  const view=await ctx.call('workflow_result',{run_id:ctx.admitted.run_id});
  assert.equal(view.cancellation,'indeterminate');
  assert.equal(view.status,'indeterminate');
  assert.notEqual(view.status,'cancelled');
  assert.notEqual(view.status,'succeeded');
  ctx.release();
  await ctx.finished;
  const after=await ctx.call('workflow_status',{run_id:ctx.admitted.run_id});
  assert.equal(after.status,'indeterminate');
  assert.equal(after.cancellation,'indeterminate');
  assert.equal(cancelCount(ctx.calls),1);
  assert.equal(ctx.calls.filter(line=>line.includes('/dispatches')).length,1);
});

test('a successful GitHub Receipt cannot succeed a mixed DAG while a later protected step is pending',async t=>{
  const ctx=setup(t,{run:'completed',conclusion:'success',cancel:'accept'});
  const plan={steps:[{id:'heavy',uses:'github.run'},{id:'write',uses:'mcp.call',approval:{required:true}}]};
  const run=insertCancellationRun(ctx,plan);
  ctx.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?, 'heavy','succeeded',?)").run(run.runId,run.stamp);
  ctx.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?, 'write','waiting_approval',?)").run(run.runId,run.stamp);
  const attemptId=insertAttempt(ctx,run,{stepId:'heavy',state:'confirmed',candidateRunId:RUN});
  ctx.sqlite.prepare("INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,created_at) VALUES(?,?,'succeeded','{\"ok\":true}',?)")
    .run(crypto.randomUUID(),attemptId,run.stamp);
  ctx.sqlite.prepare("UPDATE runs SET cancel_requested_at=? WHERE id=?").run(run.stamp,run.runId);
  assert.equal(await reconcileRunCancellation(ctx.env.DB,ctx.env,run.runId), 'completed');
  const stored=ctx.sqlite.prepare('SELECT outcome,error_code FROM runs WHERE id=?').get(run.runId) as {outcome:string;error_code:string|null};
  assert.notEqual(stored.outcome,'succeeded');
  assert.equal(stored.outcome,'indeterminate');
  assert.equal(stored.error_code,'cancel_business_incomplete');
});

test('an in-flight MCP protected write makes cancellation indeterminate',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const run=insertCancellationRun(ctx,{steps:[{id:'write',uses:'mcp.call'}]});
  ctx.sqlite.prepare("INSERT INTO protected_effects(run_id,step_id,grant_key,state,created_at,updated_at) VALUES(?, 'write','grant','dispatching',?,?)")
    .run(run.runId,run.stamp,run.stamp);
  ctx.sqlite.prepare("UPDATE runs SET cancel_requested_at=? WHERE id=?").run(run.stamp,run.runId);
  assert.equal(await reconcileRunCancellation(ctx.env.DB,ctx.env,run.runId),'indeterminate');
  const stored=ctx.sqlite.prepare('SELECT outcome,error_code FROM runs WHERE id=?').get(run.runId) as {outcome:string;error_code:string|null};
  assert.equal(stored.outcome,'indeterminate');
  assert.equal(stored.error_code,'cancel_external_effect_unknown');
});

test('a created GitHub Attempt becomes durably indeterminate after its Workflow stops and never replays',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const run=insertCancellationRun(ctx,{steps:[{id:'heavy',uses:'github.run'}]});
  insertAttempt(ctx,run,{stepId:'heavy',state:'created'});
  ctx.sqlite.prepare("UPDATE runs SET cancel_requested_at=? WHERE id=?").run(run.stamp,run.runId);
  assert.equal(await reconcileRunCancellation(ctx.env.DB,ctx.env,run.runId),'indeterminate');
  const stored=ctx.sqlite.prepare('SELECT outcome,error_code FROM runs WHERE id=?').get(run.runId) as {outcome:string;error_code:string|null};
  assert.equal(stored.outcome,'indeterminate');
  assert.equal(stored.error_code,'github_dispatch_unknown');
  assert.equal(await reconcileRunCancellation(ctx.env.DB,ctx.env,run.runId),'indeterminate');
  assert.equal(cancelCount(ctx.calls),0);
});

test('registered GitHub Action cancellation uses its pinned registry identity without the legacy repository setting',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  delete (ctx.env as unknown as Record<string,unknown>).GITHUB_EXECUTOR_REPOSITORY;
  const run=insertCancellationRun(ctx,{steps:[{id:'action',uses:'github.run'}]});
  insertAttempt(ctx,run,{stepId:'action',capabilityId:REGISTERED_GITHUB_ACTION.id,state:'confirmed',candidateRunId:RUN});
  ctx.sqlite.prepare("UPDATE runs SET cancel_requested_at=? WHERE id=?").run(run.stamp,run.runId);
  const requests:string[]=[];
  const outbound=async(request:Request)=>{
    requests.push(request.method+' '+request.url);
    if(request.url===`https://api.github.com/repos/${REGISTERED_GITHUB_ACTION.repository}/actions/runs/${RUN}/cancel`)
      return new Response(null,{status:202});
    if(request.url===`https://api.github.com/repos/${REGISTERED_GITHUB_ACTION.repository}/actions/runs/${RUN}`)
      return Response.json({id:RUN,status:'in_progress',conclusion:null});
    throw Error('unexpected:'+request.url);
  };
  assert.equal(await reconcileRunCancellation(ctx.env.DB,ctx.env,run.runId,outbound),'requested');
  assert.equal(requests.some(url=>url.includes('/cancel')),true);
  assert.equal(requests.some(url=>url.includes('/actions/runs/'+RUN)),true);
});

test('pause and resume do not cancel an in-flight GitHub run',async t=>{
  const ctx=await waitingGithub(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const before=ctx.calls.length;
  const paused=await ctx.call('workflow_pause',{workflow_id:ctx.workflowId});
  assert.equal(paused.state,'paused');
  await ctx.call('workflow_run',{workflow_id:ctx.workflowId},'workflow_not_active');
  const running=await ctx.call('workflow_status',{run_id:ctx.admitted.run_id});
  assert.equal(running.status,'running');
  assert.equal('cancellation' in running,false);
  assert.equal(ctx.calls.length,before);
  assert.equal(ctx.terminates(),0);
  const resumed=await ctx.call('workflow_resume',{workflow_id:ctx.workflowId});
  assert.equal(resumed.state,'active');
  const still=await ctx.call('workflow_status',{run_id:ctx.admitted.run_id});
  assert.equal(still.status,'running');
  assert.equal('cancellation' in still,false);
  assert.equal(cancelCount(ctx.calls),0);
  assert.equal(ctx.terminates(),0);
  ctx.release();
  await ctx.finished;
});

test('cancelling before dispatch does not dispatch when the run is resumed',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const {call}=await connect(t,ctx.env);
  const created=await call('workflow_create',{definition:GITHUB_DEFINITION});
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1,approve_heavy_execution:true});
  const admitted=await call('workflow_run',{workflow_id:created.workflow_id});
  const cancelled=await call('workflow_cancel',{run_id:admitted.run_id});
  assert.equal(cancelled.cancellation,'cancelled');
  assert.equal(cancelled.status,'cancelled');
  assert.equal(ctx.calls.length,0);
  await new WorkflowRunner({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {async do(){throw Error('must_not_dispatch');}} as unknown as WorkflowStep,
  );
  assert.equal(ctx.calls.length,0);
  assert.equal(ctx.terminates(),1);
});

test('a lost GitHub dispatch stays indeterminate and cancel does not invent a run id',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const {call}=await connect(t,ctx.env);
  const previous=globalThis.fetch;
  let dispatches=0;
  globalThis.fetch=(async()=>{
    dispatches++;
    return new Response(null,{status:503});
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  const created=await call('workflow_create',{definition:GITHUB_DEFINITION});
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1,approve_heavy_execution:true});
  const admitted=await call('workflow_run',{workflow_id:created.workflow_id});
  await new WorkflowRunner({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {async do(_n:unknown,_o:unknown,fn:()=>Promise<unknown>){return fn();}} as unknown as WorkflowStep,
  );
  assert.equal(dispatches,1);
  const cancelled=await call('workflow_cancel',{run_id:admitted.run_id});
  assert.equal(cancelled.cancellation,'indeterminate');
  assert.equal(cancelled.status,'indeterminate');
  await new WorkflowRunner({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {async do(){throw Error('must_not_dispatch');}} as unknown as WorkflowStep,
  );
  assert.equal(dispatches,1);
  const effect=ctx.sqlite.prepare('SELECT cancel_effect,candidate_run_id FROM step_attempts').get() as {cancel_effect:string|null;candidate_run_id:number|null};
  assert.equal(effect.cancel_effect,null);
  assert.equal(effect.candidate_run_id,null);
});

test('a local Run is cancelled only after the Workflow instance is observed stopped',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  ctx.setNative('running');
  ctx.env.WORKFLOW.get=async()=>({
    async status(){return {status:'running'};},
    async terminate(){/* accepted, still running */},
  });
  const {call}=await connect(t,ctx.env);
  const created=await call('workflow_create',{definition:LOCAL_DEFINITION});
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const admitted=await call('workflow_run',{workflow_id:created.workflow_id});
  const requested=await call('workflow_cancel',{run_id:admitted.run_id});
  assert.equal(requested.cancellation,'requested');
  assert.equal(requested.status,'queued');
  ctx.env.WORKFLOW.get=async()=>({
    async status(){return {status:'terminated'};},
    async terminate(){throw Error('already_terminated');},
  });
  const stopped=await call('workflow_status',{run_id:admitted.run_id});
  assert.equal(stopped.cancellation,'cancelled');
  assert.equal(stopped.status,'cancelled');
  assert.equal(ctx.calls.length,0);
});

test('cancelling a finished local Run is completed and does not terminate it again',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const {call}=await connect(t,ctx.env);
  const created=await call('workflow_create',{definition:LOCAL_DEFINITION});
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const admitted=await call('workflow_run',{workflow_id:created.workflow_id});
  await new WorkflowRunner({} as ExecutionContext,ctx.env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {async do(_n:unknown,_o:unknown,fn:()=>Promise<unknown>){return fn();}} as unknown as WorkflowStep,
  );
  const done=await call('workflow_cancel',{run_id:admitted.run_id});
  assert.equal(done.cancellation,'completed');
  assert.equal(done.status,'succeeded');
  const settled=await call('workflow_result',{run_id:admitted.run_id});
  assert.equal(settled.cancellation,'completed');
  assert.deepEqual(settled.result,{kept:true});
  assert.equal(ctx.terminates(),0);
  assert.equal(ctx.calls.length,0);
});

test('workflow_cancel rejects an unknown Run without calling GitHub',async t=>{
  const ctx=setup(t,{run:'in_progress',conclusion:null,cancel:'accept'});
  const {call}=await connect(t,ctx.env);
  await call('workflow_cancel',{run_id:'6f1d7c2a-1b4e-4f0a-9c3d-2a6b8e0f5d11'},'run_not_found');
  assert.equal(ctx.calls.length,0);
  assert.equal(ctx.terminates(),0);
});
