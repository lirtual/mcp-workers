import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {compilePlan} from '../src/plan.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {runBarkAction} from '../src/bark-action-executor.ts';
import type {Plan,Step} from '../src/plan.ts';
import type {Env} from '../src/store.ts';
const runId='11111111-1111-4111-8111-111111111111';
const version='33333333-3333-4333-8333-333333333333';
const ctx={inputs:{message:'private'},steps:{source:{status:'succeeded',output:{id:42,ok:true}}}};
async function sample(){
 const manifest=await cloudflareActionManifest('bark');
 const action:Step={id:'notify',uses:'action.run',needs:['source'],with:{
  executor:'cloudflare',provider:'bark',action:'bark.send_notification',
  contract_digest:manifest.contract_digest,
  input:{notification:{body:{ref:'steps.source.output'},title:'Done'}}}};
 const plan:Plan={version:1,name:'Bark',steps:[
  {id:'source',uses:'result.emit',needs:[],with:{data:{id:42,ok:true}}},action],
  cloudflare_execution_approved:true,
  cloudflare_action_approvals:[{executor:'cloudflare',provider:'bark',
   action:'bark.send_notification',contract_digest:manifest.contract_digest,deployment_id:version}]};
 return {manifest,action,plan};
}
test('compiler permits only explicit dependent result and reviewed Bark contract',async()=>{
 const {plan:published}=await sample();
 const plan=structuredClone(published);
 delete plan.cloudflare_execution_approved;
 delete plan.cloudflare_action_approvals;
 assert.equal((await compilePlan(plan)).plan.steps[1]?.uses,'action.run');
 for(const modify of [
  (p:Plan)=>{(p.steps[1]!.with.input as any).notification.body={ref:'steps.unselected.output'};},
  (p:Plan)=>{p.steps[1]!.needs=[];},
  (p:Plan)=>{(p.steps[1]!.with.input as any).notification.device_key='another';},
  (p:Plan)=>{p.steps[1]!.with.contract_digest='0'.repeat(64);},
  (p:Plan)=>{(p.steps[1]!.with.input as any).notification.url='http://unsafe.example';},
 ]){
  const changed=structuredClone(plan);modify(changed);
  // The URL bound is an input schema/runtime concern; compiler only parses references,
  // static unknown targets and fields, while Provider enforces HTTPS.
  if((changed.steps[1]!.with.input as any).notification.url){
   await compilePlan(changed);
  }else await assert.rejects(compilePlan(changed));
 }
});
async function fixture(t:test.TestContext){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT NOT NULL);");
 sql.exec("INSERT INTO runs(id,outcome) VALUES('11111111-1111-4111-8111-111111111111','running')");
 sql.exec(readFileSync(new URL('../migrations/0013_cloudflare_action_invocations.sql',import.meta.url),'utf8'));
 const prepare=(query:string)=>{
  const bound=(args:unknown[])=>({
   first:async<T>()=>(sql.prepare(query).get(...(args as []))??null) as T|null,
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...(args as [])).changes)}}),
  });
  return {...bound([]),bind:(...args:unknown[])=>bound(args)};
 };
 const {manifest,action,plan}=await sample();
 let sent=0;
 const provider={
  getContract:async()=>({deployment_id:version,contract_digest:manifest.contract_digest}),
  sendNotification:async(input:any)=>{
   sent++;assert.equal(input.notification.title,'Done');
   assert.equal(input.notification.body,'{"id":42,"ok":true}');
   return {status:'accepted',input_digest:input.input_digest};
  },
 };
 const env={DB:{prepare},BARK_ACTION_PROVIDER:provider,BARK_ACTION_DEPLOYMENT_ID:version} as unknown as Env;
 return {sql,action,plan,env,sent:()=>sent};
}
test('one persisted Bark dispatch; repeat is unknown and never calls getReceipt',async t=>{
 const f=await fixture(t);
 const first=await runBarkAction(f.env,f.plan,f.action,runId,ctx);
 assert.deepEqual(first,{status:'succeeded',output:{status:'accepted'}});
 const second=await runBarkAction(f.env,f.plan,f.action,runId,ctx);
 assert.equal(second.status,'indeterminate');
 assert.equal(f.sent(),1);
 const row=f.sql.prepare('SELECT * FROM cloudflare_action_invocations').get()!;
 assert.equal(row.binding_generation,0);
 assert(!JSON.stringify(row).includes('private'));
 assert(!JSON.stringify(row).includes('Done'));
});
test('parallel contenders and cancellation are fenced before external send',async t=>{
 const f=await fixture(t);
 const outcomes=await Promise.all(Array.from({length:8},()=>
  runBarkAction(f.env,f.plan,f.action,runId,ctx)));
 assert.equal(f.sent(),1);
 assert(outcomes.every(x=>['succeeded','indeterminate'].includes(x.status)));
 const another=await fixture(t);
 another.sql.prepare('INSERT INTO cloudflare_action_cancellations VALUES(?,?,1)').run(runId,'notify');
 const denied=await runBarkAction(another.env,another.plan,another.action,runId,ctx);
 assert.equal(denied.status,'failed');assert.equal(another.sent(),0);
});
test('unapproved, changed version and unresolvable content fail closed',async t=>{
 const f=await fixture(t);
 delete f.plan.cloudflare_execution_approved;
 assert.equal((await runBarkAction(f.env,f.plan,f.action,runId,ctx)).status,'failed');
 f.plan.cloudflare_execution_approved=true;
 const unresolved={inputs:{},steps:{source:{status:'succeeded'}}};
 assert.equal((await runBarkAction(f.env,f.plan,f.action,runId,unresolved)).status,'failed');
 assert.equal(f.sent(),0);
});

test('after persisted send, version drift and lost ACK remain unknown without retry',async t=>{
 const f=await fixture(t);
 const first=await runBarkAction(f.env,f.plan,f.action,runId,ctx);
 assert.equal(first.status,'succeeded');
 f.env.BARK_ACTION_DEPLOYMENT_ID='44444444-4444-4444-8444-444444444444';
 assert.equal((await runBarkAction(f.env,f.plan,f.action,runId,ctx)).status,'indeterminate');
 assert.equal(f.sent(),1);
 const other=await fixture(t);
 let attempts=0;
 other.env.BARK_ACTION_PROVIDER={
  getContract:async()=>({deployment_id:version,contract_digest:(await cloudflareActionManifest('bark')).contract_digest}),
  sendNotification:async()=>{attempts++;throw Error('lost ACK');},
 };
 assert.equal((await runBarkAction(other.env,other.plan,other.action,runId,ctx)).status,'indeterminate');
 assert.equal((await runBarkAction(other.env,other.plan,other.action,runId,ctx)).status,'indeterminate');
 assert.equal(attempts,1);
});

test('D1 reservation failure prevents every Bark side effect',async t=>{
 const f=await fixture(t);
 const originalDB=f.env.DB;
 f.env.DB={prepare:(sql:string)=>{
  if(sql.startsWith('INSERT OR IGNORE INTO cloudflare_action_invocations'))
   throw Error('simulated durable reservation failure');
  return originalDB.prepare(sql);
 }} as any;
 const result=await runBarkAction(f.env,f.plan,f.action,runId,ctx);
 assert.equal(result.status,'indeterminate');
 assert.equal(f.sent(),0);
 assert.equal((f.sql.prepare('SELECT COUNT(*) AS n FROM cloudflare_action_invocations').get() as any).n,0);
});
test('provider identity or pinned version mismatch cannot consume a fence or dispatch',async t=>{
 const f=await fixture(t);
 f.env.BARK_ACTION_PROVIDER={
  getContract:async()=>({deployment_id:'44444444-4444-4444-8444-444444444444',
   contract_digest:f.action.with.contract_digest}),
  sendNotification:async()=>{throw Error('must not dispatch');},
 } as any;
 const result=await runBarkAction(f.env,f.plan,f.action,runId,ctx);
 assert.equal(result.status,'failed');
 assert.equal(f.sent(),0);
 assert.equal((f.sql.prepare('SELECT COUNT(*) AS n FROM cloudflare_action_invocations').get() as any).n,0);
 const other=await fixture(t);
 other.env.BARK_ACTION_DEPLOYMENT_ID='44444444-4444-4444-8444-444444444444';
 assert.equal((await runBarkAction(other.env,other.plan,other.action,runId,ctx)).status,'failed');
 assert.equal(other.sent(),0);
});
test('a rejected or ambiguous Provider reply is terminal for the same invocation',async t=>{
 for(const response of ['rejected','unknown'] as const){
  const f=await fixture(t);
  let sends=0;
  f.env.BARK_ACTION_PROVIDER={
   getContract:async()=>({deployment_id:version,
    contract_digest:(await cloudflareActionManifest('bark')).contract_digest}),
   sendNotification:async(input:any)=>{sends++;
    return {status:response,input_digest:input.input_digest};},
  } as any;
  const first=await runBarkAction(f.env,f.plan,f.action,runId,ctx);
  assert.equal(first.status,response==='rejected'?'failed':'indeterminate');
  assert.equal((await runBarkAction(f.env,f.plan,f.action,runId,ctx)).status,'indeterminate');
  assert.equal(sends,1);
 }
});
