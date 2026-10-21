import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { WorkflowService, type Env } from '../src/store.ts';
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
  async function admit(steps:unknown[],inputs:Record<string,unknown>={}){
    const w=await service.create(JSON.stringify({version:1,name:'Review regression',steps}));
    await service.publish(w.workflow_id,1);
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
