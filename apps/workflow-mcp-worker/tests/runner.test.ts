import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { LIMITS } from '../src/capabilities.ts';
import { WorkflowService, type Env } from '../src/store.ts';
import { toolSchemaDigest, type ReadonlyOperation } from '../src/plan.ts';
// Exact schema returned by the existing read-only echo MCP fixture.
const PINNED_SCHEMA={type:'object',properties:{
  value:{type:'string',maxLength:4096},
  delay_ms:{type:'integer',minimum:0,maximum:15000},
},required:['value'],'$schema':'https://json-schema.org/draft/2020-12/schema',additionalProperties:false};
const PINNED_DIGEST=await toolSchemaDigest(PINNED_SCHEMA);
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { success } from '../src/tools.ts';
import readonlyWorker from './fixtures/readonly-worker.ts';

// Only the Cloudflare orchestration shell and remote MCP peer are substituted.
const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',shortCircuit:true};
  return next(specifier,context);
}});
const { WorkflowRunner }=await import('../src/runner.ts');
hook.deregister();

function deferred(){
  let resolve!:()=>void;
  const promise=new Promise<void>(r=>{resolve=r;});
  return {promise,resolve};
}

const ECHO_GRANT:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
const echoStep=(id:string,args:Record<string,unknown>)=>({
  id,uses:'mcp.call',with:{endpoint:ECHO_GRANT.endpoint,tool:'echo',scope:'read',input_schema:PINNED_SCHEMA,arguments:args},
});
function mockPublicPeer(t:test.TestContext,onCall?:()=>Promise<void>) {
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(onCall && request.method==='POST' && (await request.clone().json() as {method:string}).method==='tools/call')
      await onCall();
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
}

function setup(t:test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const file of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
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
    MCP_PORTAL_ENDPOINT:'https://test-mcp.lirtual.dpdns.org/mcp',
    MCP_PORTAL_CLIENT_ID:'test-id',
    MCP_PORTAL_CLIENT_SECRET:'test-secret',
    DB:{prepare,async batch(statements:{run:()=>Promise<unknown>}[]){return Promise.all(statements.map(s=>s.run()));}},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  const service=new WorkflowService(env);
  async function admit(steps:unknown[],inputs:Record<string,unknown>={},approvals:ReadonlyOperation[]=[]){
    const w=await service.create(JSON.stringify({version:1,name:'Review regression',steps}));
    await service.publish(w.workflow_id,1,approvals,approvals.length>0);
    return service.start(w.workflow_id,inputs);
  }
  async function run(run_id:string){
    await new WorkflowRunner({} as ExecutionContext,env).run({payload:{run_id}} as WorkflowEvent<{run_id:string}>,
      {do:async(_name:unknown,_options:unknown,callback:()=>Promise<unknown>)=>callback()} as unknown as WorkflowStep);
  }
  return {service,admit,run,env,sqlite};
}

test('explicit null emit remains the Run result when an independent later Step has output',async t=>{
  const {service,admit,run}=setup(t);
  mockPublicPeer(t);
  const admitted=await admit([
    {id:'a',uses:'result.emit',with:{data:null}},
    echoStep('z',{value:'other output'}),
  ],{},[ECHO_GRANT]);
  await run(admitted.run_id);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.result,null);
});

test('successful maximum payload is retrievable with all 32 Step states and Run metadata',async t=>{
  const {service,admit,run}=setup(t);
  // Exactly 48 KiB of UTF-8 JSON, leaving 16 KiB for bounded metadata.
  const value='汉'.repeat(16383)+'x';
  const admitted=await admit(Array.from({length:32},(_,i)=>({
    id:('step'+i).padEnd(64,'x'),uses:'result.emit',needs:i?[('step'+(i-1)).padEnd(64,'x')]:[],with:{data:{ref:'inputs.x'}},
  })),{x:value});
  await run(admitted.run_id);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.result,value);
  assert.equal(result.steps.length,32);
  assert.notEqual(success(result).isError,true);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength<=65536);
});

test('a payload above the reserved result budget cannot produce an unreadable successful Run',async t=>{
  const {service,admit,run}=setup(t);
  // Original review counterexample: input 65,528 bytes, result 65,522 bytes.
  const admitted=await admit([{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.x'}}}],{x:'x'.repeat(65520)});
  await run(admitted.run_id);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(result.result,null);
});

test('status exposes running delayed MCP call, waiting dependency and retained terminal Steps from the pinned Plan',async t=>{
  const {service,admit,run}=setup(t);
  const entered=deferred(),release=deferred();
  mockPublicPeer(t,async()=>{entered.resolve();await release.promise;});
  const admitted=await admit([
    echoStep('slow',{value:'delayed'}),
    {id:'dependent',uses:'result.emit',needs:['slow'],with:{data:{ref:'steps.slow.output'}}},
    {id:'skipped',uses:'result.emit',if:false,with:{data:'unused'}},
  ],{},[ECHO_GRANT]);
  const execution=run(admitted.run_id);
  try{
    await entered.promise;
    // Edit and republish the Draft while the original pinned Plan is active.
    await service.update((await service.status(admitted.run_id)).workflow_id,1,
      JSON.stringify({version:1,name:'Different Plan',steps:[{id:'newStep',uses:'result.emit',with:{data:'new'}}]}));
    const owner=(await service.status(admitted.run_id)).workflow_id;
    await service.publish(owner,2);
    const status=await service.status(admitted.run_id);
    assert.deepEqual(status.steps.map(s=>[s.step_id,s.status]),[
      ['dependent','waiting'],['skipped','skipped'],['slow','running'],
    ]);
  }finally{release.resolve();await execution;}
  assert.deepEqual((await service.status(admitted.run_id)).steps.map(s=>[s.step_id,s.status]),[
    ['dependent','succeeded'],['skipped','skipped'],['slow','succeeded'],
  ]);
});

test('native waiting is visible and terminal uncertainty never labels unfinished Steps as waiting or running',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const admitted=await admit([
    {id:'done',uses:'result.emit',with:{data:'safe'}},
    {id:'failed',uses:'result.emit',with:{data:'unused'}},
    {id:'skipped',uses:'result.emit',with:{data:'unused'}},
    {id:'inflight',uses:'result.emit',with:{data:'unused'}},
    {id:'dependent',uses:'result.emit',needs:['inflight'],with:{data:'unused'}},
  ]);
  // Isolated persistence fault: engine stopped before all business projections settled.
  sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(admitted.run_id);
  for(const [id,status] of [['done','succeeded'],['failed','failed'],['skipped','skipped'],['inflight','running']])
    sqlite.prepare('INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,?,1)').run(admitted.run_id,id,status);
  env.WORKFLOW.get=async()=>({status:async()=>({status:'waiting'})});
  assert.equal((await service.status(admitted.run_id)).status,'waiting');
  env.WORKFLOW.get=async()=>({status:async()=>({status:'errored'})});
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'indeterminate');
  assert.equal(result.error_code,'orchestration_errored');
  assert.deepEqual(result.steps.map(s=>[s.step_id,s.status]),[
    ['dependent','indeterminate'],['done','succeeded'],['failed','failed'],['inflight','indeterminate'],['skipped','skipped'],
  ]);
});

test('replaying a callback preserves its existing terminal Step state',async t=>{
  const {service,admit,run,sqlite}=setup(t);
  const entered=deferred(),release=deferred();
  mockPublicPeer(t,async()=>{entered.resolve();await release.promise;});
  const admitted=await admit([echoStep('read',{value:'stable'})],{},[ECHO_GRANT]);
  sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,output,updated_at) VALUES(?,'read','succeeded',?,1)")
    .run(admitted.run_id,JSON.stringify({content:[{type:'text',text:'stable'}]}));
  const execution=run(admitted.run_id);
  try{
    await entered.promise;
    assert.deepEqual((await service.status(admitted.run_id)).steps.map(s=>[s.step_id,s.status]),[['read','succeeded']]);
  }finally{release.resolve();await execution;}
  assert.equal((await service.result(admitted.run_id)).status,'succeeded');
});

test('native complete with an unsettled business outcome does not claim unfinished Steps are waiting',async t=>{
  const {service,admit,env}=setup(t);
  const admitted=await admit([{id:'emit',uses:'result.emit',with:{data:'unconfirmed'}}]);
  env.WORKFLOW.get=async()=>({status:async()=>({status:'complete'})});
  const status=await service.status(admitted.run_id);
  assert.equal(status.status,'queued'); // Preserve the existing business-outcome settle window.
  assert.deepEqual(status.steps.map(s=>[s.step_id,s.status]),[['emit','indeterminate']]);
});

const boundedRepeatSteps = [
  {id:'seed',uses:'result.emit',with:{data:'seed'}},
  {id:'grow',needs:['seed'],uses:'result.emit',
    repeat:{times:3,until:{eq:[{ref:'loop.index'},2]}},
    if:{lt:[{ref:'loop.index'},2]},
    with:{data:{index:{ref:'loop.index'},seed:{ref:'steps.seed.output'},prev:{ref:'steps.grow.output'}}}},
];

test('a budget-bounded loop runs on the Cloudflare runner with conditions and output refs',async t=>{
  const {admit,env,service}=setup(t);
  const admitted=await admit(boundedRepeatSteps);
  let workflowSteps=0;
  await new WorkflowRunner({} as ExecutionContext,env).run({payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,{
    do:async(_name:unknown,_options:unknown,callback:()=>Promise<unknown>)=>{workflowSteps++;return callback();},
  } as unknown as WorkflowStep);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.steps.map(step=>[step.step_id,step.status]),[['grow','succeeded'],['seed','succeeded']]);
  assert.deepEqual(result.result,{index:1,seed:'seed',prev:{index:0,seed:'seed'}});
  assert.equal(workflowSteps,3);
});

test('a bounded loop fails at the runtime deadline and does not keep iterating',async t=>{
  const {admit,env,service}=setup(t);
  const admitted=await admit([{id:'grow',uses:'result.emit',repeat:{times:LIMITS.maxLoopIterations},with:{data:{ref:'loop.index'}}}]);
  let workflowSteps=0;
  const realNow=Date.now;
  let clock=1_000_000;
  Date.now=()=>{clock+=LIMITS.maxLoopDeadlineMs+1;return clock;};
  try{
    await new WorkflowRunner({} as ExecutionContext,env).run({payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_options:unknown,callback:()=>Promise<unknown>)=>{workflowSteps++;return callback();},
    } as unknown as WorkflowStep);
  }finally{Date.now=realNow;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].error_code,'loop_deadline_exceeded');
  assert.equal(result.result,null);
  assert.equal(workflowSteps,0);
});

test('foreach on a pinned plan fails closed instead of emitting the step once',async t=>{
  const {admit,env,run,service,sqlite}=setup(t);
  const admitted=await admit([{id:'emit',uses:'result.emit',with:{data:'once'}}]);
  const original=sqlite.prepare('SELECT version_id FROM runs WHERE id=?').get(admitted.run_id) as {version_id:string};
  const tampered={version:1,name:'Foreach',steps:[{id:'emit',needs:[],uses:'result.emit',foreach:['a','b'],with:{data:'once'}}]};
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(tampered),original.version_id);
  await run(admitted.run_id);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.notEqual(result.result,'once');
});

test('unknown capability in a pinned Plan fails closed instead of becoming result.emit',async t=>{
  const {service,admit,run,sqlite,env}=setup(t);
  const admitted=await admit([{id:'emit',uses:'result.emit',with:{data:'safe'}}]);
  const original=sqlite.prepare('SELECT version_id FROM runs WHERE id=?').get(admitted.run_id) as {version_id:string};
  const tampered={version:1,name:'Untrusted future capability',steps:[{id:'emit',needs:[],uses:'mcp.call',with:{data:'should not succeed'}}]};
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(tampered),original.version_id);
  const previousFetch=globalThis.fetch;
  let unexpectedNetworkCalls=0;
  globalThis.fetch=(async()=>{unexpectedNetworkCalls++;throw Error('unexpected network call');}) as typeof fetch;
  await run(admitted.run_id);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(unexpectedNetworkCalls,0);
  globalThis.fetch=previousFetch;
});

test('MCP Publish requires explicit matching read approval without a stage toggle',async t=>{
  const {service,env,sqlite}=setup(t);
  const steps=[{id:'read',uses:'mcp.call',with:{
    endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
    input_schema:PINNED_SCHEMA,arguments:{value:'hello'},
  }}];
  const plan=JSON.stringify({version:1,name:'MCP approval gate',steps});
  const created=await service.create(plan);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
  await assert.rejects(()=>service.publish(created.workflow_id,1),/external_approval_required/);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[{...grant,tool:'other'}]),/external_approval_required/);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[grant,grant]),/external_approval_required/);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[grant]),/target_risk_acknowledgment_required/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
  const published=await service.publish(created.workflow_id,1,[grant],true);
  const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(published.published_version_id) as {plan:string};
  assert.deepEqual(JSON.parse(saved.plan).mcp_approvals,[grant]);
  assert.equal(JSON.parse(saved.plan).mcp_target_risks_accepted,true);
});

test('MCP approved Run fails closed if pinned Portal is removed',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'test'}}}],{},[grant]);
  env.MCP_PORTAL_ENDPOINT=undefined;
  const oldFetch=globalThis.fetch;
  let requests=0;
  globalThis.fetch=(async()=>{requests++;throw Error('unexpected_public_fetch');}) as typeof fetch;
  try{
    await run(admitted.run_id);
  }finally{globalThis.fetch=oldFetch;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(requests,0);
});

test('MCP approved read-only MCP tool invokes actual SDK only through scoped public fetch',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'hello',url:'https://example.org/opaque'},
  }}],{},[grant]);
  // The existing Workflow echo fixture rejects extra args: this must prove the
  // transport was reached without falsely marking an invalid tool call safe.
  const originalFetch=globalThis.fetch;
  let networkCalls=0,secretSeen=false;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    networkCalls++;
    assert.equal(new URL(request.url).origin,new URL(grant.endpoint).origin);
    assert.equal(request.redirect,'manual');
    if(request.headers.get('authorization')?.includes('PORTAL'))secretSeen=true;
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=originalFetch;}
  const result=await service.result(admitted.run_id);
  // A remote rejection after tools/call still does not prove no side effect.
  assert.equal(result.status,'indeterminate');
  assert.equal(result.steps[0].status,'indeterminate');
  assert.equal(result.error_code,'external_outcome_unknown');
  assert.ok(networkCalls>0);
  assert.equal(secretSeen,false);
});

test('approved MCP public read-only call succeeds through pinned Portal',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'hello MCP'}}}],{},[grant]);
  let publicCalls=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    publicCalls++;
    assert.equal(request.redirect,'manual');
    assert.equal(request.url,grant.endpoint);
    assert.equal(request.headers.get('authorization'),null);
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=originalFetch;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.steps[0].status,'succeeded');
  assert.ok(JSON.stringify(result.result).includes('hello MCP'));
  assert.ok(publicCalls>0);
});

test('tampering immutable MCP approval cannot dispatch to a changed endpoint',async t=>{
  const {env,admit,run,service,sqlite}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'should not run'}}}],{},[grant]);
  const ver=sqlite.prepare('SELECT version_id FROM runs WHERE id=?').get(admitted.run_id) as {version_id:string};
  const row=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(ver.version_id) as {plan:string};
  const changed=JSON.parse(row.plan);
  changed.steps[0].with.endpoint='https://different.example.org/mcp';
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(changed),ver.version_id);
  const oldFetch=globalThis.fetch;let requests=0;
  globalThis.fetch=(async()=>{requests++;throw Error('unexpected');}) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=oldFetch;}
  assert.equal((await service.result(admitted.run_id)).status,'failed');
  assert.equal(requests,0);
});

test('remote tool without readOnlyHint is rejected before tools/call despite owner approval',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'do-not-invoke'}}}],{},[grant]);
  const originalFetch=globalThis.fetch;let toolCallCount=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(request.method==='POST') {
      const message=await request.clone().json() as {method:string};
      if(message.method==='tools/call')toolCallCount++;
    }
    const response=await readonlyWorker.fetch(request);
    if(request.method!=='POST')return response;
    const message=await request.clone().json() as {method:string};
    if(message.method!=='tools/list'||!response.ok)return response;
    const body=await response.json() as {result:{tools:Array<{annotations?:unknown}>}};
    for(const tool of body.result.tools)delete tool.annotations;
    return Response.json(body);
  }) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=originalFetch;}
  assert.equal((await service.result(admitted.run_id)).status,'failed');
  assert.equal(toolCallCount,0);
});

test('MCP workflow_validate exposes exact schema-bound approval for owner review',async t=>{
  const {service,env}=setup(t);
  const created=await service.create(JSON.stringify({version:1,name:'Schema approval',steps:[{
    id:'read',uses:'mcp.call',with:{
      endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
      input_schema:PINNED_SCHEMA,arguments:{value:'hello'},
    },
  }]}));
  const validation=await service.validate(created.workflow_id,1);
  assert.equal(validation.valid,true);
  if(!('required_approvals' in validation))throw Error('expected approval preview');
  assert.deepEqual(validation.required_approvals,[{
    endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
    schema_digest:PINNED_DIGEST,
  }]);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[{
    endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
    schema_digest:'0'.repeat(64),
  }]),/external_approval_required/);
});

test('MCP remote inputSchema drift prevents tools/call, even when target and tool still match',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:grant.scope,
    input_schema:PINNED_SCHEMA,arguments:{value:'no dispatch'},
  }}],{},[grant]);
  const originalFetch=globalThis.fetch;
  let calls=0,toolCalls=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);calls++;
    if(request.method==='POST'){
      const rpc=await request.clone().json() as {method:string};
      if(rpc.method==='tools/call')toolCalls++;
      const response=await readonlyWorker.fetch(request);
      if(rpc.method!=='tools/list'||!response.ok)return response;
      const discovered=await response.json() as {result:{tools:Array<{inputSchema:{properties:{value:{maxLength:number}}}}>}};
      discovered.result.tools[0].inputSchema.properties.value.maxLength=123;
      return Response.json(discovered);
    }
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=originalFetch;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.ok(calls>0);
  assert.equal(toolCalls,0);
});

test('MCP tampered published expected schema fails before network dispatch',async t=>{
  const {env,admit,run,service,sqlite}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:grant.scope,
    input_schema:PINNED_SCHEMA,arguments:{value:'no dispatch'},
  }}],{},[grant]);
  const {version_id}=sqlite.prepare('SELECT version_id FROM runs WHERE id=?').get(admitted.run_id) as {version_id:string};
  const {plan}=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version_id) as {plan:string};
  const tampered=JSON.parse(plan);
  tampered.steps[0].with.input_schema.properties.value.maxLength=1;
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(tampered),version_id);
  const original=globalThis.fetch;let network=0;
  globalThis.fetch=(async()=>{network++;throw Error('unapproved');}) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=original;}
  assert.equal((await service.result(admitted.run_id)).status,'failed');
  assert.equal(network,0);
});

test('MCP remote outputSchema change prevents tools/call before dispatch',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:grant.scope,
    input_schema:PINNED_SCHEMA,arguments:{value:'must not be sent'},
  }}],{},[grant]);
  const originalFetch=globalThis.fetch;
  let toolCalls=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(request.method!=='POST')return readonlyWorker.fetch(request);
    const rpc=await request.clone().json() as {method:string};
    if(rpc.method==='tools/call')toolCalls++;
    const response=await readonlyWorker.fetch(request);
    if(rpc.method!=='tools/list'||!response.ok)return response;
    const discovered=await response.json() as {result:{tools:Array<{outputSchema?:unknown}>}};
    discovered.result.tools[0].outputSchema={type:'object',properties:{value:{type:'string'}}};
    return Response.json(discovered);
  }) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=originalFetch;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(toolCalls,0);
});

test('MCP lost tools/call response is indeterminate, never a confirmed failure or blind retry',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:grant.scope,
    input_schema:PINNED_SCHEMA,arguments:{value:'ack may be lost'},
  }}],{},[grant]);
  const originalFetch=globalThis.fetch;
  let toolCalls=0,received=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(request.method==='POST'){
      const rpc=await request.clone().json() as {method:string};
      if(rpc.method==='tools/call'){
        toolCalls++;
        const response=await readonlyWorker.fetch(request);
        assert.equal(response.ok,true);
        received++;
        throw Error('simulated_ack_loss_after_remote_execution');
      }
    }
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=originalFetch;}
  const result=await service.result(admitted.run_id);
  assert.equal(toolCalls,1);
  assert.equal(received,1);
  assert.equal(result.status,'indeterminate');
  assert.equal(result.steps[0].status,'indeterminate');
  assert.equal(result.steps[0].error_code,'external_outcome_unknown');
  assert.equal(result.error_code,'external_outcome_unknown');
});

test('MCP older Published Plan without trusted-target risk acknowledgment is blocked before network',async t=>{
  const {env,admit,run,service,sqlite}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'lookup',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:'read',
    input_schema:PINNED_SCHEMA,arguments:{value:'must never dispatch'},
  }}],{},[grant]);
  const version=sqlite.prepare('SELECT version_id FROM runs WHERE id=?').get(admitted.run_id) as {version_id:string};
  const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version.version_id) as {plan:string};
  const oldPlan=JSON.parse(saved.plan);
  delete oldPlan.mcp_target_risks_accepted;
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(oldPlan),version.version_id);
  let network=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{network++;throw Error('unexpected_external_network');}) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=originalFetch;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(network,0);
});

test('MCP unresolved Run-input reference is rejected before any trusted-target request',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,
    // delay_ms is optional in the declared MCP schema. Silently dropping this
    // missing reference could turn the owner's intended call into a different
    // legitimate target operation, so block it before initialize/tools/list.
    arguments:{value:'safe',delay_ms:{ref:'inputs.delay_ms'}},
  }}],{},[grant]);
  let networkRequests=0;
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{networkRequests++;throw Error('unexpected_mcp_network');}) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=previousFetch;}
  const outcome=await service.result(admitted.run_id);
  assert.equal(outcome.status,'failed');
  assert.equal(outcome.steps[0].status,'failed');
  assert.equal(networkRequests,0);
});

test('MCP stateful MCP DELETE cannot delay an already successful tools/call result',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,
    arguments:{value:'acknowledged stateful result'},
  }}],{},[grant]);
  const previousFetch=globalThis.fetch;
  let calls=0,deletes=0;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    assert.equal(request.url,grant.endpoint);
    assert.equal(request.redirect,'manual');
    if(request.method==='DELETE'){
      deletes++;
      // Simulates a stateful MCP peer that hangs on its optional DELETE.
      return new Promise<Response>(()=>{});
    }
    if(request.method==='GET')return new Response(null,{status:405});
    const message=await request.clone().json() as {id?:number,method:string};
    if(message.method==='notifications/initialized')return new Response(null,{status:202});
    if(message.method==='initialize')return Response.json({
      jsonrpc:'2.0',id:message.id,
      result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},
        serverInfo:{name:'stateful-test',version:'1'}},
    },{headers:{'mcp-session-id':'stateful-session'}});
    if(message.method==='tools/list')return Response.json({
      jsonrpc:'2.0',id:message.id,
      result:{tools:[{name:'echo',inputSchema:PINNED_SCHEMA,
        annotations:{readOnlyHint:true,destructiveHint:false}}]},
    });
    if(message.method==='tools/call'){
      calls++;
      return Response.json({jsonrpc:'2.0',id:message.id,
        result:{content:[{type:'text',text:'acknowledged stateful result'}]}});
    }
    throw Error('unexpected_sdk_message:'+message.method);
  }) as typeof fetch;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([
      run(admitted.run_id),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('optional_session_cleanup_blocked_result')),400);}),
    ]);
  }finally{
    if(timer)clearTimeout(timer);
    globalThis.fetch=previousFetch;
  }
  const result=await service.result(admitted.run_id);
  assert.equal(calls,1);
  assert.equal(deletes,0,'optional remote DELETE should not delay the acknowledged result');
  assert.equal(result.status,'succeeded');
  assert.equal(result.steps[0].status,'succeeded');
  assert.ok(JSON.stringify(result.result).includes('acknowledged stateful result'));
});


test('GitHub Publish requires an explicit approved heavy operation',async t=>{
  const {service,env,sqlite}=setup(t);
  const definition=JSON.stringify({version:1,name:'GitHub gated',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]});
  const wf=await service.create(definition);
  const validated=await service.validate(wf.workflow_id,1);
  assert.equal(validated.valid,true);
  assert.equal((validated as {requires_heavy_execution_approval?:boolean}).requires_heavy_execution_approval,true);
  await assert.rejects(()=>service.publish(wf.workflow_id,1),/github_execution_approval_required/);
  const published=await service.publish(wf.workflow_id,1,[],false,true);
  const plan=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(published.published_version_id) as {plan:string};
  assert.equal(JSON.parse(plan.plan).github_execution_approved,true);
});


test('GitHub published Plan dispatches one confirmed Job, waits outside step.do and emits durable receipt',async t=>{
  const {service,env,sqlite}=setup(t);
  Object.assign(env,{
    WORKFLOW_EXECUTOR_GITHUB_TOKEN:'fixture-token',
    GITHUB_EXECUTOR_REPOSITORY:'lirtual/test-executor',
    GITHUB_EXECUTOR_REPOSITORY_ID:'987654321',
    GITHUB_EXECUTOR_REF:'refs/heads/main',
    GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test',
  });
  const steps=[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
    {id:'emit',needs:['heavy'],uses:'result.emit',with:{data:{ref:'steps.heavy.output'}}},
  ];
  const created=await service.create(JSON.stringify({version:1,name:'GitHub published',steps}));
  await service.publish(created.workflow_id,1,[],false,true);
  const accepted=await service.start(created.workflow_id,{});
  let posts=0;
  const oldFetch=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init);
    posts++;
    assert.equal(req.url,'https://api.github.com/repos/lirtual/test-executor/actions/workflows/workflow-github-executor.yml/dispatches');
    assert.equal(req.headers.get('authorization'),'Bearer fixture-token');
    const sent=await req.json() as {return_run_details:boolean;inputs:Record<string,string>};
    assert.equal(sent.return_run_details,true);
    assert.equal(sent.inputs.capability_id,'github.workflow.check');
    return Response.json({workflow_run_id:987654321},{status:200});
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  let waited=0;
  const orchestration={
    do:async(_name:string,_options:unknown,callback:()=>Promise<unknown>)=>callback(),
    waitForEvent:async(_name:string,options:{type:string})=>{
      waited++;
      assert.equal(options.type,'github-receipt-heavy');
      const row=sqlite.prepare('SELECT attempt_id,dispatch_id,state,candidate_run_id FROM step_attempts').get() as {
        attempt_id:string;dispatch_id:string;state:string;candidate_run_id:number
      };
      assert.equal(row.state,'confirmed');
      assert.equal(row.candidate_run_id,987654321);
      const receiptId='f8835141-0b3a-4fcb-a9ae-b4b75bfae93c';
      sqlite.prepare("UPDATE step_attempts SET state='claimed',owner_run_id=987654321,owner_run_attempt=1 WHERE attempt_id=?")
        .run(row.attempt_id);
      sqlite.prepare("INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,created_at) VALUES(?,?, 'succeeded', ?, ?)")
        .run(receiptId,row.attempt_id,JSON.stringify({echo:'ok',source:'real-github'}),Date.now());
      return {payload:{attemptId:row.attempt_id,callbackId:receiptId}};
    },
  };
  await new WorkflowRunner({} as ExecutionContext,env).run(
    {payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>,
    orchestration as unknown as WorkflowStep,
  );
  const result=await service.result(accepted.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.result,{echo:'ok',source:'real-github'});
  assert.deepEqual(result.steps.map(s=>s.status),['succeeded','succeeded']);
  const stored=sqlite.prepare('SELECT attempt_id,candidate_run_id FROM step_attempts').get() as {attempt_id:string;candidate_run_id:number};
  const heavy=result.steps.find(s=>s.step_id==='heavy') as AsyncStep;
  const emitted=result.steps.find(s=>s.step_id==='emit') as AsyncStep;
  assert.equal(heavy.async_action?.phase,'external_terminal');
  assert.equal(heavy.async_action?.receipt_outcome,'succeeded');
  assert.equal(heavy.async_action?.timed_out,false);
  assert.equal(heavy.async_action?.attempt_id,stored.attempt_id);
  assert.equal(heavy.async_action?.external_execution_id,String(stored.candidate_run_id));
  assert.equal('async_action' in emitted,false);
  assert.equal(posts,1);
  assert.equal(waited,1);
});

test('a published GitHub Run without executor credentials cannot dispatch',async t=>{
  const {service,env}=setup(t);
  const wf=await service.create(JSON.stringify({version:1,name:'Disabled run',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(wf.workflow_id,1,[],false,true);
  const accepted=await service.start(wf.workflow_id,{});
  const original=globalThis.fetch;let attempts=0;
  globalThis.fetch=(async()=>{attempts++;throw Error('no outbound allowed');}) as typeof fetch;
  try{
    await new WorkflowRunner({} as ExecutionContext,env).run(
      {payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>,
      {do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn()} as unknown as WorkflowStep,
    );
  }finally{globalThis.fetch=original;}
  const result=await service.result(accepted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(attempts,0);
});


test('GitHub dispatch HTTP ambiguity is terminally uncertain and never re-dispatched',async t=>{
  const {service,env,sqlite}=setup(t);
  Object.assign(env,{
    WORKFLOW_EXECUTOR_GITHUB_TOKEN:'test-token',
    GITHUB_EXECUTOR_REPOSITORY:'lirtual/test-executor',
    GITHUB_EXECUTOR_REPOSITORY_ID:'987654321',
    GITHUB_EXECUTOR_REF:'refs/heads/main',
    GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test',
  });
  const wf=await service.create(JSON.stringify({version:1,name:'GitHub uncertainty',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(wf.workflow_id,1,[],false,true);
  const accepted=await service.start(wf.workflow_id,{});
  let outbound=0;
  const oldFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{outbound++;return new Response(null,{status:503});}) as typeof fetch;
  const runner=new WorkflowRunner({} as ExecutionContext,env);
  const event={payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>;
  const handler={do:async(_n:unknown,_opts:unknown,fn:()=>Promise<unknown>)=>fn()};
  try{
    await runner.run(event,handler as unknown as WorkflowStep);
    await runner.run(event,handler as unknown as WorkflowStep);
  }finally{globalThis.fetch=oldFetch;}
  const result=await service.result(accepted.run_id);
  assert.equal(result.status,'indeterminate');
  assert.equal(result.error_code,'github_dispatch_unknown');
  assert.equal(sqlite.prepare('SELECT state FROM step_attempts').get()?.state,'dispatch_unknown');
  assert.equal(outbound,1);
});


test('one combined MCP read plus GitHub registered heavy Plan requires both independent Publish grants',async t=>{
  const {service,env,sqlite}=setup(t);
  const endpoint='https://test-mcp.lirtual.dpdns.org/mcp';
  const grant:ReadonlyOperation={
    endpoint,tool:'echo',scope:'read',schema_digest:PINNED_DIGEST,
  };
  const wf=await service.create(JSON.stringify({version:1,name:'MCP+GitHub unified',steps:[
    {id:'read',uses:'mcp.call',with:{
      endpoint,tool:'echo',scope:'read',input_schema:PINNED_SCHEMA,
      arguments:{value:'minimal-test'},
    }},
    {id:'heavy',needs:['read'],uses:'github.run',with:{capability:'github.workflow.check'}},
    {id:'emit',needs:['heavy'],uses:'result.emit',with:{data:{ref:'steps.heavy.output'}}},
  ]}));
  const validation=await service.validate(wf.workflow_id,1);
  assert.equal(validation.valid,true);
  assert.deepEqual((validation as {required_approvals?:ReadonlyOperation[]}).required_approvals,[grant]);
  assert.equal((validation as {requires_heavy_execution_approval?:boolean}).requires_heavy_execution_approval,true);
  await assert.rejects(()=>service.publish(wf.workflow_id,1,[grant],true),/github_execution_approval_required/);
  await assert.rejects(()=>service.publish(wf.workflow_id,1,[grant],false,true),/target_risk_acknowledgment_required/);
  const version=await service.publish(wf.workflow_id,1,[grant],true,true);
  const row=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version.published_version_id) as {plan:string};
  const plan=JSON.parse(row.plan);
  assert.equal(plan.mcp_target_risks_accepted,true);
  assert.equal(plan.github_execution_approved,true);
  assert.deepEqual(plan.mcp_approvals,[grant]);
});


test('GitHub lost wake event recovers from durable D1 receipt, without a second GitHub dispatch',async t=>{
  const {service,env,sqlite}=setup(t);
  Object.assign(env,{
    WORKFLOW_EXECUTOR_GITHUB_TOKEN:'test-token',
    GITHUB_EXECUTOR_REPOSITORY:'lirtual/test-executor',
    GITHUB_EXECUTOR_REPOSITORY_ID:'987654321',
    GITHUB_EXECUTOR_REF:'refs/heads/main',
    GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test',
  });
  const w=await service.create(JSON.stringify({version:1,name:'GitHub lost wake recovery',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
    {id:'out',needs:['heavy'],uses:'result.emit',with:{data:{ref:'steps.heavy.output'}}},
  ]}));
  await service.publish(w.workflow_id,1,[],false,true);
  const admitted=await service.start(w.workflow_id,{});
  let dispatches=0,waits=0;
  const oldFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{
    dispatches++;
    return Response.json({workflow_run_id:39410780231},{status:200});
  }) as typeof fetch;
  const workflow={
    do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    waitForEvent:async(_name:string,option:{type:string;timeout:string})=>{
      waits++;
      assert.equal(option.type,'github-receipt-heavy');
      assert.equal(option.timeout,'30 seconds');
      const attempt=sqlite.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
      sqlite.prepare(`INSERT INTO callback_receipts
        (callback_id,attempt_id,outcome,result_json,created_at)
        VALUES(?,?, 'succeeded', ?, ?)`).run(
          'f8835141-0b3a-4fcb-a9ae-b4b75bfae93c',attempt.attempt_id,
          JSON.stringify({echo:'ok',source:'durable-d1'}),Date.now(),
        );
      throw Error('simulated_lost_event_timeout');
    },
  };
  try{
    await new WorkflowRunner({} as ExecutionContext,env).run(
      {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
      workflow as unknown as WorkflowStep);
  }finally{globalThis.fetch=oldFetch;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.result,{echo:'ok',source:'durable-d1'});
  assert.equal(dispatches,1);
  assert.equal(waits,1);
});

test('GitHub missing callback remains indeterminate after bounded waits, never re-dispatches',async t=>{
  const {service,env,sqlite}=setup(t);
  Object.assign(env,{
    WORKFLOW_EXECUTOR_GITHUB_TOKEN:'test-token',
    GITHUB_EXECUTOR_REPOSITORY:'lirtual/test-executor',
    GITHUB_EXECUTOR_REPOSITORY_ID:'987654321',
    GITHUB_EXECUTOR_REF:'refs/heads/main',
    GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test',
  });
  const w=await service.create(JSON.stringify({version:1,name:'GitHub missed callback',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(w.workflow_id,1,[],false,true);
  const admitted=await service.start(w.workflow_id,{});
  let dispatches=0,waits=0;
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>{
    dispatches++;
    return Response.json({workflow_run_id:39410780231},{status:200});
  }) as typeof fetch;
  const wf={
    do:async(_name:unknown,_opts:unknown,fn:()=>Promise<unknown>)=>fn(),
    waitForEvent:async(_name:string,options:{type:string;timeout:string})=>{
      waits++;
      assert.equal(options.type,'github-receipt-heavy');
      assert.equal(options.timeout,'30 seconds');
      throw Error('callback_never_received');
    },
  };
  try{
    await new WorkflowRunner({} as ExecutionContext,env).run(
      {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
      wf as unknown as WorkflowStep);
  }finally{globalThis.fetch=original;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'indeterminate');
  assert.equal(result.error_code,'github_callback_unconfirmed');
  assert.equal(result.steps[0].status,'indeterminate');
  const heavy=result.steps[0] as AsyncStep;
  const stored=sqlite.prepare('SELECT attempt_id,candidate_run_id,created_at FROM step_attempts').get() as {attempt_id:string;candidate_run_id:number;created_at:number};
  assert.equal(heavy.async_action?.phase,'indeterminate');
  assert.equal(heavy.async_action?.timed_out,true);
  assert.equal(heavy.async_action?.receipt_outcome,null);
  assert.equal(heavy.async_action?.attempt_id,stored.attempt_id);
  assert.equal(heavy.async_action?.external_execution_id,String(stored.candidate_run_id));
  assert.equal(heavy.async_action?.deadline_at,stored.created_at+240000);
  assert.equal(dispatches,1);
  assert.equal(waits,8);
});

test('GitHub admitted Run retains immutable heavy Plan across republish to an Workflow-only Plan',async t=>{
  const {service,env}=setup(t);
  const original=await service.create(JSON.stringify({
    version:1,name:'GitHub original',steps:[
      {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
    ],
  }));
  const v1=await service.publish(original.workflow_id,1,[],false,true);
  const oldRun=await service.start(original.workflow_id,{});
  const changed=await service.update(original.workflow_id,1,JSON.stringify({
    version:1,name:'Workflow replacement',steps:[
      {id:'emit',uses:'result.emit',with:{data:{replacement:true}}},
    ],
  }));
  assert.equal(changed.draft_revision,2);
  const v2=await service.publish(original.workflow_id,2);
  assert.notEqual(v1.published_version_id,v2.published_version_id);
  const newRun=await service.start(original.workflow_id,{});
  assert.equal(oldRun.published_version_id,v1.published_version_id);
  assert.equal(newRun.published_version_id,v2.published_version_id);

  // Shut down the heavy executor. An already admitted V1 Run must still
  // execute *its own* pinned heavy Step, which fails closed and cannot be
  // silently reinterpreted as the newly published Workflow-only Plan.
  let external=0;
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{external++;throw Error('no external dispatch');}) as typeof fetch;
  try{
    const runner=new WorkflowRunner({} as ExecutionContext,env);
    const steps={do:async(_n:unknown,_opts:unknown,fn:()=>Promise<unknown>)=>fn()} as unknown as WorkflowStep;
    await runner.run({payload:{run_id:oldRun.run_id}} as WorkflowEvent<{run_id:string}>,steps);
    await runner.run({payload:{run_id:newRun.run_id}} as WorkflowEvent<{run_id:string}>,steps);
  }finally{globalThis.fetch=previousFetch;}
  const before=await service.result(oldRun.run_id);
  const after=await service.result(newRun.run_id);
  assert.equal(before.status,'failed');
  assert.deepEqual(before.steps.map(s=>s.step_id),['heavy']);
  assert.equal(after.status,'succeeded');
  assert.deepEqual(after.result,{replacement:true});
  assert.deepEqual(after.steps.map(s=>s.step_id),['emit']);
  assert.equal(external,0);
});

test('a legacy Published Workflow Plan tampered to add github.run cannot gain a GitHub grant',async t=>{
  const {service,env,sqlite}=setup(t);
  const wf=await service.create(JSON.stringify({version:1,name:'legacy Workflow',steps:[
    {id:'emit',uses:'result.emit',with:{data:{safe:true}}},
  ]}));
  const v=await service.publish(wf.workflow_id,1);
  const run=await service.start(wf.workflow_id,{});
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(
    JSON.stringify({version:1,name:'tampered',steps:[
      {id:'heavy',needs:[],uses:'github.run',with:{capability:'github.workflow.check'}},
    ]}),v.published_version_id,
  );
  let outbound=0;
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>{outbound++;throw Error('unauthorized request');}) as typeof fetch;
  try{
    await new WorkflowRunner({} as ExecutionContext,env).run(
      {payload:{run_id:run.run_id}} as WorkflowEvent<{run_id:string}>,
      {do:async(_n:unknown,_opts:unknown,fn:()=>Promise<unknown>)=>fn()} as unknown as WorkflowStep);
  }finally{globalThis.fetch=original;}
  const result=await service.result(run.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].step_id,'heavy');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(outbound,0);
});

test('MCP refuses publish when Portal is not configured',async t=>{
  const {service,env,sqlite}=setup(t);
  env.MCP_PORTAL_ENDPOINT=undefined;
  const grant:ReadonlyOperation={endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const wf=await service.create(JSON.stringify({version:1,name:'requires pinned Portal',steps:[
    {id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',
      input_schema:PINNED_SCHEMA,arguments:{value:'no dispatch'}}},
  ]}));
  await assert.rejects(()=>service.publish(wf.workflow_id,1,[grant],true),/portal_target_not_configured/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
});

test('MCP pinned Portal refuses a different approved endpoint at Publish',async t=>{
  const {service,env,sqlite}=setup(t);
  env.MCP_PORTAL_ENDPOINT='https://test-mcp.lirtual.dpdns.org/mcp';
  const grant:ReadonlyOperation={
    endpoint:'https://another.example.org/mcp',tool:'echo',scope:'read',
    schema_digest:PINNED_DIGEST,
  };
  const wf=await service.create(JSON.stringify({version:1,name:'portal pinned',steps:[
    {id:'read',uses:'mcp.call',with:{
      endpoint:grant.endpoint,tool:grant.tool,scope:grant.scope,
      input_schema:PINNED_SCHEMA,arguments:{value:'must not be published'},
    }},
  ]}));
  await assert.rejects(()=>service.publish(wf.workflow_id,1,[grant],true),
    /portal_target_not_authorized/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
});

type AsyncStep={step_id:string;status:string;async_action?:{
  phase:string;attempt_id:string;external_execution_id:string|null;
  receipt_outcome:string|null;deadline_at:number|null;timed_out:boolean;
}};
function enableGithub(env:Env){
  Object.assign(env,{
    WORKFLOW_EXECUTOR_GITHUB_TOKEN:'fixture-token',
    GITHUB_EXECUTOR_REPOSITORY:'lirtual/test-executor',
    GITHUB_EXECUTOR_REPOSITORY_ID:'987654321',
    GITHUB_EXECUTOR_REF:'refs/heads/main',
    GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test',
  });
}

test('GitHub status shows dispatch accepted then pending, and the wake payload cannot replace the receipt',async t=>{
  const {service,env,sqlite}=setup(t);
  enableGithub(env);
  const created=await service.create(JSON.stringify({version:1,name:'GitHub phases',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(created.workflow_id,1,[],false,true);
  const accepted=await service.start(created.workflow_id,{});
  let posts=0,waits=0;
  const seen:AsyncStep[]=[];
  let runStatus='';
  const previous=globalThis.fetch;
  globalThis.fetch=(async()=>{
    posts++;
    return Response.json({workflow_run_id:555001},{status:200});
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  const step={
    do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    waitForEvent:async(_name:string,options:{type:string;timeout:string})=>{
      waits++;
      assert.equal(options.type,'github-receipt-heavy');
      assert.equal(options.timeout,'30 seconds');
      const during=await service.status(accepted.run_id);
      runStatus=during.status;
      const heavy=during.steps[0] as AsyncStep;
      const row=sqlite.prepare('SELECT attempt_id,candidate_run_id,created_at FROM step_attempts').get() as {
        attempt_id:string;candidate_run_id:number;created_at:number};
      seen.push(heavy);
      if(waits===1){
        sqlite.prepare("UPDATE step_attempts SET state='claimed',owner_run_id=?,owner_run_attempt=1 WHERE attempt_id=?")
          .run(row.candidate_run_id,row.attempt_id);
        const pending=await service.status(accepted.run_id);
        seen.push(pending.steps[0] as AsyncStep);
        throw Error('claimed_job_still_running');
      }
      sqlite.prepare(`INSERT INTO callback_receipts
        (callback_id,attempt_id,outcome,result_json,created_at)
        VALUES(?,?, 'succeeded', ?, ?)`).run(
        'f8835141-0b3a-4fcb-a9ae-b4b75bfae93c',row.attempt_id,
        JSON.stringify({echo:'from-receipt'}),Date.now());
      return {payload:{outcome:'failed',echo:'from-event'}};
    },
  };
  await new WorkflowRunner({} as ExecutionContext,env).run(
    {payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>,
    step as unknown as WorkflowStep);
  assert.equal(runStatus,'running');
  assert.equal(seen[0]?.status,'running');
  assert.equal(seen[0]?.async_action?.phase,'dispatch_accepted');
  assert.equal(seen[0]?.async_action?.receipt_outcome,null);
  assert.equal(seen[0]?.async_action?.timed_out,false);
  const stored=sqlite.prepare('SELECT attempt_id,candidate_run_id,created_at FROM step_attempts').get() as {
    attempt_id:string;candidate_run_id:number;created_at:number};
  assert.equal(seen[0]?.async_action?.attempt_id,stored.attempt_id);
  assert.equal(seen[0]?.async_action?.external_execution_id,String(stored.candidate_run_id));
  assert.equal(seen[0]?.async_action?.deadline_at,stored.created_at+240000);
  assert.equal(seen[1]?.async_action?.phase,'pending');
  const result=await service.result(accepted.run_id);
  const done=result.steps[0] as AsyncStep;
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.result,{echo:'from-receipt'});
  assert.equal(done.async_action?.phase,'external_terminal');
  assert.equal(done.async_action?.receipt_outcome,'succeeded');
  assert.equal(posts,1);
  assert.equal(waits,2);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM step_attempts').get() as {n:number}).n,1);
});

test('a failed GitHub receipt is an external terminal failure, not indeterminate',async t=>{
  const {service,env,sqlite}=setup(t);
  enableGithub(env);
  const created=await service.create(JSON.stringify({version:1,name:'GitHub job failed',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(created.workflow_id,1,[],false,true);
  const accepted=await service.start(created.workflow_id,{});
  let posts=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async()=>{posts++;return Response.json({workflow_run_id:555002},{status:200});}) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  await new WorkflowRunner({} as ExecutionContext,env).run(
    {payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>fn(),
      waitForEvent:async()=>{
        const row=sqlite.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
        sqlite.prepare("UPDATE step_attempts SET state='claimed',owner_run_id=555002,owner_run_attempt=1 WHERE attempt_id=?").run(row.attempt_id);
        sqlite.prepare(`INSERT INTO callback_receipts
          (callback_id,attempt_id,outcome,result_json,created_at)
          VALUES(?,?, 'failed', ?, ?)`).run(
          'f8835141-0b3a-4fcb-a9ae-b4b75bfae93d',row.attempt_id,
          JSON.stringify({code:'ci_failed'}),Date.now());
        throw Error('wake_lost');
      }} as unknown as WorkflowStep);
  const result=await service.result(accepted.run_id);
  const heavy=result.steps[0] as AsyncStep;
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].error_code,'github_job_failed');
  assert.equal(result.result,null);
  assert.equal(heavy.async_action?.phase,'external_terminal');
  assert.equal(heavy.async_action?.receipt_outcome,'failed');
  assert.equal(heavy.async_action?.timed_out,false);
  assert.equal(posts,1);
});

test('an early GitHub receipt is the result and does not wait or dispatch twice',async t=>{
  const {service,env,sqlite}=setup(t);
  enableGithub(env);
  const created=await service.create(JSON.stringify({version:1,name:'GitHub early receipt',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(created.workflow_id,1,[],false,true);
  const accepted=await service.start(created.workflow_id,{});
  let posts=0,waits=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async()=>{posts++;return Response.json({workflow_run_id:555003},{status:200});}) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  await new WorkflowRunner({} as ExecutionContext,env).run(
    {payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>{
      const opened=await fn();
      const row=sqlite.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
      sqlite.prepare("UPDATE step_attempts SET state='claimed',owner_run_id=555003,owner_run_attempt=1 WHERE attempt_id=?").run(row.attempt_id);
      sqlite.prepare(`INSERT INTO callback_receipts
        (callback_id,attempt_id,outcome,result_json,created_at)
        VALUES(?,?, 'succeeded', ?, ?)`).run(
        'f8835141-0b3a-4fcb-a9ae-b4b75bfae93e',row.attempt_id,
        JSON.stringify({echo:'early'}),Date.now());
      return opened;
    },waitForEvent:async()=>{waits++;throw Error('too_late_to_wait');}} as unknown as WorkflowStep);
  const result=await service.result(accepted.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.result,{echo:'early'});
  assert.equal((result.steps[0] as AsyncStep).async_action?.phase,'external_terminal');
  assert.equal(posts,1);
  assert.equal(waits,0);
});

test('a GitHub attempt past its explicit deadline is indeterminate and is not dispatched',async t=>{
  const {service,env,sqlite}=setup(t);
  enableGithub(env);
  const created=await service.create(JSON.stringify({version:1,name:'GitHub deadline',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(created.workflow_id,1,[],false,true);
  const accepted=await service.start(created.workflow_id,{});
  const aged=Date.now()-240000-1000;
  sqlite.prepare(`INSERT INTO step_attempts
    (attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,
     workflow_ref,ref,candidate_run_id,candidate_run_attempt,created_at,updated_at)
    VALUES (?,?,?,?,?,'confirmed',?,?,?,?,?,?,?,?)`).run(
    'b6835141-0b3a-4fcb-a9ae-b4b75bfae93c',accepted.run_id,'heavy','github.workflow.check',
    'd9b3439b-b7ed-4812-9064-75c925f93c6a','lirtual/test-executor','987654321',
    'lirtual/test-executor/.github/workflows/workflow-github-executor.yml@refs/heads/main',
    'refs/heads/main',555004,1,aged,aged);
  let posts=0,waits=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async()=>{posts++;throw Error('must not redispatch');}) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  await new WorkflowRunner({} as ExecutionContext,env).run(
    {payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>fn(),
      waitForEvent:async()=>{waits++;throw Error('must not wait');}} as unknown as WorkflowStep);
  const result=await service.result(accepted.run_id);
  const heavy=result.steps[0] as AsyncStep;
  assert.equal(result.status,'indeterminate');
  assert.equal(result.error_code,'github_callback_unconfirmed');
  assert.equal(heavy.async_action?.phase,'indeterminate');
  assert.equal(heavy.async_action?.timed_out,true);
  assert.equal(heavy.async_action?.external_execution_id,'555004');
  assert.equal(heavy.async_action?.deadline_at,aged+240000);
  assert.equal(posts,0);
  assert.equal(waits,0);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM step_attempts').get() as {n:number}).n,1);
});

test('worker recovery after an accepted GitHub dispatch does not redispatch and keeps the receipt',async t=>{
  const {service,env,sqlite}=setup(t);
  enableGithub(env);
  const created=await service.create(JSON.stringify({version:1,name:'GitHub recovery',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
  ]}));
  await service.publish(created.workflow_id,1,[],false,true);
  const accepted=await service.start(created.workflow_id,{});
  let posts=0,opens=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async()=>{
    posts++;
    return Response.json({workflow_run_id:555005},{status:200});
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  const event={payload:{run_id:accepted.run_id}} as WorkflowEvent<{run_id:string}>;
  const step={
    do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>{
      const opened=await fn();
      opens++;
      if(opens===1)throw Error('worker_replaced');
      return opened;
    },
    waitForEvent:async()=>{
      const row=sqlite.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
      sqlite.prepare("UPDATE step_attempts SET state='claimed',owner_run_id=555005,owner_run_attempt=1 WHERE attempt_id=?").run(row.attempt_id);
      sqlite.prepare(`INSERT INTO callback_receipts
        (callback_id,attempt_id,outcome,result_json,created_at)
        VALUES(?,?, 'succeeded', ?, ?)`).run(
        'f8835141-0b3a-4fcb-a9ae-b4b75bfae940',row.attempt_id,
        JSON.stringify({echo:'recovered'}),Date.now());
      throw Error('wake_lost_after_recovery');
    },
  };
  const runner=new WorkflowRunner({} as ExecutionContext,env);
  await assert.rejects(()=>runner.run(event,step as unknown as WorkflowStep),/worker_replaced/);
  const mid=await service.status(accepted.run_id);
  assert.equal(mid.status,'running');
  assert.equal((mid.steps[0] as AsyncStep).async_action?.phase,'dispatch_accepted');
  assert.equal((mid.steps[0] as AsyncStep).async_action?.external_execution_id,'555005');
  await runner.run(event,step as unknown as WorkflowStep);
  const result=await service.result(accepted.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.result,{echo:'recovered'});
  assert.equal((result.steps[0] as AsyncStep).async_action?.phase,'external_terminal');
  assert.equal(posts,1);
  assert.equal(opens,2);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM step_attempts').get() as {n:number}).n,1);
  assert.equal((sqlite.prepare('SELECT state FROM step_attempts').get() as {state:string}).state,'claimed');
});
