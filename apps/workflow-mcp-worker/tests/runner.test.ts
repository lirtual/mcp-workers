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

// Only the platform base class is substituted; Runner, SQL, Plan and MCP fixture are real.
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

function setup(t:test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const file of ['0001_s1.sql','0002_native_complete_seen.sql'])
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
    DB:{prepare,async batch(statements:{run:()=>Promise<unknown>}[]){return Promise.all(statements.map(s=>s.run()));}},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
    READONLY_TARGET:{fetch:async(input:Request|string|URL,init?:RequestInit)=>readonlyWorker.fetch(new Request(input,init))},
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
  const admitted=await admit([
    {id:'a',uses:'result.emit',with:{data:null}},
    {id:'z',uses:'s1.readonly_mcp',with:{tool:'echo',arguments:{value:'other output'}}},
  ]);
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

test('status exposes running delayed fixture, waiting dependency and retained terminal Steps from the pinned Plan',async t=>{
  const {service,admit,run,env}=setup(t);
  const entered=deferred(),release=deferred();
  const fetchFixture=env.READONLY_TARGET.fetch.bind(env.READONLY_TARGET);
  env.READONLY_TARGET.fetch=(async(...args:Parameters<typeof fetchFixture>)=>{
    entered.resolve();await release.promise;return fetchFixture(...args);
  }) as typeof env.READONLY_TARGET.fetch;
  const admitted=await admit([
    {id:'slow',uses:'s1.readonly_mcp',with:{tool:'echo',arguments:{value:'delayed',delay_ms:1}}},
    {id:'dependent',uses:'result.emit',needs:['slow'],with:{data:{ref:'steps.slow.output'}}},
    {id:'skipped',uses:'result.emit',if:false,with:{data:'unused'}},
  ]);
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
  const {service,admit,run,env,sqlite}=setup(t);
  const entered=deferred(),release=deferred();
  const fetchFixture=env.READONLY_TARGET.fetch.bind(env.READONLY_TARGET);
  env.READONLY_TARGET.fetch=(async(...args:Parameters<typeof fetchFixture>)=>{
    entered.resolve();await release.promise;return fetchFixture(...args);
  }) as typeof env.READONLY_TARGET.fetch;
  const admitted=await admit([{id:'read',uses:'s1.readonly_mcp',with:{tool:'echo',arguments:{value:'stable'}}}]);
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
  let privateFixtureCalls=0;
  const originalFetch=env.READONLY_TARGET.fetch.bind(env.READONLY_TARGET);
  env.READONLY_TARGET.fetch=(async(...args:Parameters<typeof originalFetch>)=>{
    privateFixtureCalls++;
    return originalFetch(...args);
  }) as typeof env.READONLY_TARGET.fetch;
  await run(admitted.run_id);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps[0].status,'failed');
  assert.equal(privateFixtureCalls,0);
});

test('S2 Publish requires explicit matching read approval and is disabled by default',async t=>{
  const {service,env,sqlite}=setup(t);
  const steps=[{id:'read',uses:'mcp.call',with:{
    endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',
    input_schema:PINNED_SCHEMA,arguments:{value:'hello'},
  }}];
  const plan=JSON.stringify({version:1,name:'S2 approval gate',steps});
  const created=await service.create(plan);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  await assert.rejects(()=>service.publish(created.workflow_id,1,[grant]),/s2_disabled/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
  env.S2_READONLY_ENABLED='true';
  await assert.rejects(()=>service.publish(created.workflow_id,1),/external_approval_required/);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[{...grant,tool:'other'}]),/external_approval_required/);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[grant,grant]),/external_approval_required/);
  await assert.rejects(()=>service.publish(created.workflow_id,1,[grant]),/target_risk_acknowledgment_required/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
  const published=await service.publish(created.workflow_id,1,[grant],true);
  const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(published.published_version_id) as {plan:string};
  assert.deepEqual(JSON.parse(saved.plan).s2_approvals,[grant]);
  assert.equal(JSON.parse(saved.plan).s2_target_risks_accepted,true);
});

test('S2 previously approved Run fails closed if rollout flag is turned off',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'test'}}}],{},[grant]);
  env.S2_READONLY_ENABLED=undefined;
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

test('S2 approved read-only MCP tool invokes actual SDK only through scoped public fetch',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'hello',url:'https://example.org/opaque'},
  }}],{},[grant]);
  // The existing S1 echo fixture rejects extra args: this must prove the
  // transport was reached without falsely marking an invalid tool call safe.
  const originalFetch=globalThis.fetch;
  let networkCalls=0,privateCalls=0,secretSeen=false;
  const privateFetch=env.READONLY_TARGET.fetch.bind(env.READONLY_TARGET);
  env.READONLY_TARGET.fetch=(async(...args:Parameters<typeof privateFetch>)=>{
    privateCalls++;return privateFetch(...args);
  }) as typeof env.READONLY_TARGET.fetch;
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
  assert.equal(privateCalls,0);
  assert.equal(secretSeen,false);
});

test('approved S2 public read-only call succeeds without touching private S1 binding',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,arguments:{value:'hello S2'}}}],{},[grant]);
  let publicCalls=0,privateCalls=0;
  const originalPrivate=env.READONLY_TARGET.fetch.bind(env.READONLY_TARGET);
  env.READONLY_TARGET.fetch=(async(...args:Parameters<typeof originalPrivate>)=>{
    privateCalls++;return originalPrivate(...args);
  }) as typeof env.READONLY_TARGET.fetch;
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
  assert.ok(JSON.stringify(result.result).includes('hello S2'));
  assert.ok(publicCalls>0);
  assert.equal(privateCalls,0);
});

test('tampering immutable S2 approval cannot dispatch to a changed endpoint',async t=>{
  const {env,admit,run,service,sqlite}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
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
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
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

test('S2 workflow_validate exposes exact schema-bound approval for owner review',async t=>{
  const {service,env}=setup(t);
  const created=await service.create(JSON.stringify({version:1,name:'Schema approval',steps:[{
    id:'read',uses:'mcp.call',with:{
      endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',
      input_schema:PINNED_SCHEMA,arguments:{value:'hello'},
    },
  }]}));
  const validation=await service.validate(created.workflow_id,1);
  assert.equal(validation.valid,true);
  if(!('required_approvals' in validation))throw Error('expected approval preview');
  assert.deepEqual(validation.required_approvals,[{
    endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',
    schema_digest:PINNED_DIGEST,
  }]);
  env.S2_READONLY_ENABLED='true';
  await assert.rejects(()=>service.publish(created.workflow_id,1,[{
    endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',
    schema_digest:'0'.repeat(64),
  }]),/external_approval_required/);
});

test('S2 remote inputSchema drift prevents tools/call, even when target and tool still match',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
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

test('S2 tampered published expected schema fails before network dispatch',async t=>{
  const {env,admit,run,service,sqlite}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
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

test('S2 remote outputSchema change prevents tools/call before dispatch',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
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

test('S2 lost tools/call response is indeterminate, never a confirmed failure or blind retry',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
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

test('S2 older Published Plan without trusted-target risk acknowledgment is blocked before network',async t=>{
  const {env,admit,run,service,sqlite}=setup(t);
  env.S2_READONLY_ENABLED='true';
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  const admitted=await admit([{id:'lookup',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:'read',
    input_schema:PINNED_SCHEMA,arguments:{value:'must never dispatch'},
  }}],{},[grant]);
  const version=sqlite.prepare('SELECT version_id FROM runs WHERE id=?').get(admitted.run_id) as {version_id:string};
  const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(version.version_id) as {plan:string};
  const oldPlan=JSON.parse(saved.plan);
  delete oldPlan.s2_target_risks_accepted;
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

test('S2 unresolved Run-input reference is rejected before any trusted-target request',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
  const admitted=await admit([{id:'read',uses:'mcp.call',with:{
    endpoint:grant.endpoint,tool:grant.tool,scope:'read',input_schema:PINNED_SCHEMA,
    // delay_ms is optional in the declared MCP schema. Silently dropping this
    // missing reference could turn the owner's intended call into a different
    // legitimate target operation, so block it before initialize/tools/list.
    arguments:{value:'safe',delay_ms:{ref:'inputs.delay_ms'}},
  }}],{},[grant]);
  let networkRequests=0;
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(async()=>{networkRequests++;throw Error('unexpected_s2_network');}) as typeof fetch;
  try{await run(admitted.run_id);}finally{globalThis.fetch=previousFetch;}
  const outcome=await service.result(admitted.run_id);
  assert.equal(outcome.status,'failed');
  assert.equal(outcome.steps[0].status,'failed');
  assert.equal(networkRequests,0);
});

test('S2 stateful MCP DELETE cannot delay an already successful tools/call result',async t=>{
  const {env,admit,run,service}=setup(t);
  const grant:ReadonlyOperation={endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',schema_digest:PINNED_DIGEST};
  env.S2_READONLY_ENABLED='true';
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
