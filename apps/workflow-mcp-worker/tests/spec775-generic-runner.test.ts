import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {runPublishedCloudflareAction} from '../src/cloudflare-action-executor.ts';
import {canonical} from '../src/cloudflare-action-contract.ts';
import type {Env} from '../src/store.ts';
import type {Plan,Step} from '../src/plan.ts';
const runId='11111111-1111-4111-8111-111111111111';
const deployment='22222222-2222-4222-8222-222222222222';
const manifest={executor:'cloudflare',provider:'json',action:'json.report',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint',
 side_effect:'none',input_schema:{type:'object',additionalProperties:false,
 required:['message'],properties:{message:{type:'string',maxLength:100}}},
 output_schema:{type:'object',additionalProperties:false,
 required:['status'],properties:{status:{enum:['accepted','rejected','unknown']},report_id:{type:'string',maxLength:32}}}};
const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
 new TextEncoder().encode(JSON.stringify(canonical(manifest))))),b=>b.toString(16).padStart(2,'0')).join('');
async function setup(t:test.TestContext){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT NOT NULL);');
 db.exec("INSERT INTO runs(id,outcome) VALUES('"+runId+"','running')");
 db.exec(readFileSync(new URL('../migrations/0013_cloudflare_action_invocations.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0018_cloudflare_action_migration_fence.sql',import.meta.url),'utf8'));
 const prepare=(sql:string)=>{const f=(args:unknown[])=>({
   first:async<T>()=>(db.prepare(sql).get(...args as [])??null) as T|null,
   run:async()=>({meta:{changes:Number(db.prepare(sql).run(...args as []).changes)}}),
 });return {...f([]),bind:(...args:unknown[])=>f(args)};};
 let posts=0,unknown=false,leak=false;
 const env={DB:{prepare},ACTIONS:{
  getContract:async()=>({deployment_id:deployment,contract_digest:digest}),
  execute:async(_name:string,payload:any)=>{posts++;if(unknown)throw Error('lost Ack');
    assert.equal(payload.message,'hello');return {status:'accepted',input_digest:payload.input_digest,report_id:'report-123',...(leak?{secret:'not-declared'}:{})};
  }}} as unknown as Env;
 const step:Step={id:'report',uses:'action.run',needs:[],with:{executor:'cloudflare',
 provider:'json',action:'json.report',contract_digest:digest,input:{message:'hello'}}};
 const plan:Plan={version:1,name:'report',steps:[step],cloudflare_execution_approved:true,
 cloudflare_action_contracts:{report:{...manifest,contract_digest:digest}},
 cloudflare_action_approvals:[{executor:'cloudflare',provider:'json',action:'json.report',
 contract_digest:digest,deployment_id:deployment}]};
 return {db,env,step,plan,posts:()=>posts,unknown:()=>{unknown=true;},leak:()=>{leak=true;},
 run:()=>runPublishedCloudflareAction(env,plan,step,runId)};
}
test('reviewed side effect runs once under its Grant and fails closed without it',async t=>{
 const f=await setup(t);
 const contracts=f.plan.cloudflare_action_contracts;
 const approvals=f.plan.cloudflare_action_approvals;
 const actions=f.env.ACTIONS;
 if(!contracts||!approvals||!actions)throw Error('fixture');
 contracts.report.side_effect='record_audited_marker';
 const marked=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical({
  ...manifest,side_effect:'record_audited_marker'}))));
 const markedDigest=Array.from(new Uint8Array(marked),x=>x.toString(16).padStart(2,'0')).join('');
 contracts.report.contract_digest=markedDigest;
 f.step.with.contract_digest=markedDigest;
 approvals[0].contract_digest=markedDigest;
 actions.getContract=async()=>({deployment_id:deployment,contract_digest:markedDigest});
 assert.equal((await f.run()).status,'succeeded');
 f.plan.cloudflare_action_approvals=[];
 assert.equal((await f.run()).status,'failed');
 f.plan.cloudflare_action_approvals=[{executor:'cloudflare',provider:'json',action:'json.report',
  contract_digest:markedDigest,deployment_id:deployment}];
 contracts.report.side_effect='exfiltrate_owner_data';
 assert.equal((await f.run()).status,'failed');
 assert.equal(f.posts(),1);
});
test('ordinary JSON Action dispatches exactly once with durable fence',async t=>{
 const f=await setup(t);
 assert.deepEqual(await f.run(),{status:'succeeded',output:{status:'accepted',report_id:'report-123'}});
 assert.equal((await f.run()).status,'indeterminate');
 assert.equal(f.posts(),1);
 assert.equal((f.db.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations').get() as any).n,1);
});
test('wrong grant, contract drift, frozen gate, unknown receipt do not retry',async t=>{
 const f=await setup(t);
 f.plan.cloudflare_action_approvals=[];
 assert.equal((await f.run()).status,'failed');
 f.plan.cloudflare_action_approvals=[{executor:'cloudflare',provider:'json',
 action:'json.report',contract_digest:digest,deployment_id:deployment}];
 f.db.exec("UPDATE cloudflare_action_gate SET state='frozen' WHERE id=1");
 assert.equal((await f.run()).status,'failed');
 f.db.exec("UPDATE cloudflare_action_gate SET state='open' WHERE id=1");
 f.unknown();
 assert.equal((await f.run()).status,'indeterminate');
 assert.equal((await f.run()).status,'indeterminate');
 assert.equal(f.posts(),1);
});

test('unreviewed Provider output is not exposed, and variable input is resolved at dispatch',async t=>{
 const f=await setup(t);
 f.step.with.input={message:{ref:'inputs.message'}};
 f.leak();
 assert.equal((await runPublishedCloudflareAction(f.env,f.plan,f.step,runId,undefined,
   {inputs:{message:'hello'},steps:{}})).status,'indeterminate');
 assert.equal(f.posts(),1);
});

async function largerInputFixture(t:test.TestContext){
 const f=await setup(t);
 const extended={...manifest,max_input_bytes:24576,error_codes:['E_REJECTED','E_UNKNOWN'],
  input_schema:{...manifest.input_schema,properties:{message:{type:'string'}}},
  output_schema:{...manifest.output_schema,required:['status','report_id'],
   properties:{status:{enum:['accepted']},report_id:{type:'string',minLength:1}}}};
 const pin=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
   new TextEncoder().encode(JSON.stringify(canonical(extended))))),x=>x.toString(16).padStart(2,'0')).join('');
 f.plan.cloudflare_action_contracts={report:{...extended,contract_digest:pin}};
 f.plan.cloudflare_action_approvals=[{executor:'cloudflare',provider:'json',action:'json.report',contract_digest:pin,deployment_id:deployment}];
 f.step.with.contract_digest=pin;
 f.step.with.input={message:{ref:'inputs.message'}};
 const api=f.env.ACTIONS!;
 api.getContract=async()=>({deployment_id:deployment,contract_digest:pin});
 let calls=0;
 const receipts=(make:(payload:any)=>any)=>{api.execute=async(_action,payload)=>{calls++;return make(payload);};};
 return {...f,receipts,calls:()=>calls,runWith:(message:string)=>runPublishedCloudflareAction(f.env,f.plan,f.step,runId,undefined,{inputs:{message},steps:{}})};
}
test('large resolved input uses reviewed input budget, output remains capped, and reservation is single use',async t=>{
 const f=await largerInputFixture(t);
 f.receipts(p=>{assert.equal(p.message,'中文'.repeat(4000));return {status:'accepted',input_digest:p.input_digest,report_id:'x'.repeat(4096)};});
 assert.equal((await f.runWith('中'.repeat(8192))).status,'failed');
 assert.equal(f.calls(),0);
 assert.deepEqual(await f.runWith('中文'.repeat(4000)),{status:'indeterminate',error_code:'cloudflare_output_unreviewed'});
 assert.equal((await f.runWith('中文'.repeat(4000))).status,'indeterminate');
 assert.equal(f.calls(),1);
});
test('reviewed error receipt retains exact code after matching identity, without replay',async t=>{
 const f=await largerInputFixture(t);
 f.receipts(p=>({status:'rejected',input_digest:p.input_digest,invocation_id:p.invocation_id,deployment_id:p.deployment_id,error_code:'E_REJECTED'}));
 assert.deepEqual(await f.runWith('中文'.repeat(4000)),{status:'failed',error_code:'E_REJECTED'});
 assert.equal((await f.runWith('中文'.repeat(4000))).status,'indeterminate');
 assert.equal(f.calls(),1);
});

test('structured uncertainty, invalid receipts and missing success identifier never replay',async t=>{
 for(const [name,make,expected] of [
  ['known uncertain',(p:any)=>({status:'unknown',input_digest:p.input_digest,invocation_id:p.invocation_id,deployment_id:p.deployment_id,error_code:'E_UNKNOWN'}),'E_UNKNOWN'],
  ['unknown code',(p:any)=>({status:'rejected',input_digest:p.input_digest,invocation_id:p.invocation_id,deployment_id:p.deployment_id,error_code:'unreviewed'}),'cloudflare_outcome_unknown'],
  ['missing identity',(p:any)=>({status:'rejected',input_digest:p.input_digest,error_code:'E_REJECTED'}),'cloudflare_outcome_unknown'],
  ['wrong identity',(p:any)=>({status:'rejected',input_digest:p.input_digest,invocation_id:'wrong',deployment_id:p.deployment_id,error_code:'E_REJECTED'}),'cloudflare_digest_conflict'],
  ['unexpected output',(p:any)=>({status:'rejected',input_digest:p.input_digest,invocation_id:p.invocation_id,deployment_id:p.deployment_id,error_code:'E_REJECTED',body:'private'}),'cloudflare_outcome_unknown'],
  ['malformed code-free rejection',(p:any)=>({status:'rejected',input_digest:p.input_digest,body:'private'}),'cloudflare_outcome_unknown'],
  ['missing id',(p:any)=>({status:'accepted',input_digest:p.input_digest}),'cloudflare_output_unreviewed'],
  ['lost ack',()=>{throw Error('private raw exception');},'cloudflare_outcome_unknown'],
 ] as const)await t.test(name,async t=>{
  const f=await largerInputFixture(t);f.receipts(make);
  assert.deepEqual(await f.runWith('hello'),{status:'indeterminate',error_code:expected});
  assert.equal((await f.runWith('hello')).status,'indeterminate');
  assert.equal(f.calls(),1);
 });
});
test('generic cancellation before reservation prevents any side effect',async t=>{
 const f=await largerInputFixture(t);
 f.db.prepare('INSERT INTO cloudflare_action_cancellations(run_id,step_id,created_at) VALUES(?,?,1)').run(runId,f.step.id);
 assert.deepEqual(await f.runWith('hello'),{status:'failed',error_code:'cloudflare_dispatch_not_admitted'});
 assert.equal(f.calls(),0);
});
