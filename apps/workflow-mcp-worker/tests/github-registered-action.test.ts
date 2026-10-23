import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../src/store.ts';
import { REGISTERED_GITHUB_ACTION, registeredWorkflowRef } from '../src/github-registry.ts';

const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {
    url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit:true,
  };
  return next(specifier,context);
}});
const [{default:ownerWorker},{WorkflowRunner}]=await Promise.all([
  import('../src/index.ts'),import('../src/runner.ts'),
]);
hook.deregister();

const OWNER='https://owner.example.org/mcp';
const TOKEN='disposable-portal-token-registered-action';
const GITHUB_TOKEN='fixture-token-must-not-leak';
const RUN_ID=424242;
const MIGRATIONS=['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql'];

function database(t:test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const name of MIGRATIONS)sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  function prepare(sql:string){
    let args:any[]=[];
    return {
      bind(...values:any[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}},
    };
  }
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    WORKFLOW_EXECUTOR_GITHUB_TOKEN:GITHUB_TOKEN,
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(item=>item.run()));}},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  return {sqlite,env};
}

async function connect(t:test.TestContext){
  const {sqlite,env}=database(t);
  const client=new Client({name:'registered-github-action',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(OWNER),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>
      ownerWorker.fetch(new Request(input,init),env)) as typeof fetch,
  });
  await client.connect(transport);
  t.after(()=>client.close());
  async function call(name:string,args:Record<string,unknown>,error?:string){
    const output=await client.callTool({name,arguments:args});
    const first=output.content[0];
    if(!first||first.type!=='text')throw Error('unexpected_tool_content');
    assert.equal(first.text.includes(TOKEN),false);
    assert.equal(first.text.includes(GITHUB_TOKEN),false);
    const value=JSON.parse(first.text);
    if(error){
      assert.equal(output.isError,true);
      assert.equal(value.error,error);
    }else assert.notEqual(output.isError,true,name+' '+first.text);
    return value;
  }
  return {sqlite,env,call};
}

function runner(env:Env,runId:string,step:WorkflowStep){
  return new WorkflowRunner({} as ExecutionContext,env).run(
    {payload:{run_id:runId}} as WorkflowEvent<{run_id:string}>,step);
}

test('Agent discovers, publishes, and reads an allow-listed GitHub Action result',async t=>{
  const {sqlite,env,call}=await connect(t);
  const overview=await call('workflow_capabilities',{});
  const listed=overview.capabilities.find((item:{id:string})=>item.id==='action.github.registered');
  assert.equal(listed.status,'supported');
  assert.equal(listed.repository,REGISTERED_GITHUB_ACTION.repository);
  assert.equal(listed.workflow,REGISTERED_GITHUB_ACTION.workflow);
  assert.equal(listed.ref,REGISTERED_GITHUB_ACTION.ref);
  assert.equal(listed.grant,REGISTERED_GITHUB_ACTION.grant);
  assert.equal(listed.input_schema.required[0],'subject');
  assert.equal(overview.capabilities.find((item:{id:string})=>item.id==='action.shell').status,'unsupported');
  const detail=await call('workflow_capabilities',{id:'action.github.registered'});
  const example=detail.example;
  assert.equal(example.steps[0].with.capability,REGISTERED_GITHUB_ACTION.id);
  assert.equal('repository' in example.steps[0].with,false);
  const check=await call('workflow_capabilities',{id:'action.github.run'});
  const checkPreview=await call('workflow_validate',{definition:JSON.stringify(check.example)});
  assert.equal(checkPreview.valid,true);
  assert.deepEqual(check.example.steps[0].with,{capability:'github.workflow.check'});
  const workflows=()=>Number(sqlite.prepare('SELECT COUNT(*) AS n FROM workflows').get()?.n??0);
  assert.equal(workflows(),0);
  const illegal=[
    {repository:'evil/repo'},
    {workflow:'other.yml'},
    {ref:'refs/heads/other'},
    {command:'pwd'},
    {token:'secret-token-value'},
    {capability:'shell.exec'},
    {inputs:{subject:''}},
    {inputs:{subject:'x'.repeat(81)}},
    {inputs:{subject:'ok',repository:'evil/repo'}},
    {inputs:undefined},
  ];
  for(const patch of illegal){
    const definition=structuredClone(example);
    definition.steps[0].with={...definition.steps[0].with,...patch};
    if(patch.inputs===undefined)delete definition.steps[0].with.inputs;
    const rejected=await call('workflow_validate',{definition:JSON.stringify(definition)});
    assert.equal(rejected.valid,false,JSON.stringify(patch));
    assert.match(rejected.issues[0].code,/unsupported_field|unsupported_github_capability|invalid_github_inputs/);
  }
  assert.equal(workflows(),0);
  const preview=await call('workflow_validate',{definition:JSON.stringify(example)});
  assert.equal(preview.valid,true);
  assert.equal(preview.requires_heavy_execution_approval,true);
  const created=await call('workflow_create',{definition:JSON.stringify(example)});
  const draft=sqlite.prepare('SELECT draft FROM workflows WHERE id=?').get(created.workflow_id) as {draft:string};
  assert.equal(draft.draft.includes('registry'),false);
  assert.equal(draft.draft.includes(REGISTERED_GITHUB_ACTION.repository),false);
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1},'github_execution_approval_required');
  const published=await call('workflow_publish',{
    workflow_id:created.workflow_id,expected_revision:1,approve_heavy_execution:true,
  });
  const plan=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(published.published_version_id) as {plan:string}).plan);
  assert.equal(plan.github_execution_approved,true);
  assert.deepEqual(plan.steps[0].with.registry,{
    repository:REGISTERED_GITHUB_ACTION.repository,
    repository_id:REGISTERED_GITHUB_ACTION.repositoryId,
    workflow:REGISTERED_GITHUB_ACTION.workflow,
    ref:REGISTERED_GITHUB_ACTION.ref,
  });
  assert.equal(JSON.stringify(plan).includes(GITHUB_TOKEN),false);
  const started=await call('workflow_run',{workflow_id:created.workflow_id,inputs:{subject:'fixture-subject'}});
  let posts=0;
  let runReads=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    assert.equal(request.url.includes(GITHUB_TOKEN),false);
    assert.equal(request.headers.get('authorization'),'Bearer '+GITHUB_TOKEN);
    if(request.method==='POST'){
      posts++;
      assert.equal(request.url,'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/registered-action.yml/dispatches');
      assert.deepEqual(await request.json(),{ref:'main',return_run_details:true,inputs:{subject:'fixture-subject'}});
      return Response.json({workflow_run_id:RUN_ID},{status:200});
    }
    if(request.url==='https://api.github.com/repos/lirtual/mcp-workers/actions/runs/'+RUN_ID){
      runReads++;
      return Response.json({
        id:RUN_ID,status:runReads===1?'in_progress':'completed',
        conclusion:runReads===1?null:'success',event:'workflow_dispatch',
        path:'.github/workflows/registered-action.yml',head_branch:'main',run_attempt:1,
        html_url:'https://evil.example/leak?token='+GITHUB_TOKEN,
        repository:{full_name:'lirtual/mcp-workers'},
      });
    }
    assert.equal(request.url,'https://api.github.com/repos/lirtual/mcp-workers/actions/runs/'+RUN_ID+'/artifacts?per_page=8');
    return Response.json({total_count:1,artifacts:[{
      id:77,name:'result-note',size_in_bytes:24,expired:false,expires_at:'2026-11-23T00:00:00Z',
      archive_download_url:'https://api.github.com/repos/lirtual/mcp-workers/actions/artifacts/77/zip?token='+GITHUB_TOKEN,
      url:'https://evil.example/?token='+GITHUB_TOKEN,
    }]});
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  let waited=0;
  await runner(env,started.run_id,{
    do:async(_name:unknown,_options:unknown,callback:()=>Promise<unknown>)=>callback(),
    waitForEvent:async(_name:string,options:{type:string})=>{
      waited++;
      assert.equal(options.type,'github-receipt-act');
      const status=await call('workflow_status',{run_id:started.run_id});
      const step=status.steps.find((item:{step_id:string})=>item.step_id==='act');
      assert.equal(status.status,'running');
      assert.equal(step.async_action.phase,'dispatch_accepted');
      assert.equal(step.async_action.external_execution_id,String(RUN_ID));
      assert.equal(step.async_action.receipt_outcome,null);
      const attempt=sqlite.prepare('SELECT state,candidate_run_id,capability_id,workflow_ref FROM step_attempts').get() as {
        state:string;candidate_run_id:number;capability_id:string;workflow_ref:string;
      };
      assert.equal(attempt.state,'confirmed');
      assert.equal(attempt.candidate_run_id,RUN_ID);
      assert.equal(attempt.capability_id,REGISTERED_GITHUB_ACTION.id);
      assert.equal(attempt.workflow_ref,registeredWorkflowRef());
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM callback_receipts').get()?.n,0);
      assert.equal(posts,1);
    },
  } as unknown as WorkflowStep);
  const result=await call('workflow_result',{run_id:started.run_id});
  assert.equal(result.status,'succeeded');
  assert.equal(result.result.conclusion,'success');
  assert.equal(result.result.run.id,RUN_ID);
  assert.equal(result.result.run.html_url,'https://github.com/lirtual/mcp-workers/actions/runs/'+RUN_ID);
  assert.deepEqual(result.result.artifacts,[{
    id:77,name:'result-note',size_in_bytes:24,expired:false,expires_at:'2026-11-23T00:00:00Z',
    url:'https://api.github.com/repos/lirtual/mcp-workers/actions/artifacts/77',
  }]);
  assert.equal(result.result.implementation.workflow_ref,registeredWorkflowRef());
  const text=JSON.stringify(result);
  assert.equal(text.includes(GITHUB_TOKEN),false);
  assert.equal(text.includes('/zip'),false);
  assert.equal(text.includes('evil.example'),false);
  const heavy=result.steps.find((item:{step_id:string})=>item.step_id==='act');
  assert.equal(heavy.async_action.phase,'external_terminal');
  assert.equal(heavy.async_action.receipt_outcome,'succeeded');
  assert.equal(heavy.async_action.external_execution_id,String(RUN_ID));
  const stored=sqlite.prepare('SELECT state,candidate_run_id FROM step_attempts').get() as {state:string;candidate_run_id:number};
  const receipt=sqlite.prepare('SELECT outcome,result_json FROM callback_receipts').get() as {outcome:string;result_json:string};
  assert.equal(stored.state,'confirmed');
  assert.equal(stored.candidate_run_id,RUN_ID);
  assert.equal(receipt.outcome,'succeeded');
  assert.equal(receipt.result_json.includes(GITHUB_TOKEN),false);
  assert.equal(posts,1);
  assert.equal(waited,1);
  await runner(env,started.run_id,{do:async()=>{throw Error('replay must not dispatch');}} as unknown as WorkflowStep);
  assert.equal(posts,1);
});

test('illegal runtime target or inputs do not dispatch, and ambiguous results are not redispatched',async t=>{
  const {sqlite,env,call}=await connect(t);
  const detail=await call('workflow_capabilities',{id:'action.github.registered'});
  async function publish(){
    const created=await call('workflow_create',{definition:JSON.stringify(detail.example)});
    await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1,approve_heavy_execution:true});
    return created.workflow_id as string;
  }
  const tamperedId=await publish();
  const version=sqlite.prepare('SELECT id,plan FROM workflow_versions WHERE workflow_id=?').get(tamperedId) as {id:string;plan:string};
  const tampered=JSON.parse(version.plan);
  tampered.steps[0].with.registry.workflow='other.yml';
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(tampered),version.id);
  let posts=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async()=>{posts++;throw Error('network must not be contacted');}) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  const tamperedRun=await call('workflow_run',{workflow_id:tamperedId,inputs:{subject:'fixture-subject'}});
  await runner(env,tamperedRun.run_id,{do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>fn()} as unknown as WorkflowStep);
  const tamperedResult=await call('workflow_result',{run_id:tamperedRun.run_id});
  assert.equal(tamperedResult.steps.find((item:{step_id:string})=>item.step_id==='act').error_code,'github_action_not_allow_listed');
  const invalidId=await publish();
  const invalidRun=await call('workflow_run',{workflow_id:invalidId,inputs:{subject:'x'.repeat(81)}});
  await runner(env,invalidRun.run_id,{do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>fn()} as unknown as WorkflowStep);
  const invalidResult=await call('workflow_result',{run_id:invalidRun.run_id});
  assert.equal(invalidResult.steps.find((item:{step_id:string})=>item.step_id==='act').error_code,'github_action_inputs_invalid');
  assert.equal(posts,0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM step_attempts").get()?.n,0);

  const ambiguousId=await publish();
  const ambiguousRun=await call('workflow_run',{workflow_id:ambiguousId,inputs:{subject:'fixture-subject'}});
  let dispatches=0;
  globalThis.fetch=(async()=>{posts++;dispatches++;return new Response(null,{status:503});}) as typeof fetch;
  const step={do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>fn()} as unknown as WorkflowStep;
  await runner(env,ambiguousRun.run_id,step);
  await runner(env,ambiguousRun.run_id,step);
  const ambiguous=await call('workflow_result',{run_id:ambiguousRun.run_id});
  assert.equal(ambiguous.status,'indeterminate');
  assert.equal(ambiguous.error_code,'github_dispatch_unknown');
  assert.equal(sqlite.prepare('SELECT state FROM step_attempts WHERE run_id=?').get(ambiguousRun.run_id)?.state,'dispatch_unknown');
  assert.equal(dispatches,1);
  assert.equal(posts,1);

  const unreadId=await publish();
  const unreadRun=await call('workflow_run',{workflow_id:unreadId,inputs:{subject:'fixture-subject'}});
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(request.method==='POST'){
      posts++;
      dispatches++;
      return Response.json({workflow_run_id:RUN_ID},{status:200});
    }
    posts++;
    throw Error('status read failed');
  }) as typeof fetch;
  const waiting={
    do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>fn(),
    waitForEvent:async()=>{throw Error('no wake');},
  } as unknown as WorkflowStep;
  await runner(env,unreadRun.run_id,waiting);
  const postsAfterRead=posts;
  await runner(env,unreadRun.run_id,waiting);
  const unread=await call('workflow_result',{run_id:unreadRun.run_id});
  assert.equal(unread.status,'indeterminate');
  assert.equal(unread.error_code,'github_callback_unconfirmed');
  const attempt=sqlite.prepare('SELECT state,candidate_run_id FROM step_attempts WHERE run_id=?').get(unreadRun.run_id) as {state:string;candidate_run_id:number};
  assert.equal(attempt.state,'confirmed');
  assert.equal(attempt.candidate_run_id,RUN_ID);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM callback_receipts').get()?.n,0);
  assert.equal(posts,postsAfterRead);
  assert.equal(dispatches,2);

  const failedId=await publish();
  const failedRun=await call('workflow_run',{workflow_id:failedId,inputs:{subject:'fixture-subject'}});
  const dispatchesBeforeFailure=dispatches;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    posts++;
    if(request.method==='POST'){dispatches++;return Response.json({workflow_run_id:5252},{status:200});}
    assert.equal(request.url.includes('/artifacts'),false);
    return Response.json({
      id:5252,status:'completed',conclusion:'failure',event:'workflow_dispatch',
      path:'.github/workflows/registered-action.yml',head_branch:'main',run_attempt:1,
    });
  }) as typeof fetch;
  await runner(env,failedRun.run_id,waiting);
  const failed=await call('workflow_result',{run_id:failedRun.run_id});
  assert.equal(failed.status,'failed');
  assert.equal(failed.steps.find((item:{step_id:string})=>item.step_id==='act').async_action.receipt_outcome,'failed');
  assert.equal(failed.steps.find((item:{step_id:string})=>item.step_id==='act').async_action.external_execution_id,'5252');
  assert.equal(sqlite.prepare('SELECT state FROM step_attempts WHERE run_id=?').get(failedRun.run_id)?.state,'confirmed');
  assert.equal(sqlite.prepare('SELECT outcome FROM callback_receipts').all().at(-1)?.outcome,'failed');
  assert.equal(dispatches-dispatchesBeforeFailure,1);
  await runner(env,failedRun.run_id,waiting);
  assert.equal(dispatches-dispatchesBeforeFailure,1);
});
