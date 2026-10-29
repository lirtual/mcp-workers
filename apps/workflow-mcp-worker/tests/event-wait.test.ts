import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import type {WorkflowEvent,WorkflowStep} from 'cloudflare:workers';
import {compilePlan,PlanError} from '../src/plan.ts';
import {handleWaitEvent} from '../src/wait-event-ingress.ts';
import {WorkflowService,type Env} from '../src/store.ts';

const token=Buffer.alloc(32,0x42).toString('base64url');
const other=Buffer.alloc(32,0x43).toString('base64url');
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const definition=(duration=30)=>({version:1,name:'External event wait',steps:[
  {id:'signal',flow:'wait_event',token_sha256:hash(token),timeout_seconds:duration},
  {id:'done',uses:'result.emit',needs:['signal'],
   with:{data:{ref:'steps.signal.output.value'}}},
]});
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',shortCircuit:true};
  return next(specifier,context);
}});
const {WorkflowOrchestrator}=await import('../src/runner.ts');
hooks.deregister();

function deferred<T>(){
 let resolve!:(value:T)=>void;
 let reject!:(error:Error)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
function setup(t:test.TestContext){
 const sqlite=new DatabaseSync(':memory:');
 t.after(()=>sqlite.close());
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
   '0011_awaited_child_capacity.sql','0012_event_wait_receipts.sql'])
   sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 let deliveries:Array<{type:string;payload:any}>=[];
 let failure=false;
 let terminated=false;
 const instance={
  async status(){return {status:terminated?'terminated':'running'};},
  async terminate(){terminated=true;},
  async sendEvent(value:{type:string;payload:unknown}){
    if(failure)throw Error('ambiguous_network_response');
    deliveries.push(value);
  },
 };
 const db={
  prepare(sql:string){
   let args:any[]=[];
   return {
    bind(...values:any[]){args=values;return this;},
    async first(){return sqlite.prepare(sql).get(...args)??null;},
    async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},
   };
  },
  async batch(stmts:Array<{run:()=>Promise<unknown>}>){
    sqlite.exec('BEGIN IMMEDIATE');
    try{const result=[];for(const stmt of stmts)result.push(await stmt.run());sqlite.exec('COMMIT');return result;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  },
 };
 const env={DB:db,WORKFLOW:{async create(){},async get(){return instance;}}} as unknown as Env;
 const service=new WorkflowService(env);
 const send=(runId:string,body:Record<string,unknown>={value:'OK'},bearer=token,id='stable-event',stepId='signal')=>
   handleWaitEvent(new Request('https://workflow.example.org/events/'+runId+'/'+stepId,{
     method:'POST',headers:{authorization:'Bearer '+bearer,
       'content-type':'application/json','X-Workflow-Event-Id':id},
     body:JSON.stringify(body),
   }),env);
 async function run(run_id:string,waitForEvent:(name:string,opts:any)=>Promise<any>){
   return new WorkflowOrchestrator({} as ExecutionContext,env).run(
     {payload:{run_id}} as WorkflowEvent<{run_id:string}>,
     {do:async(_name:any,_opts:any,callback:()=>Promise<unknown>)=>callback(),
      waitForEvent} as unknown as WorkflowStep);
 }
 return {sqlite,env,service,send,run,deliveries,blockSend(){failure=true;},unblockSend(){failure=false;}};
}
test('compiler enforces one finite event wait, digest-only credential and no direct opcode',async()=>{
 const compiled=await compilePlan(definition());
 assert.equal(compiled.plan.steps[0]?.uses,'flow.wait_event');
 assert.deepEqual(compiled.plan.steps[0]?.with,{token_sha256:hash(token),timeout_seconds:30});
 const bad=[
   {...definition(),steps:[{id:'signal',flow:'wait_event',token_sha256:token,timeout_seconds:30}]},
   {...definition(),steps:[{id:'signal',flow:'wait_event',token_sha256:hash(token),timeout_seconds:3601}]},
   {...definition(),steps:[{id:'signal',flow:'wait_event',token_sha256:hash(token),timeout_seconds:0}]},
   {...definition(),steps:[{id:'signal',uses:'flow.wait_event',with:{token_sha256:hash(token),timeout_seconds:60}}]},
   {...definition(),steps:[definition().steps[0],{id:'other',flow:'wait_event',token_sha256:hash(token),timeout_seconds:30}]},
 ];
 for(const item of bad)await assert.rejects(()=>compilePlan(item),PlanError);
});
test('scoped ingress denies invalid credentials, wrong step, malformed and duplicate divergent events',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition()));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 const runId=started.run_id;
 assert.equal((await x.send(runId,{},other)).status,401);
 assert.equal((await x.send(runId,{},token,'valid','unknown')).status,404);
 assert.equal((await x.send(runId,{},token,'not valid')).status,400);
 assert.equal(x.deliveries.length,0);
 const sent=await x.send(runId,{value:'first'},token,'alpha');
 assert.equal(sent.status,202);
 assert.equal(x.deliveries.length,1);
 assert.equal(x.deliveries[0]?.type,'wfe_signal');
 assert.deepEqual(x.deliveries[0]?.payload,{event_id:'alpha',data:{value:'first'}});
 assert.equal((await x.send(runId,{value:'first'},token,'alpha')).status,200);
 assert.equal(x.deliveries.length,1);
 assert.equal((await x.send(runId,{value:'changed'},token,'alpha')).status,409);
 assert.equal((await x.send(runId,{value:'first'},token,'beta')).status,409);
 assert.equal(x.deliveries.length,1);
});
test('lost send ACK may be retried only with the original event ID and payload',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition()));
 await x.service.publish(wf.workflow_id,1);
 const start=await x.service.start(wf.workflow_id,{});
 x.blockSend();
 const failed=await x.send(start.run_id,{value:'retry'},token,'logical-one');
 assert.equal(failed.status,503);
 assert.equal((await x.send(start.run_id,{value:'other'},token,'logical-two')).status,409);
 x.unblockSend();
 assert.equal((await x.send(start.run_id,{value:'retry'},token,'logical-one')).status,202);
 assert.equal(x.deliveries.length,1);
});
test('native wait resumes with matching buffered event and only then runs dependent Step',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition(10)));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 // Signal before the native Workflow has begun waiting: sendEvent buffers it.
 assert.equal((await x.send(started.run_id,{value:'buffered'},token,'early')).status,202);
 await x.run(started.run_id,async(name,opts)=>{
   assert.equal(name,'workflow-signal-event');
   assert.deepEqual(opts,{type:'wfe_signal',timeout:'10 seconds'});
   return {payload:x.deliveries[0]!.payload};
 });
 const final=await x.service.result(started.run_id);
 assert.equal(final.status,'succeeded');
 assert.equal(final.result,'buffered');
 assert.equal(final.steps.find(s=>s.step_id==='signal')?.status,'succeeded');
 assert.equal(final.steps.find(s=>s.step_id==='done')?.status,'succeeded');
});
test('native wait times out without dispatching dependent Steps',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition(1)));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 await x.run(started.run_id,async()=>{throw Error('waitForEvent timeout');});
 const final=await x.service.result(started.run_id);
 assert.equal(final.status,'failed');
 assert.equal(final.steps.find(s=>s.step_id==='signal')?.error_code,'event_wait_timeout');
 assert.equal(final.steps.find(s=>s.step_id==='done')?.status,'skipped');
 assert.equal((await x.send(started.run_id,{value:'late'})).status,409);
});
test('a cancellation fence wins after native event receipt and blocks downstream effects',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition(10)));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 assert.equal((await x.send(started.run_id,{value:'do-not-run'})).status,202);
 await x.run(started.run_id,async()=>{
   x.sqlite.prepare("UPDATE runs SET outcome='cancelled' WHERE id=?").run(started.run_id);
   return {payload:x.deliveries[0]!.payload};
 });
 const final=await x.service.result(started.run_id);
 assert.equal(final.status,'cancelled');
 assert.notEqual(final.steps.find(s=>s.step_id==='done')?.status,'succeeded');
 assert.equal((await x.send(started.run_id,{value:'do-not-run'})).status,409);
});

test('public cancellation fences the Run before native termination and never claims resource cleanup',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition(30)));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 // The public event cancellation entrypoint must target a physically
 // admitted waiting Step, never merely a queued Run.
 x.sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(started.run_id);
 x.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,'signal','waiting',?)")
  .run(started.run_id,Date.now());
 const cancel=await x.service.cancel(started.run_id,'signal');
 assert.equal(cancel.cancellation,'terminal_confirmed');
 assert.equal(cancel.native_workflow_terminated,true);
 assert.equal(cancel.physical_terminated,false);
 assert.equal((await x.service.status(started.run_id)).status,'cancelled');
 assert.equal((await x.send(started.run_id,{value:'too-late'})).status,409);
 const again=await x.service.cancel(started.run_id,'signal');
 assert.equal(again.native_workflow_terminated,true);
 await assert.rejects(()=>x.service.cancel(started.run_id,'signal',true),
   (error:unknown)=>error instanceof Error&&error.message==='wait_event_force_not_supported');
});

test('event cancel cannot terminate a queued Run before its waiting Step is entered',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition()));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 await assert.rejects(()=>x.service.cancel(started.run_id,'signal'),
   (error:unknown)=>error instanceof Error&&error.message==='wait_event_not_cancellable');
 const row=x.sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(started.run_id) as {outcome:string};
 assert.equal(row.outcome,'queued');
});
test('event cancel cannot terminate a Run after target Step has already succeeded',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition()));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 x.sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(started.run_id);
 x.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,'signal','succeeded',?)")
  .run(started.run_id,Date.now());
 await assert.rejects(()=>x.service.cancel(started.run_id,'signal'),
   (error:unknown)=>error instanceof Error&&error.message==='wait_event_not_cancellable');
 const row=x.sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(started.run_id) as {outcome:string};
 assert.equal(row.outcome,'running');
 assert.equal((await x.env.WORKFLOW.get(started.run_id).then(v=>v.status())).status,'running');
});
test('event cancel refuses to terminate a Run with another active independent Step',async t=>{
 const x=setup(t);
 const spec={...definition(),steps:[...definition().steps,
  {id:'parallel',uses:'result.emit',with:{data:'unrelated'}}]};
 const wf=await x.service.create(JSON.stringify(spec));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 x.sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(started.run_id);
 x.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,'signal','waiting',?)")
  .run(started.run_id,Date.now());
 x.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,'parallel','running',?)")
  .run(started.run_id,Date.now());
 await assert.rejects(()=>x.service.cancel(started.run_id,'signal'),
   (error:unknown)=>error instanceof Error&&error.message==='wait_event_not_cancellable');
 assert.equal((x.sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(started.run_id) as {outcome:string}).outcome,'running');
});
test('public cancel while the native event resumes retains the cancelled Run and blocks downstream',async t=>{
 const x=setup(t),wf=await x.service.create(JSON.stringify(definition()));
 await x.service.publish(wf.workflow_id,1);
 const started=await x.service.start(wf.workflow_id,{});
 assert.equal((await x.send(started.run_id,{value:'should-not-emit'})).status,202);
 await x.run(started.run_id,async()=>{
  const cancel=await x.service.cancel(started.run_id,'signal');
  assert.equal(cancel.native_workflow_terminated,true);
  return {payload:x.deliveries[0]?.payload};
 });
 const after=await x.service.result(started.run_id);
 assert.equal(after.status,'cancelled');
 assert.equal(after.steps.find(s=>s.step_id==='done')?.status,'skipped');
});
