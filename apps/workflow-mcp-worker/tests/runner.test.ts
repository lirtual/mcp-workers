import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import {handleWaitEvent} from '../src/wait-event-ingress.ts';
import { WorkflowService, type Env } from '../src/store.ts';
import {awaitedChildRunId,transferAwaitedChildCapacity,startReservedAwaitedChild} from '../src/child-capacity.ts';
import { compilePlan,toolSchemaDigest, type ReadonlyOperation } from '../src/plan.ts';
// Exact schema returned by the existing read-only echo MCP fixture.
const PINNED_SCHEMA={type:'object',properties:{
  value:{type:'string',maxLength:4096},
  delay_ms:{type:'integer',minimum:0,maximum:15000},
},required:['value'],'$schema':'https://json-schema.org/draft/2020-12/schema',additionalProperties:false};
const PINNED_DIGEST=await toolSchemaDigest(PINNED_SCHEMA);
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { success } from '../src/tools.ts';
import readonlyWorker from './fixtures/readonly-worker.ts';
import {McpServer,createMcpHandler} from '@modelcontextprotocol/server';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {z} from 'zod';
import {reviewedWriteTool} from '../src/mcp-write-contract.ts';
import {listAvailableGitHubActions} from '../src/github-action-catalog.ts';
import {parseGitHubAction} from '../src/github-action-contract.ts';
import {reviewedGitHubAction} from '../src/github-action-review.ts';
import {generateKeyPair,SignJWT} from 'jose';
import {verifyAndClaimPinnedGitHubAction} from '../src/github-action-oidc-claim.ts';
import {recordSignedGitHubActionTaskResult} from '../src/github-action-task.ts';

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
  for(const file of ['0001_s1.sql','0014_workflow_deletion.sql','0016_portal_connection_revocation.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0011_awaited_child_capacity.sql','0012_event_wait_receipts.sql'])
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
    DB:{prepare,async batch(statements:{run:()=>Promise<unknown>}[]){
      sqlite.exec('BEGIN IMMEDIATE');
      try{const results=[];for(const stmt of statements)results.push(await stmt.run());sqlite.exec('COMMIT');return results;}
      catch(e){sqlite.exec('ROLLBACK');throw e;}
    }},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  const service=new WorkflowService(env);
  async function admit(steps:unknown[],inputs:Record<string,unknown>={},approvals:ReadonlyOperation[]=[]){
    const w=await service.create(JSON.stringify({version:1,name:'Review regression',steps}));
    await service.publish(w.workflow_id,1,approvals,approvals.length>0);
    return service.start(w.workflow_id,inputs);
  }
  async function run(run_id:string,onStep?:(name:string,options:unknown)=>void){
    await new WorkflowOrchestrator({} as ExecutionContext,env).run({payload:{run_id}} as WorkflowEvent<{run_id:string}>,
      {do:async(name:string,options:unknown,callback:()=>Promise<unknown>)=>{
        onStep?.(name,options);return callback();
      }} as unknown as WorkflowStep);
  }
  return {service,admit,run,env,sqlite};
}

test('native durable wait holds the Step and blocks dependent effects until resume',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const entered=deferred(),release=deferred();
  const started=await admit([
    {id:'hold',flow:'wait',duration_seconds:2},
    {id:'done',uses:'result.emit',needs:['hold'],with:{data:'resumed'}},
  ]);
  let nativeCalls=0;
  const execute=new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_name:unknown,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
      sleep:async(name:string,duration:number)=>{
        nativeCalls++;
        assert.equal(name,'workflow-hold-wait');
        assert.equal(duration,2000);
        entered.resolve();await release.promise;
      }} as unknown as WorkflowStep);
  try{
    await entered.promise;
    const status=await service.status(started.run_id);
    assert.deepEqual(status.steps.map(s=>[s.step_id,s.status]),[
      ['done','waiting'],['hold','waiting'],
    ]);
    assert.equal(sqlite.prepare("SELECT outcome FROM runs WHERE id=?").get(started.run_id)?.outcome,'running');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM run_steps WHERE run_id=? AND step_id='done'")
      .get(started.run_id)?.n,0);
  }finally{release.resolve();await execute;}
  assert.equal(nativeCalls,1);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.result,'resumed');
  assert.equal(result.steps.find(s=>s.step_id==='hold')?.status,'succeeded');
});

test('durable wait does not authorize successors if owner becomes nonrunning during sleep',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const started=await admit([
    {id:'hold',flow:'wait',duration_seconds:1},
    {id:'effect',uses:'result.emit',needs:['hold'],with:{data:'must-not-emit'}},
  ]);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_name:unknown,_opt:unknown,cb:()=>Promise<unknown>)=>cb(),
      sleep:async()=>{
        sqlite.prepare("UPDATE runs SET outcome='cancelled' WHERE id=?").run(started.run_id);
      }} as unknown as WorkflowStep);
  assert.equal(sqlite.prepare("SELECT outcome FROM runs WHERE id=?").get(started.run_id)?.outcome,'cancelled');
  assert.equal(sqlite.prepare("SELECT status FROM run_steps WHERE run_id=? AND step_id='hold'")
    .get(started.run_id)?.status,'indeterminate');
  assert.equal(sqlite.prepare("SELECT status FROM run_steps WHERE run_id=? AND step_id='effect'")
    .get(started.run_id)?.status,'skipped');
});

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

test('revoke and enable cannot revive a prior MCP Published Plan or dispatch tools/call',async t=>{
  const {env,admit,run,service}=setup(t);
  const started=await admit([echoStep('read',{value:'blocked'})],{},[ECHO_GRANT]);
  assert.deepEqual(await service.portalConnectionRevoke(),{state:'revoked',generation:1});
  assert.deepEqual(await service.portalConnectionEnable(),{state:'enabled',generation:1});
  let called=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(request.method==='POST'&&(await request.clone().json() as {method?:string}).method==='tools/call')called++;
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  try{await run(started.run_id);}finally{globalThis.fetch=previous;}
  assert.equal(called,0);
  const outcome=await service.result(started.run_id);
  assert.equal(outcome.status,'failed');
  assert.equal(outcome.steps[0].status,'failed');
  assert.equal(outcome.steps[0].error_code,'portal_connection_revoked');
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
  if(!('required_approvals' in validation))throw Error('MCP template grant was omitted');
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


test('foreach MCP validates every frozen argument before the first external effect',async t=>{
  const {service,admit,run}=setup(t);
  const admitted=await admit([readForeach({value:{ref:'item.value.name'}})],
    {items:[{name:'valid'},null]},[ECHO_GRANT]);
  let calls=0;
  mockPublicPeer(t,async()=>{calls++;});
  await run(admitted.run_id);
  const result=await service.result(admitted.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps.find(x=>x.step_id==='each')?.error_code,'invalid_foreach_items');
  assert.equal(calls,0,'no partial array effects before complete snapshot validation');
});

test('foreach MCP cached native snapshot and child checkpoint retain original arguments',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const admitted=await admit([readForeach()],{items:['pinned']},[ECHO_GRANT]);
  let calls=0;
  mockPublicPeer(t,async()=>{calls++;});
  const cached=new Map<string,unknown>();
  const native={do:async(name:string,_options:unknown,cb:()=>Promise<unknown>)=>{
    if(cached.has(name))return cached.get(name);
    const output=await cb();
    cached.set(name,output);
    return output;
  }} as unknown as WorkflowStep;
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,native);
  assert.equal(calls,1);
  const first=await service.result(admitted.run_id);
  assert.equal(first.status,'succeeded');
  sqlite.prepare("UPDATE runs SET outcome='running',inputs=?,result=NULL WHERE id=?")
    .run(JSON.stringify({items:['different','extra']}),admitted.run_id);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,native);
  const replay=await service.result(admitted.run_id);
  assert.equal(replay.status,'succeeded');
  assert.deepEqual(replay.result,first.result);
  assert.equal(calls,1);
  assert.equal(cached.has('workflow-each_1_read'),false);
});

test('GitHub Task foreach routes each child through physical Attempt; first failure stops later dispatch',async t=>{
 const {service,admit,run,env,sqlite}=setup(t);
 // Only this test needs the existing approved github.action schema migration.
 sqlite.exec('BEGIN');
 sqlite.exec(readFileSync(new URL('../migrations/0006_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 sqlite.exec('COMMIT');
 sqlite.exec(readFileSync(new URL('../migrations/0007_session_executions.sql',import.meta.url),'utf8'));
 const start=await admit([{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
  template:{steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'item.value'}}}]}}],
 {items:['A','B']});
 const identity={repository:'lirtual/session-actions',repositoryId:123,
  workflowId:456,workflowPath:'.github/workflows/task.yml',
  commitSha:'a'.repeat(40),contractDigest:'b'.repeat(64),type:'task' as const};
 const tag='refs/tags/task-v1';
 const {plan}=await compilePlan({version:1,name:'Pinned per-item Task',
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[{id:'task',uses:'github.run',with:{
     capability:'github.action',action:{...identity,ref:tag,inputs:{outcome:'failure'}},
   }}]}}]});
 plan.github_execution_approved=true;
 plan.github_action_approvals=[identity];
 sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=(SELECT version_id FROM runs WHERE id=?)')
   .run(JSON.stringify(plan),start.run_id);
 env.WORKFLOW_GITHUB_DISPATCH_TOKEN='test-token';
 env.GITHUB_ACTION_OIDC_AUDIENCE='workflow-github-action:production';
 let calls=0;
 const old=globalThis.fetch;
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const req=new Request(input,init),url=new URL(req.url);
  if(url.pathname.endsWith('/git/ref/tags/task-v1'))
   return Response.json({ref:tag,object:{type:'commit',sha:identity.commitSha}});
  if(req.method==='POST'){calls++;return Response.json({workflow_run_id:42});}
  assert.ok(url.pathname.endsWith('/actions/runs/42'));
  return Response.json({id:42,workflow_id:456,run_attempt:1,
   repository:{id:123,full_name:identity.repository},path:identity.workflowPath,
   head_branch:'task-v1',head_sha:identity.commitSha,event:'workflow_dispatch',
   status:'completed',conclusion:'failure'});
 }) as typeof fetch;
 t.after(()=>{globalThis.fetch=old;});
 await run(start.run_id);
 const result=await service.result(start.run_id);
 assert.equal(result.status,'failed');
 assert.equal(result.steps.find(s=>s.step_id==='each_0_task')?.status,'failed',JSON.stringify(result));
 assert.equal(result.steps.find(s=>s.step_id==='each')?.status,'failed');
 assert.equal(calls,1,'failed first Task must not start later dynamic Task');
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,1);
});

test('pure multi-step foreach runs ordered item-local Steps with visible D1 status',async t=>{
  const {service,admit,env}=setup(t);
  const admitted=await admit([
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:3,
      template:{steps:[
        {id:'prepare',uses:'result.emit',with:{data:{
          value:{ref:'item.value'},position:{ref:'item.index'}}}},
        {id:'finish',uses:'result.emit',
          if:{eq:[{ref:'item.value'},'A']},
          with:{data:{value:{ref:'steps.prepare.output.value'},
            position:{ref:'steps.prepare.output.position'}}}},
      ]}},
    {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
  ],{items:['A','B']});
  const checkpoints:string[]=[];
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:admitted.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{
      checkpoints.push(name);return callback();
    }} as unknown as WorkflowStep);
  const output=await service.result(admitted.run_id);
  assert.equal(output.status,'succeeded');
  assert.deepEqual(output.result,[{value:'A',position:0},null]);
  assert.deepEqual(checkpoints,[
    'workflow-each-snapshot','workflow-each_0_prepare','workflow-each_0_finish',
    'workflow-each_1_prepare','workflow-each_1_finish','workflow-done',
  ]);
  for(const [id,status] of [
    ['each_0_prepare','succeeded'],['each_0_finish','succeeded'],
    ['each_1_prepare','succeeded'],['each_1_finish','skipped'],
  ])assert.equal(output.steps.find(s=>s.step_id===id)?.status,status);
});

test('pure multi-step native snapshots replay unchanged when Run inputs are altered',async t=>{
  const {service,admit,env,sqlite}=setup(t);
  const started=await admit([{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
    template:{steps:[
      {id:'one',uses:'result.emit',with:{data:{ref:'item.value'}}},
      {id:'two',uses:'result.emit',with:{data:{ref:'steps.one.output'}}},
    ]}}],{items:['original']});
  const cache=new Map<string,unknown>();
  const counts=new Map<string,number>();
  const native={do:async(name:string,_opts:unknown,fn:()=>Promise<unknown>)=>{
    if(cache.has(name))return cache.get(name);
    counts.set(name,(counts.get(name)??0)+1);
    const result=await fn();cache.set(name,result);return result;
  }} as unknown as WorkflowStep;
  const event={payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>;
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(event,native);
  assert.deepEqual((await service.result(started.run_id)).result,['original']);
  sqlite.prepare("UPDATE runs SET outcome='running',inputs=?,result=NULL WHERE id=?")
    .run(JSON.stringify({items:['tampered','second']}),started.run_id);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(event,native);
  const replay=await service.result(started.run_id);
  assert.equal(replay.status,'succeeded');
  assert.deepEqual(replay.result,['original']);
  assert.equal(counts.get('workflow-each-snapshot'),1);
  assert.equal(counts.get('workflow-each_0_one'),1);
  assert.equal(counts.get('workflow-each_0_two'),1);
  assert.equal(cache.has('workflow-each_1_one'),false);
});

test('pure multi-step foreach overflow fails before executing any child',async t=>{
  const {service,admit,env}=setup(t);
  const started=await admit([{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
    template:{steps:[
      {id:'one',uses:'result.emit',with:{data:{ref:'item.value'}}},
      {id:'two',uses:'result.emit',with:{data:{ref:'steps.one.output'}}},
    ]}}],{items:[1,2,3]});
  const checkpoints:string[]=[];
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(name:string,_options:unknown,fn:()=>Promise<unknown>)=>{
      checkpoints.push(name);return fn();
    }} as unknown as WorkflowStep);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'failed');
  assert.deepEqual(checkpoints,['workflow-each-snapshot']);
  assert.equal(result.steps.filter(s=>s.step_id.startsWith('each_')).length,0);
});

test('late invalid dynamic Task choice is rejected before any per-item GitHub dispatch',async t=>{
 const {service,admit,env,sqlite,run}=setup(t);
 const start=await admit([{id:'seed',uses:'result.emit',with:{data:'seed'}}],
  {items:['success','invalid']});
 const contract={name:'Pinned Task',type:'task' as const,inputs:{
  outcome:{type:'choice' as const,required:true,options:['success','failure'],default:'success'},
 }};
 const identity={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
  workflowPath:'.github/workflows/task.yml',commitSha:'a'.repeat(40)};
 const approved=await reviewedGitHubAction({...identity,contract});
 const {plan}=await compilePlan({version:1,name:'dynamic typed Task',steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[{id:'task',uses:'github.run',with:{
    capability:'github.action',action:{...approved,ref:'refs/tags/task-v1',
     inputs:{outcome:{ref:'item.value'}}},
   }}]}}]});
 plan.github_execution_approved=true;
 plan.github_action_approvals=[approved];
 plan.github_dynamic_input_contracts={each:contract};
 sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=(SELECT version_id FROM runs WHERE id=?)')
  .run(JSON.stringify(plan),start.run_id);
 env.WORKFLOW_GITHUB_DISPATCH_TOKEN='test-token';
 env.GITHUB_ACTION_OIDC_AUDIENCE='workflow-github-action:production';
 let posts=0;
 const before=globalThis.fetch;
 globalThis.fetch=(async()=>{posts++;throw Error('must not dispatch');}) as typeof fetch;
 t.after(()=>{globalThis.fetch=before;});
 await run(start.run_id);
 const result=await service.result(start.run_id);
 assert.equal(result.status,'failed');
 assert.equal(result.steps.find(x=>x.step_id==='each')?.error_code,'invalid_foreach_items');
 assert.equal(result.steps.some(x=>x.step_id.startsWith('each_')),false);
 assert.equal(posts,0);
});

test('valid reviewed item-typed Task reaches one dispatch checkpoint after bounded snapshot',async t=>{
 const {service,admit,env,sqlite}=setup(t);
 const start=await admit([{id:'seed',uses:'result.emit',with:{data:'seed'}}],
  {items:['success','success']});
 const contract={name:'Verify Workflow Action',type:'task' as const,inputs:{
  outcome:{type:'choice' as const,required:true,
   description:'Verify the real GitHub task success or failure path',
   options:['success','failure'],default:'success'},
 }};
 const base={repository:'lirtual/session-actions',repositoryId:1430925009,
  workflowId:394689660,workflowPath:'.github/workflows/verify-action.yml',
  commitSha:'3b8114a3e478b8acb28ab2f3c404284c33096bcf'};
 const approved=await reviewedGitHubAction({...base,contract});
 const {plan}=await compilePlan({version:1,name:'Positive pinned Task',
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[{id:'task',uses:'github.run',with:{
    capability:'github.action',action:{...approved,ref:'refs/tags/v0.1.25',
     inputs:{outcome:{ref:'item.value'}}},
   }}]}}]});
 plan.github_execution_approved=true;plan.github_action_approvals=[approved];
 plan.github_dynamic_input_contracts={each:contract};
 sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=(SELECT version_id FROM runs WHERE id=?)')
  .run(JSON.stringify(plan),start.run_id);
 env.WORKFLOW_GITHUB_DISPATCH_TOKEN='test-token';
 env.GITHUB_ACTION_OIDC_AUDIENCE='workflow-github-action:production';
 const checkpoints:string[]=[];
 await new WorkflowOrchestrator({} as ExecutionContext,env).run(
  {payload:{run_id:start.run_id}} as WorkflowEvent<{run_id:string}>,
  {do:async(name:string,_options:unknown,callback:()=>Promise<unknown>)=>{
   checkpoints.push(name);
   if(name.startsWith('github-action-dispatch-'))
    return {attemptId:'synthetic-test-only',status:'rejected'};
   try{
    const result=await callback();
    if(name==='workflow-each-snapshot'){
      const snapshot=result as {items:Array<{output:unknown}>};
      assert.equal(Object.getPrototypeOf(snapshot.items[0]!.output),Object.prototype,
        'native checkpoint payload must use a plain JSON record');
      assert.deepEqual(snapshot.items.map(entry=>entry.output),[
        {outcome:'success'},{outcome:'success'}]);
    }
    return result;
   }catch(error){
    throw Error('checkpoint '+name+': '+String(error));
   }
  }} as unknown as WorkflowStep);
 const result=await service.result(start.run_id);
 assert.ok(checkpoints.includes('github-action-dispatch-each_0_task'),
  'Valid typed snapshot should reach the external dispatch boundary: '+JSON.stringify({checkpoints,result}));
 assert.equal(result.steps.find(s=>s.step_id==='each_0_task')?.status,'failed');
 assert.equal(result.steps.find(s=>s.step_id==='each_1_task'),undefined);
});

test('mixed Foreach stages use per-item prior output and one D1 fence per reviewed MCP call',async t=>{
 const {admit,service,env}=setup(t);
 let calls=0;
 mockPublicPeer(t,async()=>{calls++;});
 const approvedWith={endpoint:ECHO_GRANT.endpoint,tool:ECHO_GRANT.tool,scope:'read',
   input_schema:PINNED_SCHEMA,arguments:{value:{ref:'steps.prepare.output'}}};
 const start=await admit([
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:3,
   template:{steps:[
    {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
    {id:'read',uses:'mcp.call',with:approvedWith},
    {id:'finish',uses:'result.emit',with:{data:{ref:'steps.read.output'}}},
   ]}},
  {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
 ],{items:['red','blue']},[ECHO_GRANT]);
 const names:string[]=[];
 await new WorkflowOrchestrator({} as ExecutionContext,env).run(
   {payload:{run_id:start.run_id}} as WorkflowEvent<{run_id:string}>,
   {do:async(name:string,_options:unknown,fn:()=>Promise<unknown>)=>{
     names.push(name);return fn();
   }} as unknown as WorkflowStep);
 const result=await service.result(start.run_id);
 assert.equal(result.status,'succeeded',JSON.stringify(result));
 assert.equal(calls,2);
 assert.equal(result.steps.length,8);
 for(const id of ['each_0_prepare','each_0_read','each_0_finish',
   'each_1_prepare','each_1_read','each_1_finish'])
   assert.equal(result.steps.find(s=>s.step_id===id)?.status,'succeeded',id);
 assert.ok(names.indexOf('workflow-each_0_read-args')<
   names.indexOf('workflow-each_0_read'));
 assert.ok(names.indexOf('workflow-each_1_prepare')<
   names.indexOf('workflow-each_1_read-args'));
 assert.equal((result.result as Array<{content:unknown[]}>).length,2);
});

test('mixed Foreach MCP stage uncertainty stops later calls and never blindly retries after lost checkpoint',async t=>{
 const {admit,service,env,sqlite}=setup(t);
 const mcpArgs={endpoint:ECHO_GRANT.endpoint,tool:ECHO_GRANT.tool,scope:'read',
  input_schema:PINNED_SCHEMA,arguments:{value:{ref:'item.value'}}};
 const start=await admit([{id:'each',flow:'foreach',items:{ref:'inputs.items'},
  max_items:2,template:{steps:[
   {id:'first',uses:'mcp.call',with:mcpArgs},
   {id:'second',uses:'mcp.call',with:mcpArgs},
   {id:'finish',uses:'result.emit',with:{data:{ref:'steps.second.output'}}},
  ]}}],{items:['alpha','beta']},[ECHO_GRANT]);
 let calls=0;
 mockPublicPeer(t,async()=>{calls++;});
 const seen=new Map<string,unknown>();
 let lost=false;
 const native={do:async(name:string,_options:unknown,cb:()=>Promise<unknown>)=>{
   if(seen.has(name))return seen.get(name);
   const value=await cb();
   if(name==='workflow-each_0_first'&&!lost){
     lost=true;throw Error('lost remote MCP checkpoint after tools/call');
   }
   seen.set(name,value);
   return value;
 }} as unknown as WorkflowStep;
 const event={payload:{run_id:start.run_id}} as WorkflowEvent<{run_id:string}>;
 await new WorkflowOrchestrator({} as ExecutionContext,env).run(event,native);
 const first=await service.result(start.run_id);
 assert.equal(first.status,'indeterminate',JSON.stringify(first));
 assert.equal(calls,1,'one external read, not two');
 assert.equal(first.steps.find(s=>s.step_id==='each_0_second'),undefined);
 sqlite.prepare("UPDATE runs SET outcome='running',inputs=?,result=NULL WHERE id=?")
  .run(JSON.stringify({items:['changed','new']}),start.run_id);
 await new WorkflowOrchestrator({} as ExecutionContext,env).run(event,native);
 assert.equal(calls,1,'repeat callback may not dispatch an already-fenced MCP call');
 assert.equal((await service.result(start.run_id)).status,'indeterminate');
});

test('mixed Foreach rejected MCP arguments stop before external effects',async t=>{
 const {admit,service,run}=setup(t);
 const mcpArgs={endpoint:ECHO_GRANT.endpoint,tool:ECHO_GRANT.tool,scope:'read',
  input_schema:PINNED_SCHEMA,arguments:{value:{ref:'steps.prepare.output.name'}}};
 const start=await admit([{id:'each',flow:'foreach',items:{ref:'inputs.items'},
  max_items:2,template:{steps:[
   {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
   {id:'read',uses:'mcp.call',with:mcpArgs},
   {id:'finish',uses:'result.emit',with:{data:'should not run'}},
  ]}}],{items:[null,'safe']},[ECHO_GRANT]);
 let calls=0;
 mockPublicPeer(t,async()=>{calls++;});
 await run(start.run_id);
 const result=await service.result(start.run_id);
 assert.equal(result.status,'failed');
 assert.equal(calls,0);
 assert.equal(result.steps.find(s=>s.step_id==='each_0_finish'),undefined);
 assert.equal(result.steps.find(s=>s.step_id==='each_1_prepare'),undefined);
});

test('emit → Task → emit: physical Task failure halts item pipeline and next item',async t=>{
 const {service,admit,run,env,sqlite}=setup(t);
 sqlite.exec('BEGIN');
 sqlite.exec(readFileSync(new URL('../migrations/0006_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 sqlite.exec('COMMIT');
 sqlite.exec(readFileSync(new URL('../migrations/0007_session_executions.sql',import.meta.url),'utf8'));
 const started=await admit([{id:'seed',uses:'result.emit',with:{data:'seed'}}],
  {items:['one','two']});
 const identity={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
   workflowPath:'.github/workflows/task.yml',commitSha:'a'.repeat(40),
   contractDigest:'b'.repeat(64),type:'task' as const};
 const {plan}=await compilePlan({version:1,name:'Three-stage failure guard',steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[
    {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
    {id:'verify',uses:'github.run',
      if:{ne:[{ref:'steps.prepare.output'},'skip']},
      with:{capability:'github.action',action:{...identity,ref:'refs/tags/task-v1',
        inputs:{outcome:'failure'}}}},
    {id:'finish',uses:'result.emit',with:{data:{ref:'steps.verify.output'}}},
   ]}},
 ]});
 plan.github_execution_approved=true;plan.github_action_approvals=[identity];
 sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=(SELECT version_id FROM runs WHERE id=?)')
  .run(JSON.stringify(plan),started.run_id);
 env.WORKFLOW_GITHUB_DISPATCH_TOKEN='test-token';
 env.GITHUB_ACTION_OIDC_AUDIENCE='workflow-github-action:production';
 let posts=0;
 const savedFetch=globalThis.fetch;
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const req=new Request(input,init),u=new URL(req.url);
  if(u.pathname.endsWith('/git/ref/tags/task-v1'))
   return Response.json({ref:'refs/tags/task-v1',object:{type:'commit',sha:identity.commitSha}});
  if(req.method==='POST'){posts++;return Response.json({workflow_run_id:42});}
  assert.ok(u.pathname.endsWith('/actions/runs/42'),u.pathname);
  return Response.json({id:42,workflow_id:identity.workflowId,run_attempt:1,
   repository:{id:identity.repositoryId,full_name:identity.repository},
   path:identity.workflowPath,head_branch:'task-v1',head_sha:identity.commitSha,
   event:'workflow_dispatch',status:'completed',conclusion:'failure'});
 }) as typeof fetch;
 t.after(()=>{globalThis.fetch=savedFetch;});
 await run(started.run_id);
 const result=await service.result(started.run_id);
 assert.equal(result.status,'failed',JSON.stringify(result));
 assert.equal(result.steps.find(s=>s.step_id==='each_0_prepare')?.status,'succeeded');
 assert.equal(result.steps.find(s=>s.step_id==='each_0_verify')?.status,'failed');
 assert.equal(result.steps.find(s=>s.step_id==='each_0_finish'),undefined);
 assert.equal(result.steps.find(s=>s.step_id==='each_1_prepare'),undefined);
 assert.equal(posts,1,'definitive first Task failure must halt later dispatch');
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,1);
});

test('emit → conditional Task → emit skips all external work and follow-up on false condition',async t=>{
 const {service,admit,env,sqlite,run}=setup(t);
 const started=await admit([{id:'seed',uses:'result.emit',with:{data:'seed'}}],{items:['skip']});
 const identity={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
  workflowPath:'.github/workflows/task.yml',commitSha:'a'.repeat(40),
  contractDigest:'b'.repeat(64),type:'task' as const};
 const {plan}=await compilePlan({version:1,name:'Skipped physical Task',steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[
    {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
    {id:'verify',uses:'github.run',if:{ne:[{ref:'steps.prepare.output'},'skip']},
     with:{capability:'github.action',action:{...identity,ref:'refs/tags/task-v1',
      inputs:{outcome:'success'}}}},
    {id:'finish',uses:'result.emit',with:{data:{ref:'steps.verify.output'}}},
   ]}},
 ]});
 plan.github_execution_approved=true;plan.github_action_approvals=[identity];
 sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=(SELECT version_id FROM runs WHERE id=?)')
  .run(JSON.stringify(plan),started.run_id);
 let calls=0;const before=globalThis.fetch;
 globalThis.fetch=(async()=>{calls++;throw Error('unexpected GitHub access');}) as typeof fetch;
 t.after(()=>{globalThis.fetch=before;});
 await run(started.run_id);
 const result=await service.result(started.run_id);
 assert.equal(result.status,'succeeded',JSON.stringify(result));
 assert.equal(result.steps.find(s=>s.step_id==='each_0_prepare')?.status,'succeeded');
 assert.equal(result.steps.find(s=>s.step_id==='each_0_verify')?.status,'skipped');
 assert.equal(result.steps.find(s=>s.step_id==='each_0_finish')?.status,'skipped');
 assert.equal(calls,0);
});

test('mixed MCP reads and two staged Tasks deliver signed OIDC receipts in strict sequence',async t=>{
 const {admit,service,env,sqlite}=setup(t);
 sqlite.exec('BEGIN');
 sqlite.exec(readFileSync(new URL('../migrations/0006_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 sqlite.exec('COMMIT');
 sqlite.exec(readFileSync(new URL('../migrations/0007_session_executions.sql',import.meta.url),'utf8'));
 const started=await admit([{id:'seed',uses:'result.emit',with:{data:'seed'}}],
   {items:['first','second']});
 const identity={repository:'lirtual/session-actions',repositoryId:123,
  workflowId:456,workflowPath:'.github/workflows/task.yml',
  commitSha:'a'.repeat(40),contractDigest:'b'.repeat(64),type:'task' as const};
 const tag='refs/tags/task-v1',audience='workflow-github-action:production';
 const {plan}=await compilePlan({version:1,name:'Signed ordered Task pipeline',steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[
    {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
    echoStep('read',{value:{ref:'steps.prepare.output'}}),
    {id:'verify',uses:'github.run',with:{capability:'github.action',
     action:{...identity,ref:tag,inputs:{outcome:'success'}}}},
    {id:'finish',uses:'result.emit',with:{data:{ref:'steps.verify.output'}}},
   ]}},
  {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
 ]});
 plan.github_execution_approved=true;plan.github_action_approvals=[identity];
 plan.mcp_target_risks_accepted=true;plan.mcp_approvals=[ECHO_GRANT];
 sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=(SELECT version_id FROM runs WHERE id=?)')
  .run(JSON.stringify(plan),started.run_id);
 env.WORKFLOW_GITHUB_DISPATCH_TOKEN='test-token';
 env.GITHUB_ACTION_OIDC_AUDIENCE=audience;
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const signed=new Map<number,string>();
 let posts=0;let mcpCalls=0;const claimed=new Set<number>();
 const savedFetch=globalThis.fetch;
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const req=new Request(input,init),url=new URL(req.url),path=url.pathname;
  if(url.hostname==='mcp.lirtual.dpdns.org'){
   if(req.method==='POST'){
    const request=await req.clone().json() as {method?:string};
    if(request.method==='tools/call')mcpCalls++;
   }
   return readonlyWorker.fetch(req);
  }
  if(path.endsWith('/git/ref/tags/task-v1'))
   return Response.json({ref:tag,object:{type:'commit',sha:identity.commitSha}});
  if(req.method==='POST'){
   posts++;
   const sent=await req.json() as {ref:string;inputs:Record<string,string>};
   assert.equal(sent.ref,'task-v1');
   assert.deepEqual(sent.inputs.outcome,'success');
   assert.ok(posts<=2,'must dispatch one Task per item');
   return Response.json({workflow_run_id:41+posts});
  }
  const match=path.match(/\/actions\/runs\/(42|43)$/);
  assert.ok(match,'Only pinned physical Task runs may be inspected: '+path);
  const physical=Number(match[1]);
  const stored=sqlite.prepare(
   'SELECT attempt_id,step_id FROM step_attempts WHERE candidate_run_id=?'
  ).get(physical) as {attempt_id:string;step_id:string}|undefined;
  assert.ok(stored,'run must be persisted before physical result');
  assert.equal(stored.step_id,'each_'+(physical-42)+'_verify');
  if(!claimed.has(physical)){
   const jwt=await new SignJWT({
    repository:identity.repository,repository_id:String(identity.repositoryId),
    workflow_ref:identity.repository+'/'+identity.workflowPath+'@'+tag,
    ref:tag,sha:identity.commitSha,run_id:String(physical),run_attempt:'1',
    event_name:'workflow_dispatch',
   }).setProtectedHeader({alg:'RS256'})
     .setIssuer('https://token.actions.githubusercontent.com')
     .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
   signed.set(physical,jwt);
   assert.equal(await verifyAndClaimPinnedGitHubAction(env.DB,stored.attempt_id,
     jwt,audience,publicKey),true);
   assert.equal(await recordSignedGitHubActionTaskResult(env.DB,stored.attempt_id,
     jwt,audience,{verified:true,physical},publicKey),'recorded');
   claimed.add(physical);
  }
  return Response.json({id:physical,workflow_id:identity.workflowId,run_attempt:1,
   repository:{id:identity.repositoryId,full_name:identity.repository},
   path:identity.workflowPath,head_branch:'task-v1',head_sha:identity.commitSha,
   event:'workflow_dispatch',status:'completed',conclusion:'success'});
 }) as typeof fetch;
 t.after(()=>{globalThis.fetch=savedFetch;});
 const checkpoints:string[]=[];
 await new WorkflowOrchestrator({} as ExecutionContext,env).run(
  {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
  {do:async(name:string,_opts:unknown,fn:()=>Promise<unknown>)=>{
    checkpoints.push(name);return fn();
   },sleep:async()=>{}} as unknown as WorkflowStep);
 const result=await service.result(started.run_id);
 assert.equal(result.status,'succeeded',JSON.stringify(result));
 assert.deepEqual(result.result,[{verified:true,physical:42},{verified:true,physical:43}]);
 assert.equal(posts,2);
 assert.equal(mcpCalls,2,'each item must perform one approved read before its Task');
 assert.deepEqual([...claimed],[42,43]);
 assert.equal(sqlite.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,2);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM step_attempts WHERE state='succeeded'").get()?.n,2);
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM callback_receipts WHERE outcome='succeeded'").get()?.n,2);
 for(const id of ['each','each_0_prepare','each_0_read','each_0_verify','each_0_finish',
   'each_1_prepare','each_1_read','each_1_verify','each_1_finish','done'])
  assert.equal(result.steps.find(s=>s.step_id===id)?.status,'succeeded',id);
 for(const i of [0,1]){
  const label='each_'+i+'_';
  assert.ok(checkpoints.indexOf('workflow-'+label+'prepare')<
    checkpoints.indexOf('workflow-'+label+'read-args'));
  assert.ok(checkpoints.indexOf('workflow-'+label+'read')<
    checkpoints.indexOf('github-action-dispatch-'+label+'verify'));
  assert.ok(checkpoints.indexOf('github-action-dispatch-'+label+'verify')<
    checkpoints.indexOf('workflow-'+label+'finish'));
 }
});

test('mixed skipped MCP prerequisite never dispatches a reviewed GitHub Task',async t=>{
 const {admit,service,run,sqlite}=setup(t);
 const started=await admit([{id:'seed',uses:'result.emit',with:{data:'seed'}}],
  {items:['one']});
 const identity={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
  workflowPath:'.github/workflows/task.yml',commitSha:'a'.repeat(40),
  contractDigest:'b'.repeat(64),type:'task' as const};
 const {plan}=await compilePlan({version:1,name:'Blocked mixed external stages',steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[
    {...echoStep('read',{value:'never called'}),if:false},
    {id:'verify',uses:'github.run',with:{capability:'github.action',
      action:{...identity,ref:'refs/tags/task-v1',inputs:{outcome:'success'}}}},
    {id:'finish',uses:'result.emit',with:{data:{ref:'steps.verify.output'}}},
   ]}},
 ]});
 plan.github_execution_approved=true;plan.github_action_approvals=[identity];
 plan.mcp_target_risks_accepted=true;plan.mcp_approvals=[ECHO_GRANT];
 sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=(SELECT version_id FROM runs WHERE id=?)')
  .run(JSON.stringify(plan),started.run_id);
 let calls=0;const before=globalThis.fetch;
 globalThis.fetch=(async()=>{calls++;throw Error('skipped prerequisite reached remote network');}) as typeof fetch;
 t.after(()=>{globalThis.fetch=before;});
 await run(started.run_id);
 const result=await service.result(started.run_id);
 assert.equal(result.status,'succeeded',JSON.stringify(result));
 assert.equal(result.steps.find(s=>s.step_id==='each_0_read')?.status,'skipped');
 assert.equal(result.steps.find(s=>s.step_id==='each_0_verify')?.status,'skipped');
 assert.equal(result.steps.find(s=>s.step_id==='each_0_finish')?.status,'skipped');
 assert.equal(calls,0,'neither MCP nor GitHub may be contacted');
});

test('awaited child publish requires exact reviewed target; one native child and parent output',async t=>{
  const {service,env,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Child only owns its result',
    steps:[{id:'echo',uses:'result.emit',with:{data:{ref:'inputs.value'}}}]}));
  const published=await service.publish(child.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Parent invokes pinned child',
    inputs:{value:null},steps:[
      {id:'delegate',flow:'child',workflow_id:child.workflow_id,
        version_id:published.published_version_id,inputs:{value:{ref:'inputs.value'}}},
      {id:'finished',uses:'result.emit',needs:['delegate'],
        with:{data:{ref:'steps.delegate.output'}}},
    ]}));
  const validated=await service.validateDefinition((await service.get(parent.workflow_id)).definition);
  assert.equal(validated.valid,true);
  const reviewed=(validated as {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>}).required_children!;
  assert.equal(reviewed.length,1);
  await assert.rejects(()=>service.publish(parent.workflow_id,1),/child_approval_required/);
  await service.publish(parent.workflow_id,1,[],false,false,[],reviewed);
  const created:string[]=[];
  const nativeStep={do:async(_name:unknown,_options:unknown,callback:()=>Promise<unknown>)=>callback(),
    sleep:async()=>{}} as unknown as WorkflowStep;
  env.WORKFLOW.create=async({id})=>{
    created.push(id);
    if(id===created[0])return;
    await new WorkflowOrchestrator({} as ExecutionContext,env).run(
      {payload:{run_id:id}} as WorkflowEvent<{run_id:string}>,nativeStep);
  };
  const started=await service.start(parent.workflow_id,{value:'hello from parent'});
  const reserved=sqlite.prepare('SELECT capacity_weight FROM runs WHERE id=?')
    .get(started.run_id) as {capacity_weight:number};
  assert.equal(reserved.capacity_weight,2);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,nativeStep);
  const final=await service.result(started.run_id);
  assert.equal(final.status,'succeeded');
  assert.equal(final.result,'hello from parent');
  assert.equal(created.length,2);
  const rows=sqlite.prepare('SELECT id,parent_run_id,outcome,capacity_weight FROM runs ORDER BY created_at,id')
    .all() as Array<{id:string;parent_run_id:string|null;outcome:string;capacity_weight:number}>;
  assert.equal(rows.length,2);
  assert.equal(rows.filter(x=>x.parent_run_id===started.run_id).length,1);
  assert.equal(rows.every(x=>x.outcome==='succeeded'),true);
  assert.equal(rows.every(x=>x.capacity_weight===1),true);
});

test('detached child completes independently after parent reaches terminal success',async t=>{
  const {service,env,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Detached result',
    steps:[{id:'emit',uses:'result.emit',with:{data:'independent completion'}}]}));
  const childVersion=await service.publish(child.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Detached launch',steps:[
    {id:'launch',flow:'child',mode:'detached',workflow_id:child.workflow_id,
      version_id:childVersion.published_version_id,inputs:{}},
    {id:'result',uses:'result.emit',needs:['launch'],with:{data:{ref:'steps.launch.output'}}},
  ]}));
  const checked=await service.validateDefinition((await service.get(parent.workflow_id)).definition) as
    {valid:boolean;required_children?:Array<{workflow_id:string;version_id:string;digest:string}>};
  assert.equal(checked.valid,true);
  await assert.rejects(()=>service.publish(parent.workflow_id,1),/child_approval_required/);
  await service.publish(parent.workflow_id,1,[],false,false,[],checked.required_children!);
  const native={do:async(_n:unknown,_o:unknown,callback:()=>Promise<unknown>)=>callback(),
    sleep:async()=>{}} as unknown as WorkflowStep;
  const nativeCreated:string[]=[];
  env.WORKFLOW.create=async({id})=>{nativeCreated.push(id);};
  const started=await service.start(parent.workflow_id);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,native);
  const parentResult=await service.result(started.run_id);
  assert.equal(parentResult.status,'succeeded');
  const ref=parentResult.result as {run_id:string;published_version_id:string};
  assert.equal(ref.published_version_id,childVersion.published_version_id);
  assert.equal(nativeCreated.length,2);
  const childRow=sqlite.prepare('SELECT outcome,capacity_weight FROM runs WHERE id=?')
    .get(ref.run_id) as {outcome:string;capacity_weight:number};
  assert.equal(childRow.outcome,'queued');
  assert.equal(childRow.capacity_weight,1);
  assert.equal((sqlite.prepare('SELECT capacity_weight FROM runs WHERE id=?')
    .get(started.run_id) as {capacity_weight:number}).capacity_weight,1);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:ref.run_id}} as WorkflowEvent<{run_id:string}>,native);
  assert.equal((await service.result(ref.run_id)).status,'succeeded');
  assert.equal((await service.result(started.run_id)).status,'succeeded');
  await assert.rejects(()=>service.cancel(started.run_id,'launch'),/child_not_cancellable/);
  assert.equal((await service.result(ref.run_id)).status,'succeeded');
  assert.equal(nativeCreated.length,2,'parent replay must not create another child');
});

test('detached child at capacity limit fails definitely without a native child create',async t=>{
  const {service,env,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Only emit',
    steps:[{id:'emit',uses:'result.emit',with:{data:1}}]}));
  const childPublished=await service.publish(child.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Bounded detached',steps:[
    {id:'launch',flow:'child',mode:'detached',workflow_id:child.workflow_id,
      version_id:childPublished.published_version_id,inputs:{}},
  ]}));
  const check=await service.validateDefinition((await service.get(parent.workflow_id)).definition) as
    {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>};
  await service.publish(parent.workflow_id,1,[],false,false,[],check.required_children!);
  let nativeCreates=0;
  env.WORKFLOW.create=async()=>{nativeCreates++;};
  const started=await service.start(parent.workflow_id);
  const filler=await service.create(JSON.stringify({version:1,name:'Filler',steps:[
    {id:'emit',uses:'result.emit',with:{data:1}},
  ]}));
  await service.publish(filler.workflow_id,1);
  for(let i=0;i<7;i++)await service.start(filler.workflow_id,{},'filler-'+i);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE outcome IN ('queued','running')")
    .get() as {n:number}).n,8);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_n:unknown,_o:unknown,cb:()=>Promise<unknown>)=>cb(),
      sleep:async()=>{}} as unknown as WorkflowStep);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='launch')?.error_code,
    'detached_child_admission_rejected');
  assert.equal(nativeCreates,8,'only parent and seven previously reserved Runs were created');
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?')
    .get(started.run_id) as {n:number}).n,0);
});

test('late child success after an uncertain native cancellation never authorizes parent output',async t=>{
  const {service,env,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Child finishes late',
    steps:[{id:'emit',uses:'result.emit',with:{data:'late result'}}]}));
  const published=await service.publish(child.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Parent must honor cancellation',
    steps:[
      {id:'delegate',flow:'child',workflow_id:child.workflow_id,
        version_id:published.published_version_id,inputs:{}},
      {id:'blocked',uses:'result.emit',needs:['delegate'],
        with:{data:'must never be emitted'}},
    ]}));
  const checked=await service.validateDefinition((await service.get(parent.workflow_id)).definition) as
    {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>};
  await service.publish(parent.workflow_id,1,[],false,false,[],checked.required_children!);
  const nativeStep={do:async(_n:unknown,_o:unknown,cb:()=>Promise<unknown>)=>cb(),
    sleep:async()=>{}} as unknown as WorkflowStep;
  let creates=0,terminateCalls=0,requested=false;
  env.WORKFLOW.get=async()=>({
    async status(){return {status:'running'};},
    async terminate(){terminateCalls++;throw Error('lost_termination_ack');},
  });
  const started=await service.start(parent.workflow_id);
  env.WORKFLOW.create=async({id})=>{
    creates++;
    // Native execution already entered running before cancellation. The
    // physical terminate ACK is lost, and its business result arrives late.
    sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=? AND outcome='queued'").run(id);
    const cancellation=await service.cancel(started.run_id,'delegate');
    assert.equal(cancellation.cancellation,'requested_unverified');
    requested=true;
    await new WorkflowOrchestrator({} as ExecutionContext,env).run(
      {payload:{run_id:id}} as WorkflowEvent<{run_id:string}>,nativeStep);
  };
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,nativeStep);
  const result=await service.result(started.run_id);
  assert.equal(requested,true);
  assert.equal(creates,1);
  assert.equal(terminateCalls,1);
  assert.equal(result.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='delegate')?.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='blocked')?.status,'skipped');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE outcome='succeeded'").get()?.n,1,
    'Child really completed, but its late success cannot unlock parent steps');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM child_cancellations').get()?.n,1);
});

test('cancel committed before native child entry prevents any business step after delayed create',async t=>{
  const {service,env,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Late native create',
    steps:[{id:'emit',uses:'result.emit',with:{data:'must not run'}}]}));
  const published=await service.publish(child.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Parent cancels before child executes',
    steps:[
      {id:'delegate',flow:'child',workflow_id:child.workflow_id,
        version_id:published.published_version_id,inputs:{}},
      {id:'blocked',uses:'result.emit',needs:['delegate'],
        with:{data:'not authorized'}},
    ]}));
  const checked=await service.validateDefinition((await service.get(parent.workflow_id)).definition) as
    {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>};
  await service.publish(parent.workflow_id,1,[],false,false,[],checked.required_children!);
  const nativeStep={do:async(_n:unknown,_o:unknown,cb:()=>Promise<unknown>)=>cb(),
    sleep:async()=>{}} as unknown as WorkflowStep;
  let terminates=0;
  env.WORKFLOW.get=async()=>({
    async status(){return {status:'running'};},
    async terminate(){terminates++;throw Error('lost_native_ack');},
  });
  const started=await service.start(parent.workflow_id);
  let childId='';
  env.WORKFLOW.create=async({id})=>{
    childId=id;
    // The D1 dispatch fence committed, but native create was delayed until
    // the cancellation intent was recorded. No child business step may run.
    const cancel=await service.cancel(started.run_id,'delegate');
    assert.equal(cancel.cancellation,'requested_unverified');
    await new WorkflowOrchestrator({} as ExecutionContext,env).run(
      {payload:{run_id:id}} as WorkflowEvent<{run_id:string}>,nativeStep);
  };
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,nativeStep);
  const row=sqlite.prepare('SELECT outcome,error_code FROM runs WHERE id=?')
    .get(childId) as {outcome:string;error_code:string};
  assert.equal(row.outcome,'failed');
  assert.equal(row.error_code,'child_cancel_requested');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM run_steps WHERE run_id=?').get(childId)?.n,0);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='blocked')?.status,'skipped');
  assert.equal(terminates,1,'No duplicate termination attempt after lost native ACK');
});

test('paused pinned child is a definite failure without a child Run or native create',async t=>{
  const {service,env,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Paused child admission',
    steps:[{id:'emit',uses:'result.emit',with:{data:'must not execute'}}]}));
  const pub=await service.publish(child.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Parent blocked by paused child',
    steps:[
      {id:'delegate',flow:'child',workflow_id:child.workflow_id,
        version_id:pub.published_version_id,inputs:{}},
      {id:'blocked',uses:'result.emit',needs:['delegate'],with:{data:'not authorized'}},
    ]}));
  const review=await service.validateDefinition((await service.get(parent.workflow_id)).definition) as
    {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>};
  await service.publish(parent.workflow_id,1,[],false,false,[],review.required_children!);
  await service.pause(child.workflow_id);
  let nativeCreates=0;
  env.WORKFLOW.create=async()=>{nativeCreates++;};
  const started=await service.start(parent.workflow_id);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_name:unknown,_opt:unknown,cb:()=>Promise<unknown>)=>cb(),
     sleep:async()=>{}} as unknown as WorkflowStep);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='delegate')?.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='delegate')?.error_code,'child_target_unavailable');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='blocked')?.status,'skipped');
  assert.equal(nativeCreates,1,'Only the parent native instance should be created');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?')
    .get(started.run_id)?.n,0,'No child capacity or native instance was admitted');
});

test('pinned child failure does not turn parent join into success',async t=>{
  const {service,env,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Child missing runtime input',
    steps:[{id:'oops',uses:'result.emit',if:{ref:'inputs.missing'},with:{data:'never'}}]}));
  const pub=await service.publish(child.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Parent should fail',
    steps:[
      {id:'delegate',flow:'child',workflow_id:child.workflow_id,
       version_id:pub.published_version_id,inputs:{}},
      {id:'blocked',uses:'result.emit',needs:['delegate'],with:{data:'not dispatched'}},
    ]}));
  const checked=await service.validateDefinition((await service.get(parent.workflow_id)).definition);
  const approved=(checked as {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>}).required_children!;
  await service.publish(parent.workflow_id,1,[],false,false,[],approved);
  let starts=0;
  env.WORKFLOW.create=async({id})=>{
    starts++;
    if(starts===1)return;
    await new WorkflowOrchestrator({} as ExecutionContext,env).run(
      {payload:{run_id:id}} as WorkflowEvent<{run_id:string}>,
      {do:async(_n:unknown,_o:unknown,cb:()=>Promise<unknown>)=>cb(),
       sleep:async()=>{}} as unknown as WorkflowStep);
  };
  const started=await service.start(parent.workflow_id);
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,
    {do:async(_n:unknown,_o:unknown,cb:()=>Promise<unknown>)=>cb(),
     sleep:async()=>{}} as unknown as WorkflowStep);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='delegate')?.status,'failed');
  assert.equal(result.steps.find((s:{step_id:string})=>s.step_id==='blocked')?.status,'skipped');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n,2);
});

test('awaited child cancellation is one-shot, terminal evidence required, and no GitHub token needed',async t=>{
  const {service,sqlite,env}=setup(t);
  const target=await service.create(JSON.stringify({version:1,name:'Cancelable child',
    steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]}));
  const published=await service.publish(target.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Parent cancellation owner',
    steps:[{id:'delegate',flow:'child',workflow_id:target.workflow_id,
      version_id:published.published_version_id,inputs:{}}]}));
  const reviewed=(await service.validateDefinition((await service.get(parent.workflow_id)).definition)) as
    {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>};
  await service.publish(parent.workflow_id,1,[],false,false,[],reviewed.required_children!);
  const run=await service.start(parent.workflow_id);
  sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(run.run_id);
  const childId=await awaitedChildRunId(run.run_id,'delegate');
  const frozen='{}';
  const digest=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(frozen))).toString('hex');
  await transferAwaitedChildCapacity(env.DB,{parentRunId:run.run_id,parentStepId:'delegate',
    childRunId:childId,childWorkflowId:target.workflow_id,childVersionId:published.published_version_id,
    admissionKey:'child-'+childId,requestDigest:digest,inputJson:frozen,timestamp:Date.now()});
  let native='running';
  let terminations=0;
  env.WORKFLOW.create=async()=>{};
  env.WORKFLOW.get=async()=>({
    async status(){return {status:native};},
    async terminate(){terminations++;native='terminated';},
  });
  await startReservedAwaitedChild(env,{parentRunId:run.run_id,parentStepId:'delegate',
    childRunId:childId,timestamp:Date.now()});
  const first=await service.cancel(run.run_id,'delegate');
  assert.equal(first.cancellation,'terminal_confirmed');
  assert.equal(first.native_workflow_terminated,true);
  assert.equal(first.physical_terminated,false);
  const replay=await service.cancel(run.run_id,'delegate');
  assert.equal(replay.cancellation,'terminal_confirmed');
  assert.equal(terminations,1);
  const row=sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(childId) as {outcome:string};
  assert.equal(row.outcome,'cancelled');
  // Parent recovery observes the child's terminal D1 outcome, not a new
  // native create attempt and not an uncertain restart.
  assert.deepEqual(await startReservedAwaitedChild(env,{
    parentRunId:run.run_id,parentStepId:'delegate',
    childRunId:childId,timestamp:Date.now(),
  }),{childRunId:childId,start_state:'started'});
  assert.equal(terminations,1);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM child_cancellations').get() as {n:number}).n,1);
});

test('unknown native termination response cannot POST terminate twice',async t=>{
  const {service,sqlite,env}=setup(t);
  const target=await service.create(JSON.stringify({version:1,name:'Uncertain child',
    steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]}));
  const published=await service.publish(target.workflow_id,1);
  const parent=await service.create(JSON.stringify({version:1,name:'Uncertain parent',
    steps:[{id:'delegate',flow:'child',workflow_id:target.workflow_id,
      version_id:published.published_version_id,inputs:{}}]}));
  const validation=await service.validateDefinition((await service.get(parent.workflow_id)).definition);
  const approvals=(validation as {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>}).required_children!;
  await service.publish(parent.workflow_id,1,[],false,false,[],approvals);
  const run=await service.start(parent.workflow_id);
  sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(run.run_id);
  const childId=await awaitedChildRunId(run.run_id,'delegate');
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('{}'))).toString('hex');
  await transferAwaitedChildCapacity(env.DB,{parentRunId:run.run_id,parentStepId:'delegate',
    childRunId:childId,childWorkflowId:target.workflow_id,childVersionId:published.published_version_id,
    admissionKey:'child-'+childId,requestDigest:hash,inputJson:'{}',timestamp:Date.now()});
  env.WORKFLOW.create=async()=>{};
  let attempts=0;
  env.WORKFLOW.get=async()=>({
    async status(){return {status:'running'};},
    async terminate(){attempts++;throw Error('lost_terminate_ack');},
  });
  await startReservedAwaitedChild(env,{parentRunId:run.run_id,parentStepId:'delegate',
    childRunId:childId,timestamp:Date.now()});
  assert.equal((await service.cancel(run.run_id,'delegate')).cancellation,'requested_unverified');
  assert.equal((await service.cancel(run.run_id,'delegate')).cancellation,'requested_unverified');
  assert.equal(attempts,1);
  await assert.rejects(()=>service.cancel(run.run_id,'delegate',true),/child_force_not_supported/);
});

test('child publish refuses unmanaged physical GitHub actions until cancellation is verified',async t=>{
  const {service,sqlite}=setup(t);
  const child=await service.create(JSON.stringify({version:1,name:'Child physical job guard',
    steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]}));
  const version=await service.publish(child.workflow_id,1);
  sqlite.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(
    JSON.stringify({version:1,name:'Unsafe child',steps:[{
      id:'unmanaged',uses:'github.run',needs:[],with:{
        capability:'github.action',action:{type:'session'},
      },
    }]}),version.published_version_id);
  const definition=JSON.stringify({version:1,name:'Parent cannot approve unsafe child',
    steps:[{id:'call',flow:'child',workflow_id:child.workflow_id,
      version_id:version.published_version_id,inputs:{}}]});
  const validation=await service.validateDefinition(definition);
  assert.equal(validation.valid,false);
  assert.equal(validation.issues[0]?.code,'child_external_action_unsupported');
  const parent=await service.create(definition);
  await assert.rejects(()=>service.publish(parent.workflow_id,1),
    /child_external_action_unsupported/);
});

async function reservedChildTestFixture(t:test.TestContext){
  const f=setup(t);
  const target=await f.service.create(JSON.stringify({version:1,name:'Cancel-race child',
    steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]}));
  const childVersion=await f.service.publish(target.workflow_id,1);
  const parent=await f.service.create(JSON.stringify({version:1,name:'Cancel-race parent',
    steps:[{id:'delegate',flow:'child',workflow_id:target.workflow_id,
      version_id:childVersion.published_version_id,inputs:{}}]}));
  const validation=await f.service.validateDefinition((await f.service.get(parent.workflow_id)).definition) as
    {required_children?:Array<{workflow_id:string;version_id:string;digest:string}>};
  await f.service.publish(parent.workflow_id,1,[],false,false,[],validation.required_children!);
  const run=await f.service.start(parent.workflow_id);
  f.sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(run.run_id);
  const childId=await awaitedChildRunId(run.run_id,'delegate');
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('{}'))).toString('hex');
  await transferAwaitedChildCapacity(f.env.DB,{
    parentRunId:run.run_id,parentStepId:'delegate',
    childRunId:childId,childWorkflowId:target.workflow_id,
    childVersionId:childVersion.published_version_id,
    admissionKey:'child-'+childId,requestDigest:hash,
    inputJson:'{}',timestamp:Date.now(),
  });
  return {...f,runId:run.run_id,childId,start:()=>startReservedAwaitedChild(f.env,{
    parentRunId:run.run_id,parentStepId:'delegate',childRunId:childId,timestamp:Date.now(),
  })};
}

test('cancel-before-native-start prevents any subsequent Cloudflare create, even on replay',async t=>{
  const f=await reservedChildTestFixture(t);
  let starts=0,ends=0;
  f.env.WORKFLOW.create=async()=>{starts++;};
  f.env.WORKFLOW.get=async()=>{
    ends++;
    throw Error('instance.not_found');
  };
  const first=await f.service.cancel(f.runId,'delegate');
  assert.equal(first.cancellation,'cancelled_before_start');
  assert.equal(first.native_workflow_terminated,false);
  assert.equal(first.physical_terminated,false);
  assert.deepEqual(await f.start(),{childRunId:f.childId,start_state:'cancelled_before_start'});
  const replay=await f.service.cancel(f.runId,'delegate');
  assert.equal(replay.cancellation,'cancelled_before_start');
  assert.equal(starts,0);
  assert.equal(ends,0);
  const child=f.sqlite.prepare('SELECT outcome,start_state FROM runs WHERE id=?')
    .get(f.childId) as {outcome:string;start_state:string};
  assert.deepEqual({...child},{outcome:'cancelled',start_state:'cancelled_before_start'});
});

test('cancel during pending native create survives a 404 and terminates exactly once after ACK',async t=>{
  const f=await reservedChildTestFixture(t);
  const entered=deferred(),resume=deferred();
  let exists=false,native='running',starts=0,terminations=0;
  f.env.WORKFLOW.create=async({id})=>{
    assert.equal(id,f.childId);
    starts++;
    entered.resolve();
    await resume.promise;
    exists=true;
  };
  f.env.WORKFLOW.get=async()=>{
    if(!exists)throw Error('instance.not_found');
    return {async status(){return {status:native};},
      async terminate(){terminations++;native='terminated';}};
  };
  const inflight=f.start();
  await entered.promise;
  const request=await f.service.cancel(f.runId,'delegate');
  assert.equal(request.cancellation,'requested_unverified');
  let intent=f.sqlite.prepare('SELECT termination_attempted_at FROM child_cancellations WHERE child_run_id=?')
    .get(f.childId) as {termination_attempted_at:number|null};
  assert.equal(intent.termination_attempted_at,null);
  resume.resolve();
  assert.deepEqual(await inflight,{childRunId:f.childId,start_state:'started'});
  assert.equal(terminations,1);
  assert.equal(starts,1);
  assert.equal((f.sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(f.childId) as
    {outcome:string}).outcome,'cancelled');
  assert.equal((await f.service.cancel(f.runId,'delegate')).cancellation,'terminal_confirmed');
  assert.equal(terminations,1);
  intent=f.sqlite.prepare('SELECT termination_attempted_at FROM child_cancellations WHERE child_run_id=?')
    .get(f.childId) as {termination_attempted_at:number|null};
  assert.equal(typeof intent.termination_attempted_at,'number');
});

test('cancel before the atomic dispatch fence forbids Cloudflare create',async t=>{
  const f=await reservedChildTestFixture(t);
  let starts=0,intercepted=false;
  f.env.WORKFLOW.create=async()=>{starts++;};
  f.env.WORKFLOW.get=async()=>{throw Error('instance.not_found');};
  const oldPrepare=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=((sql:string)=>{
    const statement=oldPrepare(sql);
    if(!intercepted&&sql.includes("SET start_state='dispatching'")){
      intercepted=true;
      const oldRun=statement.run.bind(statement);
      statement.run=(async()=>{
        const cancelled=await f.service.cancel(f.runId,'delegate');
        assert.equal(cancelled.cancellation,'cancelled_before_start');
        return oldRun();
      }) as typeof statement.run;
    }
    return statement;
  }) as typeof f.env.DB.prepare;
  assert.deepEqual(await f.start(),{childRunId:f.childId,start_state:'cancelled_before_start'});
  assert.equal(starts,0);
  assert.equal(intercepted,true);
  const row=f.sqlite.prepare('SELECT outcome,start_state FROM runs WHERE id=?')
    .get(f.childId) as {outcome:string;start_state:string};
  assert.deepEqual({...row},{outcome:'cancelled',start_state:'cancelled_before_start'});
  assert.equal((await f.service.cancel(f.runId,'delegate')).cancellation,'cancelled_before_start');
});

test('cancel after committed dispatch fence records one termination and no false pre-start cancel',async t=>{
  const f=await reservedChildTestFixture(t);
  let starts=0,terminates=0,intercepted=false,exists=false,native='running';
  f.env.WORKFLOW.create=async({id})=>{
    assert.equal(id,f.childId);
    starts++;exists=true;
  };
  f.env.WORKFLOW.get=async()=>{
    if(!exists)throw Error('instance.not_found');
    return {async status(){return {status:native};},
      async terminate(){terminates++;native='terminated';}};
  };
  const oldPrepare=f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare=((sql:string)=>{
    const statement=oldPrepare(sql);
    if(!intercepted&&sql.includes("SET start_state='dispatching'")){
      intercepted=true;
      const oldRun=statement.run.bind(statement);
      statement.run=(async()=>{
        const claim=await oldRun();
        assert.equal(claim.meta.changes,1);
        const cancelled=await f.service.cancel(f.runId,'delegate');
        assert.equal(cancelled.cancellation,'requested_unverified');
        return claim;
      }) as typeof statement.run;
    }
    return statement;
  }) as typeof f.env.DB.prepare;
  assert.deepEqual(await f.start(),{childRunId:f.childId,start_state:'started'});
  assert.equal(intercepted,true);
  assert.equal(starts,1);
  assert.equal(terminates,1);
  const row=f.sqlite.prepare('SELECT outcome FROM runs WHERE id=?')
    .get(f.childId) as {outcome:string};
  assert.equal(row.outcome,'cancelled');
  assert.equal((await f.service.cancel(f.runId,'delegate')).cancellation,'terminal_confirmed');
  assert.equal(terminates,1);
});


const EVENT_SECRET=Buffer.alloc(32,0x61).toString('base64url');
const EVENT_SHA=createHash('sha256').update(EVENT_SECRET).digest('hex');
const eventSteps=()=>[
  {id:'signal',flow:'wait_event',timeout_seconds:30,token_sha256:EVENT_SHA},
  {id:'done',needs:['signal'],uses:'result.emit',with:{data:{ref:'steps.signal.output.value'}}},
];
const signalRequest=(runId:string,body:unknown={value:'resumed'},eventId='signal-one',secret=EVENT_SECRET)=>
  new Request('https://workflow.example.org/events/'+runId+'/signal',{
    method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json',
      'x-workflow-event-id':eventId},body:JSON.stringify(body),
  });

test('event wait ingress authenticates Run/Step and only accepts one logical event',async t=>{
  const {env,admit,sqlite}=setup(t);
  const started=await admit(eventSteps());
  let sendCount=0;
  (env as any).WORKFLOW={create:async()=>{},get:async()=>({
    status:async()=>({status:'running'}),sendEvent:async()=>{sendCount++;},
  })};
  const deliver=(req:Request)=>handleWaitEvent(req,env);
  assert.equal((await deliver(signalRequest(started.run_id,{},'wrong',Buffer.alloc(32,0x42).toString('base64url')))).status,401);
  assert.equal((await deliver(signalRequest(crypto.randomUUID()))).status,404);
  assert.equal((await deliver(new Request('https://workflow.example.org/events/'+started.run_id+'/unknown',
    {method:'POST'}))).status,404);
  const a=await deliver(signalRequest(started.run_id,{value:'resumed'}));
  assert.equal(a.status,202);
  const b=await deliver(signalRequest(started.run_id,{value:'resumed'}));
  assert.equal(b.status,200);
  assert.equal((await deliver(signalRequest(started.run_id,{value:'different'}))).status,409);
  assert.equal((await deliver(signalRequest(started.run_id,{value:'resumed'},'other-id'))).status,409);
  assert.equal(sendCount,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM wait_event_receipts').get()?.n,1);
});

test('uncertain sendEvent can retry same signal without reserving a second logical event',async t=>{
  const {env,admit,sqlite}=setup(t);
  const started=await admit(eventSteps());
  let attempts=0;
  (env as any).WORKFLOW={create:async()=>{},get:async()=>({status:async()=>({status:'running'}),
    sendEvent:async()=>{attempts++;if(attempts===1)throw Error('ack lost');},
  })};
  assert.equal((await handleWaitEvent(signalRequest(started.run_id),env)).status,503);
  assert.equal((await handleWaitEvent(signalRequest(started.run_id,{value:'different'}),env)).status,409);
  assert.equal((await handleWaitEvent(signalRequest(started.run_id),env)).status,202);
  assert.equal(attempts,2);
  assert.ok(sqlite.prepare('SELECT last_sent_at FROM wait_event_receipts').get()?.last_sent_at);
});

test('signal delivered before waitForEvent is buffered and resumes exactly one dependent Step',async t=>{
  const {env,service,admit,sqlite}=setup(t);
  const started=await admit(eventSteps());
  let buffered:unknown=null;
  let release:(event:unknown)=>void=()=>{};
  let waiter:Promise<unknown>|null=null;
  (env as any).WORKFLOW={create:async()=>{},get:async()=>({
    status:async()=>({status:'running'}),
    sendEvent:async(event:unknown)=>{buffered=event;release(event);},
  })};
  assert.equal((await handleWaitEvent(signalRequest(started.run_id),env)).status,202);
  const orchestrator=new WorkflowOrchestrator({} as ExecutionContext,env);
  await orchestrator.run({payload:{run_id:started.run_id}} as WorkflowEvent<{run_id:string}>,{
    do:async(_name:unknown,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
    waitForEvent:async(name:string,options:{type:string;timeout:string})=>{
      assert.equal(name,'workflow-signal-event');
      assert.equal(options.type,'wfe_signal');
      assert.equal(options.timeout,'30 seconds');
      if(buffered)return buffered;
      waiter=new Promise(resolve=>{release=resolve;});return waiter;
    },
  } as unknown as WorkflowStep);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.result,'resumed');
  assert.equal(sqlite.prepare("SELECT status FROM run_steps WHERE step_id='signal'").get()?.status,'succeeded');
});

test('event wait timeout fails and nonrunning owner fences downstream',async t=>{
  const {env,service,admit,sqlite}=setup(t);
  const expired=await admit(eventSteps());
  const step={do:async(_name:unknown,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
    waitForEvent:async()=>{throw Error('workflow event timed out');}} as unknown as WorkflowStep;
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:expired.run_id}} as WorkflowEvent<{run_id:string}>,step);
  const expiredResult=await service.result(expired.run_id);
  assert.equal(expiredResult.status,'failed');
  assert.equal(expiredResult.steps.find(x=>x.step_id==='done')?.status,'skipped');
  assert.equal((await handleWaitEvent(signalRequest(expired.run_id),env)).status,409);
  const cancelled=await admit(eventSteps());
  await new WorkflowOrchestrator({} as ExecutionContext,env).run(
    {payload:{run_id:cancelled.run_id}} as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_opt:unknown,cb:()=>Promise<unknown>)=>cb(),
      waitForEvent:async()=>{
        sqlite.prepare("UPDATE runs SET outcome='cancelled' WHERE id=?").run(cancelled.run_id);
        sqlite.prepare("INSERT INTO wait_event_receipts (run_id,step_id,event_id,payload_digest,created_at) VALUES (?,?,?,?,?)")
          .run(cancelled.run_id,'signal','a','a'.repeat(64),Date.now());
        return {payload:{event_id:'a',data:{value:'bad'}}};
      },
    } as unknown as WorkflowStep);
  const cancelledResult=await service.result(cancelled.run_id);
  assert.equal(cancelledResult.status,'cancelled');
  assert.equal(cancelledResult.steps.find(x=>x.step_id==='done')?.status,'skipped');
  assert.equal((await handleWaitEvent(signalRequest(cancelled.run_id),env)).status,409);
});

test('reviewed MCP write calls exactly one IMA ima_create_note after pinned publish approval',async t=>{
  const {service,env,sqlite,run}=setup(t);
  let writes=0;
  let dropAcknowledgment=false;
  const createPeer=()=>{
    const server=new McpServer({name:'workflow-reviewed-write-fixture',version:'0.1.0'},
      {capabilities:{tools:{}}});
    server.registerTool('ima_create_note',{
      description:'One reviewed, non-idempotent IMA note creation',
      inputSchema:z.object({content:z.string().min(1).max(2048)}).strict(),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
    },async({content})=>{writes++;return {content:[{type:'text',text:'note created: '+content}]};});
    return server;
  };
  const peer=createMcpHandler(createPeer,{legacy:'stateless'});
  const oldFetch=globalThis.fetch;
  const target=ECHO_GRANT.endpoint;
  let manualRequests=0;
  const handler=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    assert.equal(request.url,target);
    if(request.redirect==='manual')manualRequests++;
    const isCall=request.method==='POST' &&
      (await request.clone().json() as {method?:string}).method==='tools/call';
    const response=await peer.fetch(request);
    if(dropAcknowledgment && isCall)throw Error('simulated_ack_lost_after_note_created');
    return response;
  };
  globalThis.fetch=handler as typeof fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  const client=new Client({name:'write-contract-test',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(target),{fetch:handler as typeof fetch});
  let schema:unknown;
  try{
    await client.connect(transport);
    const live=await client.listTools();
    const candidate=live.tools.find(x=>x.name==='ima_create_note');
    assert.ok(candidate);
    assert.equal(reviewedWriteTool(candidate),true);
    schema=candidate.inputSchema;
  }finally{await client.close().catch(()=>{});}
  const {plan}=await compilePlan({version:1,name:'Reviewed write fixture',steps:[
    {id:'write',uses:'mcp.call',with:{endpoint:target,tool:'ima_create_note',
      scope:'write',arguments:{content:'One safe static note'},input_schema:schema}},
  ]});
  const grant:ReadonlyOperation={endpoint:target,tool:'ima_create_note',scope:'write',
    schema_digest:String(plan.steps[0]?.with.schema_digest)};
  const created=await service.create(JSON.stringify({version:1,name:'Reviewed write fixture',steps:[
    {id:'write',uses:'mcp.call',with:{endpoint:target,tool:'ima_create_note',
      scope:'write',arguments:{content:'One safe static note'},input_schema:schema}},
  ]}));
  await assert.rejects(()=>service.publish(created.workflow_id,1,[grant],true),
    /mcp_write_approval_required/);
  assert.equal(writes,0);
  await service.publish(created.workflow_id,1,[grant],true,false,[],[],[],false,[],false,true);
  const started=await service.start(created.workflow_id,{});
  const timeouts:Array<{name:string;options:unknown}>=[];
  await run(started.run_id,(name,options)=>timeouts.push({name,options}));
  assert.deepEqual(timeouts.filter(x=>x.name==='workflow-write').map(x=>x.options),[
    {retries:{limit:0,delay:'1 second'},timeout:'90 seconds'},
  ]);
  const result=await service.result(started.run_id);
  assert.equal(result.status,'succeeded');
  assert.equal(result.steps[0]?.status,'succeeded');
  assert.equal(writes,1);
  assert.ok(manualRequests>0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_dispatch_fences WHERE run_id=?')
    .get(started.run_id)?.n,1);
  // Native duplicate replay is harmless: a terminal Run never gets a second
  // business effect or dispatch reservation.
  await run(started.run_id);
  assert.equal(writes,1);

  // Physical write happens but its response is lost. The immutable Run must
  // stay indeterminate; neither native replay nor caller retry can write twice.
  dropAcknowledgment=true;
  const unknown=await service.start(created.workflow_id,{});
  await run(unknown.run_id);
  const unknownResult=await service.result(unknown.run_id);
  assert.equal(unknownResult.status,'indeterminate');
  assert.equal(unknownResult.error_code,'external_outcome_unknown');
  assert.equal(writes,2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_dispatch_fences WHERE run_id=?')
    .get(unknown.run_id)?.n,1);
  dropAcknowledgment=false;
  await run(unknown.run_id);
  assert.equal(writes,2);

  // Revocation after publication fences a new call from the old generation.
  await service.portalConnectionRevoke();
  const revoked=await service.start(created.workflow_id,{});
  await run(revoked.run_id);
  const denied=await service.result(revoked.run_id);
  assert.equal(denied.status,'failed');
  assert.equal(denied.steps[0]?.error_code,'portal_connection_revoked');
  assert.equal(writes,2);
});

// The longer MCP budget must not silently extend unrelated Step types.
test('non-MCP result.emit keeps the existing 30-second native Step timeout',async t=>{
  const {admit,run,service}=setup(t);
  const started=await admit([{id:'out',uses:'result.emit',with:{data:'ok'}}]);
  const observed:Array<{name:string;options:unknown}>=[];
  await run(started.run_id,(name,options)=>observed.push({name,options}));
  assert.deepEqual(observed.filter(x=>x.name==='workflow-out').map(x=>x.options),[
    {retries:{limit:0,delay:'1 second'},timeout:'30 seconds'},
  ]);
  assert.equal((await service.result(started.run_id)).status,'succeeded');
});

test('reviewed IMA append: exactly one effect, no replay on lost ACK, revoke blocks new dispatch',async t=>{
  const {service,env,sqlite,run}=setup(t);
  const noteId='7521947772530780';
  let written='',calls=0,dropAcknowledgment=false;
  const makePeer=()=>{
    const server=new McpServer({name:'workflow-reviewed-append-fixture',version:'0.1.0'},
      {capabilities:{tools:{}}});
    server.registerTool('ima_append_note',{
      inputSchema:z.object({note_id:z.string(),content:z.string().min(1)}).strict(),
      annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false},
    },async({note_id,content})=>{
      assert.equal(note_id,noteId);
      calls++;written+=content;
      return {content:[{type:'text',text:'appended'}]};
    });
    return server;
  };
  const peer=createMcpHandler(makePeer,{legacy:'stateless'});
  const oldFetch=globalThis.fetch;
  const url=ECHO_GRANT.endpoint;
  const handler=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    assert.equal(request.url,url);
    const isCall=request.method==='POST' &&
      (await request.clone().json() as {method?:string}).method==='tools/call';
    const response=await peer.fetch(request);
    if(dropAcknowledgment&&isCall)throw Error('simulated_ack_lost_after_append');
    return response;
  };
  globalThis.fetch=handler as typeof fetch;
  t.after(()=>{globalThis.fetch=oldFetch;});
  const client=new Client({name:'append-schema-fixture',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(url),{fetch:handler as typeof fetch});
  let schema:unknown;
  try{
    await client.connect(transport);
    const found=(await client.listTools()).tools.find(x=>x.name==='ima_append_note');
    assert.ok(found);
    assert.equal(reviewedWriteTool(found),true);
    schema=found.inputSchema;
  }finally{await client.close().catch(()=>{});}
  const definition={version:1,name:'Reviewed append one effect',steps:[{
    id:'append',uses:'mcp.call',with:{endpoint:url,tool:'ima_append_note',
      scope:'write',input_schema:schema,arguments:{note_id:noteId,content:'safe append'}},
  }]};
  const compiled=await compilePlan(definition);
  const grant:ReadonlyOperation={endpoint:url,tool:'ima_append_note',scope:'write',
    schema_digest:String(compiled.plan.steps[0].with.schema_digest)};
  const created=await service.create(JSON.stringify(definition));
  await assert.rejects(()=>service.publish(created.workflow_id,1,[grant],true),
    /mcp_write_approval_required/);
  assert.equal(calls,0);
  await service.publish(created.workflow_id,1,[grant],true,false,[],[],[],false,[],false,true);
  const first=await service.start(created.workflow_id,{});
  await run(first.run_id);
  assert.equal((await service.result(first.run_id)).status,'succeeded');
  assert.equal(written,'safe append');
  assert.equal(calls,1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM mcp_dispatch_fences WHERE run_id=?')
    .get(first.run_id)?.n,1);
  await run(first.run_id);
  assert.equal(calls,1);
  dropAcknowledgment=true;
  const unknown=await service.start(created.workflow_id,{});
  await run(unknown.run_id);
  const result=await service.result(unknown.run_id);
  assert.equal(result.status,'indeterminate');
  assert.equal(result.error_code,'external_outcome_unknown');
  assert.equal(calls,2);
  assert.equal(written,'safe appendsafe append');
  dropAcknowledgment=false;
  await run(unknown.run_id);
  assert.equal(calls,2);
  await service.portalConnectionRevoke();
  const revoked=await service.start(created.workflow_id,{});
  await run(revoked.run_id);
  const denied=await service.result(revoked.run_id);
  assert.equal(denied.status,'failed');
  assert.equal(denied.steps[0]?.error_code,'portal_connection_revoked');
  assert.equal(calls,2);
});
