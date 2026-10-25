import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
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
import {listAvailableGitHubActions} from '../src/github-action-catalog.ts';
import {parseGitHubAction} from '../src/github-action-contract.ts';
import {reviewedGitHubAction} from '../src/github-action-review.ts';

// Only the Cloudflare orchestration shell and remote MCP peer are substituted.
const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',shortCircuit:true};
  return next(specifier,context);
}});
const { WorkflowOrchestrator }=await import('../src/runner.ts');
hook.deregister();

test('WorkflowOrchestrator is the only native Workflow implementation export',()=>{
  assert.equal(WorkflowOrchestrator.name,'WorkflowOrchestrator');
});

function deferred(){
  let resolve!:()=>void;
  const promise=new Promise<void>(r=>{resolve=r;});
  return {promise,resolve};
}

const ECHO_GRANT:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
    MCP_PORTAL_ENDPOINT:'https://mcp.lirtual.dpdns.org/mcp',
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
    await new WorkflowOrchestrator({} as ExecutionContext,env).run({payload:{run_id}} as WorkflowEvent<{run_id:string}>,
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
    endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
    input_schema:PINNED_SCHEMA,arguments:{value:'hello'},
  }}];
  const plan=JSON.stringify({version:1,name:'MCP approval gate',steps});
  const created=await service.create(plan);
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
      endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
      input_schema:PINNED_SCHEMA,arguments:{value:'hello'},
    },
  }]}));
  const validation=await service.validate(created.workflow_id,1);
  assert.equal(validation.valid,true);
  if(!('required_approvals' in validation))throw Error('expected approval preview');
  assert.deepEqual(validation.required_approvals,[{
    endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
    schema_digest:PINNED_DIGEST,
  }]);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[{
    endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
    schema_digest:'0'.repeat(64),
  }]),/external_approval_required/);
});

test('MCP remote inputSchema drift prevents tools/call, even when target and tool still match',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
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


test('retired fixed GitHub executor is neither publishable nor runnable',async t=>{
  const {service,env,sqlite}=setup(t);
  const retired={id:'old',uses:'github.run',needs:[],with:{capability:'github.workflow.check'}};
  const draft=await service.create(JSON.stringify({version:1,name:'Unsupported',steps:[retired]}));
  const validity=await service.validate(draft.workflow_id,1);
  assert.equal(validity.valid,false);
  await assert.rejects(()=>service.publish(draft.workflow_id,1,[],false,true),/unsupported_github_capability/);
  const supported=await service.create(JSON.stringify({version:1,name:'Known',steps:[
    {id:'emit',uses:'result.emit',with:{data:'safe'}},
  ]}));
  const published=await service.publish(supported.workflow_id,1);
  const admitted=await service.start(supported.workflow_id,{});
  // Even a tampered persisted Plan with an explicit heavy grant cannot
  // restore the deleted registered executor or dispatch unapproved work.
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(
    JSON.stringify({version:1,name:'tampered',github_execution_approved:true,steps:[retired]}),
    published.published_version_id);
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=(async()=>{calls++;throw Error('unexpected external request');}) as typeof fetch;
  try{
    await new WorkflowOrchestrator({} as ExecutionContext,env).run(
      {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
      {do:async(_n:unknown,_o:unknown,fn:()=>Promise<unknown>)=>fn()} as unknown as WorkflowStep);
  }finally{globalThis.fetch=original;}
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].error_code,'github_capability_not_registered');
  assert.equal(calls,0);
});

test('MCP refuses publish when Portal is not configured',async t=>{
  const {service,env,sqlite}=setup(t);
  env.MCP_PORTAL_ENDPOINT=undefined;
  const grant:ReadonlyOperation={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const wf=await service.create(JSON.stringify({version:1,name:'requires pinned Portal',steps:[
    {id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',
      input_schema:PINNED_SCHEMA,arguments:{value:'no dispatch'}}},
  ]}));
  await assert.rejects(()=>service.publish(wf.workflow_id,1,[grant],true),/portal_target_not_configured/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
});

test('MCP pinned Portal refuses a different approved endpoint at Publish',async t=>{
  const {service,env,sqlite}=setup(t);
  env.MCP_PORTAL_ENDPOINT='https://mcp.lirtual.dpdns.org/mcp';
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

test('pinned Action review stays publishable after default branch advances',async t=>{
  const {service,env,sqlite}=setup(t);
  const repository='lirtual/session-actions',repositoryId=123,workflowId=456;
  const workflowPath='.github/workflows/verify-action.yml';
  const approvedSha='a'.repeat(40),newestSha='b'.repeat(40);
  const yaml=`name: Verified task
on:
  workflow_dispatch:
    inputs:
      attempt_id:
        type: string
        required: true
      dispatch_id:
        type: string
        required: true
      capability_id:
        type: string
        required: true
env:
  WORKFLOW_ACTION_TYPE: task
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo verified
`;
  env.WORKFLOW_GITHUB_DISPATCH_TOKEN='test-token';
  env.GITHUB_ACTION_APPROVED_REPOSITORIES=JSON.stringify([{repository,repositoryId}]);
  const requests:string[]=[];
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init),url=new URL(req.url);
    assert.equal(req.method,'GET');
    assert.equal(url.origin,'https://api.github.com');
    requests.push(url.pathname+url.search);
    const root='/repos/'+repository;
    if(url.pathname===root)return Response.json({id:repositoryId,full_name:repository,default_branch:'main'});
    if(url.pathname===root+'/commits/main')return Response.json({sha:newestSha});
    if(url.pathname===root+'/tags')return Response.json([]);
    if(url.pathname===root+'/commits/'+approvedSha)return Response.json({sha:approvedSha});
    if(url.pathname===root+'/actions/workflows')return Response.json({
      workflows:[{id:workflowId,path:workflowPath,state:'active'}],
    });
    if(url.pathname===root+'/contents/'+workflowPath){
      assert.ok(url.searchParams.get('ref')===approvedSha||
        url.searchParams.get('ref')===newestSha);
      return Response.json({path:workflowPath,encoding:'base64',content:btoa(yaml)});
    }
    if(url.pathname===root+'/git/ref/tags/approved-v1')return Response.json({
      ref:'refs/tags/approved-v1',object:{type:'commit',sha:approvedSha},
    });
    return new Response('not found',{status:404});
  }) as typeof fetch;
  try{
    // Moving-HEAD discovery remains fresh without any repository-config edit.
    const listed=await listAvailableGitHubActions(env);
    assert.deepEqual(listed.actions.map(x=>x.commitSha),[newestSha]);
    const action=await reviewedGitHubAction({
      repository,repositoryId,workflowId,workflowPath,commitSha:approvedSha,
      contract:parseGitHubAction(yaml),
    });
    const definition=JSON.stringify({version:1,name:'Pinned Action review',
      steps:[{id:'check',uses:'github.run',with:{
        capability:'github.action',action:{...action,ref:'refs/tags/approved-v1',inputs:{}},
      }}]});
    const created=await service.create(definition);
    const marker=requests.length;
    const validated=await service.validate(created.workflow_id,1);
    assert.equal(validated.valid,true);
    assert.ok('reviewed_actions' in validated);
    assert.deepEqual(validated.reviewed_actions,[action]);
    const published=await service.publish(created.workflow_id,1,[],false,true,[action]);
    const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(published.published_version_id) as {plan:string};
    const final=JSON.parse(saved.plan);
    assert.equal(final.github_execution_approved,true);
    assert.deepEqual(final.github_action_approvals,[action]);
    const duringApproval=requests.slice(marker);
    const root='/repos/'+repository;
    assert.ok(duringApproval.filter(p=>p===root+'/commits/'+approvedSha).length>=2);
    assert.ok(duringApproval.some(p=>p.endsWith('?ref='+approvedSha)));
    assert.ok(!duringApproval.some(p=>p===root+'/commits/main'));
    assert.ok(!duringApproval.some(p=>p.endsWith('?ref='+newestSha)));
    assert.ok(duringApproval.filter(p=>p===root+'/git/ref/tags/approved-v1').length>=2);
  }finally{globalThis.fetch=previous;}
});


test('explicit allow_skipped joins either conditional branch without changing ordinary skips',async t=>{
  const {service,admit,run}=setup(t);
  for(const choice of ['left','right']){
    const steps=[
      {id:'left',uses:'result.emit',if:{eq:[{ref:'inputs.choice'},'left']},with:{data:'L'}},
      {id:'right',uses:'result.emit',if:{eq:[{ref:'inputs.choice'},'right']},with:{data:'R'}},
      {id:'join',uses:'result.emit',needs:['left','right'],needs_policy:'allow_skipped',
        with:{data:{left:{ref:'steps.left.status'},right:{ref:'steps.right.status'}}}},
    ];
    const admitted=await admit(steps,{choice});
    await run(admitted.run_id);
    const outcome=await service.result(admitted.run_id);
    assert.equal(outcome.status,'succeeded');
    assert.equal(outcome.steps.find(x=>x.step_id==='join')?.status,'succeeded');
    assert.deepEqual(outcome.result,choice==='left'?
      {left:'succeeded',right:'skipped'}:{left:'skipped',right:'succeeded'});
  }
  const defaultJoin=await admit([
    {id:'left',uses:'result.emit',if:false,with:{data:'unused'}},
    {id:'join',uses:'result.emit',needs:['left'],with:{data:'must not run'}},
  ]);
  await run(defaultJoin.run_id);
  const result=await service.result(defaultJoin.run_id);
  assert.equal(result.steps.find(x=>x.step_id==='join')?.status,'skipped');
});

test('skip-tolerant join still blocks failed and indeterminate dependencies',async t=>{
  const {service,admit,run}=setup(t);
  const failed=await admit([
    {id:'oversized',uses:'result.emit',with:{data:{ref:'inputs.big'}}},
    {id:'join',needs:['oversized'],needs_policy:'allow_skipped',
      uses:'result.emit',with:{data:'must not run'}},
  ],{big:'x'.repeat(65520)});
  await run(failed.run_id);
  const failure=await service.result(failed.run_id);
  assert.equal(failure.status,'failed');
  assert.equal(failure.steps.find(x=>x.step_id==='oversized')?.status,'failed');
  assert.equal(failure.steps.find(x=>x.step_id==='join')?.status,'skipped');

  mockPublicPeer(t,async()=>{throw Error('simulated_lost_response');});
  const uncertain=await admit([
    echoStep('read',{value:'may have executed'}),
    {id:'join',needs:['read'],needs_policy:'allow_skipped',
      uses:'result.emit',with:{data:'must not run'}},
  ],{},[ECHO_GRANT]);
  await run(uncertain.run_id);
  const ambiguous=await service.result(uncertain.run_id);
  assert.equal(ambiguous.status,'indeterminate');
  assert.equal(ambiguous.steps.find(x=>x.step_id==='read')?.status,'indeterminate');
  assert.equal(ambiguous.steps.find(x=>x.step_id==='join')?.status,'skipped');
});

test('all-skipped join never calls a reviewed external MCP Action',async t=>{
  const {service,admit,run}=setup(t);
  let externalCalls=0;
  mockPublicPeer(t,async()=>{externalCalls++;});
  const joined=echoStep('join',{value:'must not dispatch'});
  const created=await admit([
    {id:'left',uses:'result.emit',if:false,with:{data:'unused left'}},
    {id:'right',uses:'result.emit',if:false,with:{data:'unused right'}},
    {...joined,needs:['left','right'],needs_policy:'allow_skipped'},
  ],{},[ECHO_GRANT]);
  await run(created.run_id);
  const result=await service.result(created.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.steps.map(s=>[s.step_id,s.status]),[
    ['join','skipped'],['left','skipped'],['right','skipped'],
  ]);
  assert.equal(externalCalls,0,'no branch ran so a join may not dispatch an external effect');
});


test('literal repeat runs stable ordered native Steps under one immutable Published Plan',async t=>{
  const {service,admit,run,sqlite}=setup(t);
  const started=await admit([
    {id:'echo',flow:'repeat',times:3,
      template:{uses:'result.emit',with:{data:{ref:'inputs.message'}}}},
    {id:'after',needs:['echo_2'],uses:'result.emit',with:{data:'completed'}},
  ],{message:'hello'});
  const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
    .get(started.published_version_id) as {plan:string};
  const plan=JSON.parse(saved.plan);
  assert.deepEqual(plan.steps.map((s:{id:string})=>s.id),
    ['echo_0','echo_1','echo_2','after']);
  assert.deepEqual(plan.steps.find((s:{id:string})=>s.id==='echo_2').needs,['echo_1']);
  await run(started.run_id);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.result,'completed');
  assert.ok(['echo_0','echo_1','echo_2','after'].every(id=>
    result.steps.find(x=>x.step_id===id)?.status==='succeeded'));
  assert.equal(result.published_version_id,started.published_version_id);
});

test('a skipped first repeat iteration prevents later dispatches',async t=>{
  const {service,admit,run}=setup(t);
  let dispatched=0;
  mockPublicPeer(t,async()=>{dispatched++;});
  const started=await admit([
    {id:'read',flow:'repeat',times:3,
      template:{uses:'mcp.call',if:false,with:{
        endpoint:ECHO_GRANT.endpoint,tool:ECHO_GRANT.tool,scope:'read',
        input_schema:PINNED_SCHEMA,arguments:{value:'do not dispatch'},
      }}},
  ],{},[ECHO_GRANT]);
  await run(started.run_id);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.steps.map(x=>x.status),['skipped','skipped','skipped']);
  assert.equal(dispatched,0);
});


test('inline bounded-repeat validation reports repairable errors without D1 writes',async t=>{
  const {service,sqlite}=setup(t);
  const before=sqlite.prepare('SELECT COUNT(*) AS n FROM workflows').get() as {n:number};
  const invalid=await service.validateDefinition(JSON.stringify({version:1,name:'Invalid repeat',
    steps:[{id:'loop',flow:'repeat',times:99,
      template:{uses:'result.emit',with:{data:'unused'}}}]}));
  assert.equal(invalid.valid,false);
  assert.equal(invalid.issues[0].code,'invalid_repeat_count');
  assert.equal(invalid.issues[0].path,'/steps/0/times');
  assert.match(String(invalid.issues[0].suggestion),/literal times integer/);
  const after=sqlite.prepare('SELECT COUNT(*) AS n FROM workflows').get() as {n:number};
  assert.equal(after.n,before.n);
});


test('dynamic foreach freezes upstream item values before executing all bounded emit children',async t=>{
  const {service,admit,env}=setup(t);
  const started=await admit([
    {id:'source',uses:'result.emit',with:{data:{ref:'inputs.items'}}},
    {id:'each',flow:'foreach',needs:['source'],items:{ref:'steps.source.output'},max_items:4,
      template:{steps:[{id:'emit',uses:'result.emit',with:{
        data:{item:{ref:'item.value'},index:{ref:'item.index'}},
      }}]}},
    {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
  ],{items:['A','B']});
  const checkpoints:string[]=[];
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{
      checkpoints.push(name);
      return callback();
    }} as unknown as WorkflowStep);
  const output=await service.result(started.run_id);
  assert.equal(output.status,'succeeded');
  assert.deepEqual(output.result,[{item:'A',index:0},{item:'B',index:1}]);
  assert.deepEqual(checkpoints,[
    'workflow-source','workflow-each-snapshot','workflow-each_0_emit',
    'workflow-each_1_emit','workflow-done',
  ]);
  const byStep=new Map(output.steps.map(x=>[x.step_id,x.status]));
  assert.equal(byStep.get('each'),'succeeded');
  assert.equal(byStep.get('each_0_emit'),'succeeded');
  assert.equal(byStep.get('each_1_emit'),'succeeded');
  assert.equal(byStep.get('done'),'succeeded');
});

test('dynamic foreach empty array skips parent and dependent Step without dispatching children',async t=>{
  const {service,admit,run}=setup(t);
  const started=await admit([
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:8,
      template:{steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'item.value'}}}]}},
    {id:'dependent',needs:['each'],uses:'result.emit',with:{data:'never run'}},
  ],{items:[]});
  await run(started.run_id);
  const output=await service.result(started.run_id);
  assert.equal(output.status,'succeeded');
  assert.equal(output.steps.find(x=>x.step_id==='each')?.status,'skipped');
  assert.equal(output.steps.find(x=>x.step_id==='dependent')?.status,'skipped');
  assert.equal(output.steps.length,2);
});

test('dynamic foreach item overflow fails at runtime before any child execution',async t=>{
  const {service,admit,env}=setup(t);
  const started=await admit([
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
      template:{steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'item.value'}}}]}},
  ],{items:['one','two','three']});
  const names:string[]=[];
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(name:string,_options:unknown,cb:()=>Promise<unknown>)=>{
      names.push(name);return cb();
    }} as unknown as WorkflowStep);
  const output=await service.result(started.run_id);
  assert.equal(output.status,'failed');
  assert.equal(output.steps.find(x=>x.step_id==='each')?.status,'failed');
  assert.deepEqual(names,['workflow-each-snapshot']);
});

test('dynamic foreach per-item if is snapshotted, with skipped item recorded',async t=>{
  const {service,admit,run}=setup(t);
  const started=await admit([
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:3,
      template:{steps:[{id:'emit',uses:'result.emit',
        if:{eq:[{ref:'item.value'},'yes']},with:{data:{ref:'item.index'}}}]}},
  ],{items:['no','yes']});
  await run(started.run_id);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.result,[null,1]);
  assert.equal(result.steps.find(x=>x.step_id==='each_0_emit')?.status,'skipped');
  assert.equal(result.steps.find(x=>x.step_id==='each_1_emit')?.status,'succeeded');
});


test('durable foreach snapshot survives replay without reevaluating changed item input',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const started=await admit([
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
      template:{steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'item.value'}}}]}},
  ],{items:['original']});
  const cache=new Map<string,unknown>();
  const callbacks=new Map<string,number>();
  const native={do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{
    if(cache.has(name))return cache.get(name);
    callbacks.set(name,(callbacks.get(name)??0)+1);
    const value=await callback();
    cache.set(name,value);
    return value;
  }} as unknown as WorkflowStep;
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,native);
  assert.deepEqual((await service.result(started.run_id)).result,['original']);
  // A synthetic interrupted native continuation re-enters this same pinned
  // Run with changed D1 input; cached native snapshots must remain authoritative.
  sqlite.prepare("UPDATE runs SET outcome='running',inputs=?,result=NULL WHERE id=?")
    .run(JSON.stringify({items:['tampered','second']}),started.run_id);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,native);
  const result=await service.result(started.run_id);
  assert.deepEqual(result.result,['original']);
  assert.equal(result.status,'succeeded');
  assert.equal(callbacks.get('workflow-each-snapshot'),1);
  assert.equal(callbacks.get('workflow-each_0_emit'),1);
  assert.equal(cache.has('workflow-each_1_emit'),false);
});


test('terminal Run never reports an unresolved dynamic child as still running',async t=>{
  const {service,admit,run,sqlite}=setup(t);
  const started=await admit([
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
      template:{steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'item.value'}}}]}},
  ],{items:['value']});
  await run(started.run_id);
  sqlite.prepare("UPDATE run_steps SET status='running' WHERE run_id=? AND step_id='each_0_emit'")
    .run(started.run_id);
  const output=await service.result(started.run_id);
  assert.equal(output.status,'succeeded');
  assert.equal(output.steps.find(s=>s.step_id==='each_0_emit')?.status,'indeterminate');
  assert.equal(output.steps.find(s=>s.step_id==='each')?.status,'succeeded');
  const raw=sqlite.prepare("SELECT status FROM run_steps WHERE run_id=? AND step_id='each_0_emit'")
    .get(started.run_id) as {status:string};
  assert.equal(raw.status,'running','status readback must not rewrite evidence');
});


const readForeach=(args:Record<string,unknown>={value:{ref:'item.value'}}, extra:Record<string,unknown>={})=>({
  id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:3,
  template:{steps:[{id:'read',uses:'mcp.call',with:{
    endpoint:ECHO_GRANT.endpoint,tool:ECHO_GRANT.tool,scope:'read',
    input_schema:PINNED_SCHEMA,arguments:args,
  },...extra}]},
});

test('foreach MCP requires exact owner approval and freezes input before bounded calls',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const definition=JSON.stringify({version:1,name:'Readonly foreach',steps:[readForeach()]});
  const validation=await service.validateDefinition(definition);
  assert.equal(validation.valid,true);
  assert.deepEqual(validation.required_approvals,[ECHO_GRANT]);
  const draft=await service.create(definition);
  await assert.rejects(()=>service.publish(draft.workflow_id,1),/external_approval_required/);
  await assert.rejects(()=>service.publish(draft.workflow_id,1,[ECHO_GRANT]),/target_risk_acknowledgment_required/);
  const admitted=await admit([readForeach()],{items:['A','B']},[ECHO_GRANT]);
  let calls=0;
  mockPublicPeer(t,async()=>{calls++;});
  const checkpoints:string[]=[];
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(name:string,_options:unknown,cb:()=>Promise<unknown>)=>{
      checkpoints.push(name);return cb();
    }} as unknown as WorkflowStep);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(calls,2);
  assert.deepEqual(checkpoints.slice(0,3),[
    'workflow-each-snapshot','workflow-each_0_read','workflow-each_1_read']);
  assert.ok(JSON.stringify(result.result).includes('A'));
  assert.ok(JSON.stringify(result.result).includes('B'));
  for(const name of ['each_0_read','each_1_read']){
    assert.equal(result.steps.find(x=>x.step_id===name)?.status,'succeeded');
    assert.equal((sqlite.prepare('SELECT count(*) AS n FROM run_steps WHERE run_id=? AND step_id=?')
      .get(admitted.run_id,name) as {n:number}).n,1);
  }
});

test('foreach MCP conditional skip and oversize guard prevent dispatch',async t=>{
  const {service,admit,run}=setup(t);
  let calls=0;
  mockPublicPeer(t,async()=>{calls++;});
  const conditional=await admit([readForeach({value:{ref:'item.value'}},
    {if:{eq:[{ref:'item.value'},'yes']}})],{items:['no','yes']},[ECHO_GRANT]);
  await run(conditional.run_id);
  const skipped=await service.result(conditional.run_id);
  assert.equal(skipped.status,'succeeded');
  assert.equal(skipped.steps.find(x=>x.step_id==='each_0_read')?.status,'skipped');
  assert.equal(calls,1);
  const overflow=await admit([readForeach()],{items:['A','B','C','D']},[ECHO_GRANT]);
  await run(overflow.run_id);
  assert.equal((await service.result(overflow.run_id)).status,'failed');
  assert.equal(calls,1,'overflow is rejected before any side effect');
});

test('lost foreach MCP child checkpoint is fenced on replay without duplicate peer call',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const admitted=await admit([readForeach()],{items:['frozen']},[ECHO_GRANT]);
  let calls=0;
  mockPublicPeer(t,async()=>{calls++;});
  let dropped=false;
  const native={do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{
    const result=await callback();
    if(name==='workflow-each_0_read'&&!dropped){
      dropped=true;
      throw Error('native checkpoint response lost after an actual remote call');
    }
    return result;
  }} as unknown as WorkflowStep;
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,native);
  const first=await service.result(admitted.run_id);
  assert.equal(first.status,'indeterminate');
  assert.equal(calls,1);
  assert.equal(first.steps.find(s=>s.step_id==='each_0_read')?.status,'indeterminate');
  // Simulate a restarted orchestration callback with the checkpoint missing;
  // D1's child row remains the final no-second-dispatch fence.
  sqlite.prepare("UPDATE runs SET outcome='running',inputs=?,result=NULL WHERE id=?")
    .run(JSON.stringify({items:['tampered']}),admitted.run_id);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,native);
  const replay=await service.result(admitted.run_id);
  assert.equal(replay.status,'indeterminate');
  assert.equal(calls,1,'an unknown external effect must never be repeated');
  assert.notEqual(replay.steps.find(s=>s.step_id==='each_0_read')?.status,'succeeded');
});
