import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import type {WorkflowEvent,WorkflowStep} from 'cloudflare:workers';
import {compilePlan} from '../src/plan.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import type {Env} from '../src/store.ts';
const hook=registerHooks({resolve(specifier,context,next){
 if(specifier==='cloudflare:workers')
  return {url:'data:text/javascript,export class WorkflowEntrypoint {constructor(ctx,env){this.env=env;}}',shortCircuit:true};
 return next(specifier,context);
}});
const {WorkflowOrchestrator}=await import('../src/runner.ts');
hook.deregister();
const WF='11111111-1111-4111-8111-111111111111',RUN='22222222-2222-4222-8222-222222222222';
const VERSION='33333333-3333-4333-8333-333333333333';
async function scenario(t:any,state:'succeeded'|'indeterminate'|'none'){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0011_awaited_child_capacity.sql','0013_cloudflare_action_invocations.sql'])
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const prepare=(sql:string)=>{
  let args:unknown[]=[];
  return {bind(...v:unknown[]){args=v;return this;},
   async first<T>(){return (db.prepare(sql).get(...args as [])??null) as T|null;},
   async all<T>(){return {results:db.prepare(sql).all(...args as []) as T[]};},
   async run(){return {meta:{changes:Number(db.prepare(sql).run(...args as []).changes)}};}};
 };
 const m=await cloudflareActionManifest('litterbox');
 const {plan}=await compilePlan({version:1,name:'Litterbox manual native',inputs:{},steps:[
  {id:'upload',uses:'action.run',with:{executor:'cloudflare',
   provider:'litterbox',action:'litterbox.upload_file',
   contract_digest:m.contract_digest,
   input:Object.fromEntries(['file_name','size_bytes','sha256','time'].map(k=>[k,{ref:'inputs.'+k}]))}},
 ]});
 const published={...plan,cloudflare_execution_approved:true,
  cloudflare_action_approvals:[{executor:'cloudflare',provider:'litterbox',
   action:m.action,contract_digest:m.contract_digest,deployment_id:VERSION}]};
 db.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,'active',1,1)")
 .run(WF,'test','{}');
 db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,1)")
 .run(VERSION,WF,'a'.repeat(64),JSON.stringify(published));
 db.prepare('UPDATE workflows SET active_version_id=? WHERE id=?').run(VERSION,WF);
 db.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,
 start_state,outcome,created_at,updated_at) VALUES(?,?,?,?,?,?,'started','queued',1,1)`)
 .run(RUN,WF,VERSION,RUN,'a'.repeat(64),'{}');
 if(state!=='none'){
  db.prepare(`INSERT INTO cloudflare_action_invocations(run_id,step_id,invocation_id,
  source_attempt_id,input_digest,binding_generation,contract_digest,deployment_id,created_at)
  VALUES(?,?,?,?,?,0,?,?,1)`)
  .run(RUN,'upload','44444444-4444-4444-8444-444444444444',
   '44444444-4444-4444-8444-444444444444','a'.repeat(64),m.contract_digest,VERSION);
  const url='https://litter.catbox.moe/fixture.txt';
  db.prepare('INSERT INTO run_steps(run_id,step_id,status,output,error_code,updated_at) VALUES(?,?,?,?,?,1)')
   .run(RUN,'upload',state,state==='succeeded'?JSON.stringify({status:'accepted',download_url:url}):null,
    state==='indeterminate'?'litterbox_outcome_unknown':null);
 }
 let waits=0,dispatch=0;
 const step={async do(){dispatch++;throw Error('native file dispatcher is forbidden');},
  async waitForEvent(){waits++;throw Error('timeout');}} as unknown as WorkflowStep;
 const env={DB:{prepare},ACTIONS:{async execute(){dispatch++;throw Error('forbidden');}}} as unknown as Env;
 await new WorkflowOrchestrator({} as ExecutionContext,env).run(
  {payload:{run_id:RUN}} as WorkflowEvent<{run_id:string}>,step);
 const end=db.prepare('SELECT outcome,result,error_code FROM runs WHERE id=?').get(RUN) as
  {outcome:string;result:string|null;error_code:string|null};
 return {end,waits,dispatch};
}
test('native Workflow consumes accepted D1 file receipt; never dispatches or waits again',async t=>{
 const a=await scenario(t,'succeeded');
 assert.equal(a.end.outcome,'succeeded');
 assert.equal(a.dispatch,0);assert.equal(a.waits,0);
 assert.equal(JSON.parse(a.end.result!).download_url,'https://litter.catbox.moe/fixture.txt');
});
test('native Workflow preserves unknown external effect and never retries upload',async t=>{
 const a=await scenario(t,'indeterminate');
 assert.equal(a.end.outcome,'indeterminate');
 assert.equal(a.dispatch,0);assert.equal(a.waits,0);
});
test('without any file submission, native event expiry fails without POST',async t=>{
 const a=await scenario(t,'none');
 assert.equal(a.end.outcome,'failed');assert.equal(a.dispatch,0);assert.equal(a.waits,1);
});
