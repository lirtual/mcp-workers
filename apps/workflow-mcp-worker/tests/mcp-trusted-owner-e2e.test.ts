import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toolSchemaDigest } from '../src/plan.ts';
import { TRUSTED_PORTAL_ENDPOINT, PRODUCTION_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
import type { Env } from '../src/store.ts';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import readonlyWorker from './fixtures/readonly-worker.ts';

// Exercise the real Portal handler, owner MCP SDK protocol, D1 queries,
// published approval contract, Workflow runner, and the actual read-only MCP
// fixture, all in-process. The only stub is Cloudflare's orchestration shell;
// outbound trusted-target fetch is explicitly intercepted, not real Internet.
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

const TRUSTED=TRUSTED_PORTAL_ENDPOINT;
const PORTAL_ID='test-only-service-token-id';
const PORTAL_SECRET='test-only-service-token-secret';
const OWNER='https://owner.example.org/mcp';
const TOKEN='disposable-portal-token-mcp-owner-e2e';
const INPUT_SCHEMA={type:'object',properties:{
  value:{type:'string',maxLength:4096},
  delay_ms:{type:'integer',minimum:0,maximum:15000},
},required:['value'],'$schema':'https://json-schema.org/draft/2020-12/schema',additionalProperties:false};
const DIGEST=await toolSchemaDigest(INPUT_SCHEMA);

test('Portal-authenticated MCP -> validate -> approve -> Publish -> Run -> Result',async t=>{
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  function prepare(sql:string){
    let args:any[]=[];
    return {
      bind(...values:any[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},
    };
  }
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    MCP_PORTAL_CLIENT_ID:PORTAL_ID,
    MCP_PORTAL_CLIENT_SECRET:PORTAL_SECRET,
    MCP_PORTAL_ENDPOINT:TRUSTED,
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(s=>s.run()));}},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  let internetCalls=0,toolCalls=0;
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    internetCalls++;
    assert.equal(request.url,TRUSTED);
    assert.equal(request.redirect,'manual');
    assert.equal(request.headers.get('authorization'),null,'incoming Portal token must not leak');
    assert.equal(request.headers.get('cf-access-client-id'),PORTAL_ID);
    assert.equal(request.headers.get('cf-access-client-secret'),PORTAL_SECRET);
    if(request.method==='POST'){
      const rpc=await request.clone().json() as {method:string};
      if(rpc.method==='tools/call')toolCalls++;
    }
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previousFetch;});

  const unauthorized=await ownerWorker.fetch(new Request(OWNER,{
    method:'POST',headers:{authorization:'Bearer wrong-test-token'},
  }),env);
  assert.equal(unauthorized.status,401);
  const disallowedOrigin=await ownerWorker.fetch(new Request(OWNER,{
    method:'POST',headers:{authorization:'Bearer '+TOKEN,origin:'https://untrusted.example.org'},
  }),env);
  assert.equal(disallowedOrigin.status,403);
  assert.equal(internetCalls,0);

  const client=new Client({name:'trusted-mcp-owner-test',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(OWNER),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>
      ownerWorker.fetch(new Request(input,init),env)) as typeof fetch,
  });
  try{
    await client.connect(transport);
    const listed=await client.listTools();
    assert.ok(listed.tools.some(x=>x.name==='workflow_publish'));
    async function call(name:string,args:Record<string,unknown>,error?:string):Promise<any>{
      const output=await client.callTool({name,arguments:args});
      const first=output.content[0];
      if(!first || first.type!=='text')throw Error('unexpected_tool_content');
      const value=JSON.parse(first.text);
      if(error){
        assert.equal(output.isError,true,name+' must reject');
        assert.equal(value.error,error);
      }else assert.notEqual(output.isError,true,name+' '+JSON.stringify(value));
      return value;
    }
    const definition={version:1,name:'Trusted owner-scoped test',steps:[{
      id:'lookup',uses:'mcp.call',with:{
        endpoint:TRUSTED,tool:'echo',scope:'read',input_schema:INPUT_SCHEMA,
        arguments:{value:{ref:'inputs.message'}},
      },
    }]};
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const preview=await call('workflow_validate',{workflow_id:created.workflow_id,revision:1});
    const grant={endpoint:TRUSTED,tool:'echo',scope:'read',schema_digest:DIGEST};
    assert.equal(preview.valid,true);
    assert.deepEqual(preview.required_approvals,[grant]);

    const base={workflow_id:created.workflow_id,expected_revision:1};
    await call('workflow_publish',{...base,approved_operations:[grant]},'target_risk_acknowledgment_required');
    await call('workflow_publish',{...base,approved_operations:[{...grant,tool:'unreviewed'}],accept_target_risks:true},'external_approval_required');
    await call('workflow_publish',{...base,accept_target_risks:true},'external_approval_required');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
    assert.equal(internetCalls,0);

    const published=await call('workflow_publish',{...base,approved_operations:[grant],accept_target_risks:true});
    const plan=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(published.published_version_id) as {plan:string}).plan);
    assert.equal(plan.mcp_target_risks_accepted,true);
    assert.deepEqual(plan.mcp_approvals,[grant]);

    const run=await call('workflow_run',{
      workflow_id:created.workflow_id,inputs:{message:'approved trusted echo'},
      idempotency_key:'trusted-owner-e2e-'+created.workflow_id,
    });
    await new WorkflowRunner({} as ExecutionContext,env).run({
      payload:{run_id:run.run_id},
    } as WorkflowEvent<{run_id:string}>, {
      do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);

    const outcome=await call('workflow_result',{run_id:run.run_id});
    assert.equal(outcome.status,'succeeded');
    assert.equal(outcome.steps[0].status,'succeeded');
    assert.equal(outcome.result.content[0].text,'approved trusted echo');
    assert.equal(toolCalls,1,'exactly one tools/call');

    // An environment configured for the production Portal must not silently
    // execute a Plan approved for the test Portal (nor leak credentials).
    env.MCP_PORTAL_ENDPOINT=PRODUCTION_PORTAL_ENDPOINT;
    const crossEnvironment=await call('workflow_run',{
      workflow_id:created.workflow_id,inputs:{message:'blocked wrong Portal'},
    });
    await new WorkflowRunner({} as ExecutionContext,env).run({
      payload:{run_id:crossEnvironment.run_id},
    } as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);
    const wrongPortal=await call('workflow_result',{run_id:crossEnvironment.run_id});
    assert.equal(wrongPortal.status,'failed');
    assert.equal(wrongPortal.steps[0].status,'failed');
    assert.equal(toolCalls,1,'cross-environment Portal was not contacted');
    env.MCP_PORTAL_ENDPOINT=TRUSTED;

    // A missing outbound Portal secret must fail without sending any requests.
    env.MCP_PORTAL_CLIENT_SECRET=undefined;
    const noCredential=await call('workflow_run',{
      workflow_id:created.workflow_id,inputs:{message:'no portal identity'},
    });
    await new WorkflowRunner({} as ExecutionContext,env).run({
      payload:{run_id:noCredential.run_id},
    } as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);
    const rejected=await call('workflow_result',{run_id:noCredential.run_id});
    assert.equal(rejected.status,'failed');
    assert.equal(rejected.steps[0].status,'failed');
    assert.equal(toolCalls,1,'missing portal credentials cannot reach target');
    env.MCP_PORTAL_CLIENT_SECRET=PORTAL_SECRET;

  }finally{
    await client.close();
  }
});

test('Agent discovers capabilities and inline-validates a definition without touching D1', async t => {
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  let prepares=0;
  function prepare(sql:string){
    prepares++;
    let args:any[]=[];
    return {
      bind(...values:unknown[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}},
    };
  }
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    MCP_PORTAL_CLIENT_ID:PORTAL_ID,
    MCP_PORTAL_CLIENT_SECRET:PORTAL_SECRET,
    MCP_PORTAL_ENDPOINT:TRUSTED,
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(s=>s.run()));}},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  const counts=()=>({
    workflows:Number(sqlite.prepare('SELECT COUNT(*) AS n FROM workflows').get()?.n),
    versions:Number(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n),
    runs:Number(sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n),
  });
  const client=new Client({name:'capability-discovery-test',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(OWNER),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>
      ownerWorker.fetch(new Request(input,init),env)) as typeof fetch,
  });
  const githubToken='github-token-must-not-leak';
  try{
    await client.connect(transport);
    const listed=await client.listTools();
    const descriptions=new Map(listed.tools.map(tool=>[tool.name, tool.description??'']));
    assert.ok(descriptions.has('workflow_capabilities'));
    assert.match(descriptions.get('workflow_validate')??'', /definition/);
    assert.match(descriptions.get('workflow_validate')??'', /not publish|does not/i);
    const instructions=client.getInstructions()??'';
    assert.match(instructions, /workflow_capabilities/);
    assert.match(instructions, /workflow_validate/);
    assert.match(instructions, /workflow_create/);
    assert.match(instructions, /does not publish/i);
    assert.match(instructions, /repeat/);
    assert.match(instructions, /saga are unsupported|saga is unsupported/);
    async function call(name:string,args:Record<string,unknown>):Promise<any>{
      const output=await client.callTool({name,arguments:args});
      const first=output.content[0];
      if(!first || first.type!=='text')throw Error('unexpected_tool_content');
      assert.equal(first.text.includes(TOKEN), false);
      assert.equal(first.text.includes(PORTAL_SECRET), false);
      assert.equal(first.text.includes(PORTAL_ID), false);
      assert.equal(first.text.includes(githubToken), false);
      const value=JSON.parse(first.text);
      assert.notEqual(output.isError, true, name+' '+first.text);
      return value;
    }
    const before=counts();
    const quiet=prepares;
    const overview=await call('workflow_capabilities',{});
    assert.equal(prepares, quiet);
    assert.deepEqual(counts(), before);
    assert.equal(overview.query, 'overview');
    assert.equal(overview.connections.mcp_portal.status, 'configured');
    assert.equal(overview.connections.mcp_portal.endpoint, TRUSTED);
    assert.equal(overview.connections.mcp_portal.scope, 'read');
    assert.equal(overview.connections.github_executor.status, 'unavailable');
    assert.equal(JSON.stringify(overview).includes('public.example.org'), false);
    const byId=new Map<string,{status:string}>(overview.capabilities.map((item:{id:string;status:string}):[string,{status:string}]=>[item.id, item]));
    assert.equal(byId.get('action.result.emit')?.status, 'supported');
    assert.equal(byId.get('action.mcp.call')?.status, 'supported');
    assert.equal(byId.get('action.github.run')?.status, 'supported');
    assert.equal(byId.get('trigger.manual')?.status, 'supported');
    assert.equal(byId.get('trigger.webhook')?.status, 'supported');
    assert.equal(byId.get('trigger.github_event')?.status, 'supported');
    for(const id of ['flow.if','flow.needs','flow.parallel','flow.repeat','flow.dynamic_expansion'])
      assert.equal(byId.get(id)?.status, 'supported', id);
    assert.equal(byId.get('trigger.cron')?.status, 'supported');
    for(const id of ['action.http','action.mcp.write','action.shell','flow.foreach','flow.while','flow.nesting','flow.wait','flow.child_workflow','flow.saga'])
      assert.equal(byId.get(id)?.status, 'unsupported', id);
    for(const item of overview.capabilities) assert.equal('example' in item, false);

    const hookCap=await call('workflow_capabilities',{id:'trigger.webhook'});
    const githubEventCap=await call('workflow_capabilities',{id:'trigger.github_event'});
    assert.equal((await call('workflow_validate',{definition:JSON.stringify(hookCap.example)})).valid, true);
    assert.equal((await call('workflow_validate',{definition:JSON.stringify(githubEventCap.example)})).valid, true);
    assert.match(JSON.stringify(hookCap), /does not promise global exactly-once/);
    assert.match(JSON.stringify(githubEventCap), /claim\/callback routes do not start a business Run/);
    assert.equal(JSON.stringify(hookCap).includes('WEBHOOK_TRIGGER_SECRET'), false);
    const emit=await call('workflow_capabilities',{id:'action.result.emit'});
    const cron=await call('workflow_capabilities',{id:'trigger.cron'});
    const missing=await call('workflow_capabilities',{id:'action.not-real'});
    assert.equal(emit.status, 'supported');
    assert.equal(cron.status, 'supported');
    assert.equal(cron.cron.timezone, 'UTC');
    assert.equal(cron.cron.dst, 'not_applicable');
    assert.equal(cron.cron.minimum_interval_seconds, 60);
    assert.equal(cron.cron.permission, 'authenticated_publish_only');
    assert.equal(cron.cron.exactly_once, false);
    assert.equal((await call('workflow_validate',{definition:JSON.stringify(cron.example)})).valid, true);
    assert.equal(missing.status, 'unknown');
    const inline=await call('workflow_validate',{definition:JSON.stringify(emit.example)});
    assert.equal(inline.valid, true);
    assert.match(inline.digest, /^[0-9a-f]{64}$/);
    assert.equal(inline.issues.length, 0);
    assert.equal('required_approvals' in inline, false);
    assert.equal(prepares, quiet);
    assert.deepEqual(counts(), before);

    const github=await call('workflow_capabilities',{id:'action.github.run'});
    assert.match(github.completion, /Dispatch accepted/);
    assert.match(github.completion, /pending/);
    assert.match(github.completion, /external terminal/);
    assert.match(github.completion, /indeterminate/);
    assert.match(github.completion, /explicit 240 second/);
    assert.match(github.completion, /not dispatched again/);
    assert.equal(github.completion.includes('shell'), false);
    assert.equal(github.completion.includes('token'), false);
    const heavy=await call('workflow_validate',{definition:JSON.stringify(github.example)});
    assert.equal(heavy.valid, true);
    assert.equal(heavy.requires_heavy_execution_approval, true);
    const read=await call('workflow_capabilities',{id:'action.mcp.call'});
    const approved=await call('workflow_validate',{definition:JSON.stringify(read.example)});
    assert.equal(approved.valid, true);
    assert.equal(approved.required_approvals.length, 1);
    assert.equal(approved.required_approvals[0].scope, 'read');
    assert.equal(prepares, quiet);

    const bad=await call('workflow_validate',{definition:JSON.stringify({
      version:1,name:'Bad',javascript:'unsafe',steps:[{id:'a',uses:'result.emit',with:{data:1}}],
    })});
    assert.equal(bad.valid, false);
    assert.equal(bad.issues[0].code, 'unsupported_field');
    assert.equal(bad.issues[0].path, '/javascript');
    assert.match(bad.issues[0].message, /javascript/);
    assert.match(bad.issues[0].suggestion, /Remove/);
    assert.doesNotMatch(bad.issues[0].suggestion, /write|shell|secret|token|skip|https?:/i);
    const scope=await call('workflow_validate',{definition:JSON.stringify({
      version:1,name:'Write',steps:[{id:'a',uses:'mcp.call',with:{
        endpoint:TRUSTED,tool:'echo',scope:'write',input_schema:{type:'object'},arguments:{},
      }}],
    })});
    assert.equal(scope.issues[0].code, 'unsupported_operation_scope');
    assert.equal(scope.issues[0].path, '/steps/0/with/scope');
    assert.match(scope.issues[0].suggestion, /read/);
    assert.doesNotMatch(scope.issues[0].suggestion, /write/);
    const ref=await call('workflow_validate',{definition:JSON.stringify({
      version:1,name:'Ref',steps:[{id:'a',uses:'result.emit',with:{data:{ref:'nope'}}}],
    })});
    assert.equal(ref.issues[0].code, 'invalid_reference');
    assert.equal(ref.issues[0].path, '/steps/0/with/data/ref');
    const scheduled=await call('workflow_validate',{definition:JSON.stringify({
      version:1,name:'Cron',cron:'* * * * *',steps:[{id:'a',uses:'result.emit',with:{data:1}}],
    })});
    assert.equal(scheduled.issues[0].code, 'unsupported_field');
    assert.equal(scheduled.issues[0].path, '/cron');
    const repeat=await call('workflow_capabilities',{id:'flow.repeat'});
    assert.equal(repeat.status,'supported');
    assert.equal(repeat.limits.max_expanded_steps<=overview.definition.limits.max_steps, true);
    const repeatPreview=await call('workflow_validate',{definition:JSON.stringify(repeat.example)});
    assert.equal(repeatPreview.valid, true);
    assert.equal(repeatPreview.steps, 2);
    const unbounded=await call('workflow_validate',{definition:JSON.stringify({
      version:1,name:'Unbounded',steps:[{id:'a',uses:'result.emit',repeat:{times:{ref:'inputs.n'}},with:{data:1}}],
    })});
    assert.equal(unbounded.valid, false);
    assert.equal(unbounded.issues[0].code, 'dynamic_expansion');
    assert.equal(unbounded.issues[0].path, '/steps/0/repeat/times');
    assert.equal(prepares, quiet);
    assert.deepEqual(counts(), before);

    const both=await call('workflow_validate',{
      workflow_id:'00000000-0000-4000-8000-000000000001', revision:1,
      definition:JSON.stringify(emit.example),
    });
    assert.equal(both.valid, false);
    assert.equal(both.issues[0].code, 'invalid_validate_target');
    const neither=await call('workflow_validate',{});
    assert.equal(neither.valid, false);
    assert.equal(neither.issues[0].code, 'invalid_validate_target');
    const partial=await call('workflow_validate',{workflow_id:'00000000-0000-4000-8000-000000000001'});
    assert.equal(partial.valid, false);
    assert.equal(partial.issues[0].path, '/revision');
    assert.equal(prepares, quiet);

    env.MCP_PORTAL_ENDPOINT='https://public.example.org/mcp';
    const hidden=await call('workflow_capabilities',{});
    assert.equal(hidden.connections.mcp_portal.status, 'unavailable');
    assert.equal(JSON.stringify(hidden).includes('public.example.org'), false);
    env.MCP_PORTAL_ENDPOINT=TRUSTED;
    Object.assign(env,{
      WORKFLOW_EXECUTOR_GITHUB_TOKEN:githubToken,
      GITHUB_EXECUTOR_REPOSITORY:'lirtual/mcp-workers',
      GITHUB_EXECUTOR_REPOSITORY_ID:'1',
      GITHUB_EXECUTOR_REF:'refs/heads/main',
      GITHUB_EXECUTOR_AUDIENCE:'workflow-audience',
    });
    const configured=await call('workflow_capabilities',{});
    assert.equal(configured.connections.github_executor.status, 'configured');
    assert.equal(configured.connections.github_executor.repository, 'lirtual/mcp-workers');
    assert.equal(configured.connections.github_executor.ref, 'refs/heads/main');
    assert.equal(configured.connections.github_executor.workflow, 'workflow-github-executor.yml');
    assert.equal(configured.connections.github_executor.audience, 'workflow-audience');
    assert.equal('WORKFLOW_EXECUTOR_GITHUB_TOKEN' in configured.connections.github_executor, false);

    const created=await call('workflow_create',{definition:JSON.stringify(read.example)});
    const stored=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    assert.equal(stored.valid, true);
    assert.deepEqual(stored.required_approvals, approved.required_approvals);
    assert.equal(stored.digest, approved.digest);
    assert.deepEqual(counts(), {workflows:1, versions:0, runs:0});

    const loopDraft=await call('workflow_create',{definition:JSON.stringify(repeat.example)});
    const loopPublished=await call('workflow_publish',{workflow_id:loopDraft.workflow_id,expected_revision:1});
    const loopRun=await call('workflow_run',{workflow_id:loopDraft.workflow_id,inputs:{}});
    await new WorkflowRunner({} as ExecutionContext,env).run({payload:{run_id:loopRun.run_id}} as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_options:unknown,callback:()=>Promise<unknown>)=>callback(),
    } as unknown as WorkflowStep);
    const loopStatus=await call('workflow_status',{run_id:loopRun.run_id});
    assert.deepEqual(loopStatus.steps.map((step:{step_id:string;status:string})=>[step.step_id,step.status]),[
      ['grow','succeeded'],['seed','succeeded'],
    ]);
    const loopResult=await call('workflow_result',{run_id:loopRun.run_id});
    assert.equal(loopResult.status,'succeeded');
    assert.deepEqual(loopResult.result,{index:1,seed:'seed',prev:{index:0,seed:'seed'}});
    const storedPlan=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(loopPublished.published_version_id) as {plan:string}).plan);
    assert.equal(storedPlan.steps.some((step:{uses:string})=>step.uses==='flow.repeat'), true);
    assert.equal(storedPlan.saga, undefined);

    const expansion=await call('workflow_capabilities',{id:'flow.dynamic_expansion'});
    assert.equal(expansion.status,'supported');
    assert.equal(expansion.limits.cap, overview.definition.limits.max_expanded_steps);
    const expansionPreview=await call('workflow_validate',{definition:JSON.stringify(expansion.example)});
    assert.equal(expansionPreview.valid, true);
    assert.equal(expansionPreview.expansion.cap, expansion.limits.cap);
    assert.equal(expansionPreview.expansion.templates[0].step_id, 'fan');
    assert.deepEqual(expansionPreview.expansion.templates[0].needs, ['source']);
    assert.equal(expansionPreview.expansion.templates[0].uses, 'result.emit');
    assert.match(expansionPreview.expansion.templates[0].risk, /cannot select an action/);
    const expansionDraft=await call('workflow_create',{definition:JSON.stringify(expansion.example)});
    await call('workflow_publish',{workflow_id:expansionDraft.workflow_id,expected_revision:1});
    const expansionRun=await call('workflow_run',{workflow_id:expansionDraft.workflow_id,inputs:{}});
    await new WorkflowRunner({} as ExecutionContext,env).run({payload:{run_id:expansionRun.run_id}} as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_options:unknown,callback:()=>Promise<unknown>)=>callback(),
    } as unknown as WorkflowStep);
    const expansionResult=await call('workflow_result',{run_id:expansionRun.run_id});
    assert.equal(expansionResult.status,'succeeded');
    assert.deepEqual(expansionResult.result,[{index:0,item:'one'},{index:1,item:'two'}]);
    assert.deepEqual(expansionResult.steps.map((step:{step_id:string;status:string})=>[step.step_id,step.status]),[
      ['fan','succeeded'],['fan:0','succeeded'],['fan:1','succeeded'],['source','succeeded'],
    ]);
  }finally{
    await client.close();
  }
});
