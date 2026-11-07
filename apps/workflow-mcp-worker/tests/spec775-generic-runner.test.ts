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
