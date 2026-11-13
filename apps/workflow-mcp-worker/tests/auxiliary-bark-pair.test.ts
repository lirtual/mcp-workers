import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePlan,auxiliaryBarkStepId,type Plan} from '../src/plan.ts';
import {settleVerifiedAuxiliaryBusiness} from '../src/auxiliary-bark-recovery.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';

async function candidate(kind:'dub'|'envshare'|'litterbox') {
 const business=await cloudflareActionManifest(kind);
 const bark=await cloudflareActionManifest('bark');
 const name=kind==='dub'?'short-link':kind==='envshare'?'secure-share':'temporary-file';
 const input=kind==='dub'?{url:{ref:'inputs.url'}}:kind==='envshare'?
   {encrypted:{ref:'inputs.encrypted'},iv:{ref:'inputs.iv'},ttl:{ref:'inputs.ttl'},reads:{ref:'inputs.reads'}}:
   {file_name:{ref:'inputs.file_name'},size_bytes:{ref:'inputs.size_bytes'},sha256:{ref:'inputs.sha256'},time:{ref:'inputs.time'}};
 return {version:1,name,steps:[
  {id:'business',uses:'action.run',with:{executor:'cloudflare',provider:kind,
    action:business.action,contract_digest:business.contract_digest,input}},
  {id:'notify',uses:'action.run',needs:['business'],with:{executor:'cloudflare',
    provider:'bark',action:bark.action,contract_digest:bark.contract_digest,
    input:{notification:{body:'Completed'}}}},
 ]};
}

test('three reviewed manual business → Bark pairs compile with separate dependencies',async()=>{
 for(const kind of ['dub','envshare','litterbox'] as const){
  const raw=await candidate(kind);
  const result=await compilePlan(raw);
  assert.deepEqual(result.plan.steps.map(s=>s.needs),[[],['business']]);
 }
});
test('paired business actions reject extra effects, unrelated dependencies and event triggers',async()=>{
 for(const kind of ['dub','envshare','litterbox'] as const){
  const raw=await candidate(kind);
  for(const mutate of [
   (p:any)=>{p.steps.push({...p.steps[1],id:'third'});},
   (p:any)=>{p.steps[1].needs=[];},
   (p:any)=>{p.steps[1].with.input.notification.url='https://evil.example';},
   (p:any)=>{p.triggers=[{type:'cron',schedule:'0 9 * * *'}];},
  ]){const modified=structuredClone(raw);mutate(modified);
   await assert.rejects(compilePlan(modified));}
 }
});

import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {runBarkAction} from '../src/bark-action-executor.ts';
import type {Env} from '../src/store.ts';
const runId='11111111-1111-4111-8111-111111111111';
const version='33333333-3333-4333-8333-333333333333';
async function fixture(t:test.TestContext,kind:'dub'|'envshare'|'litterbox',trusted=true){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT,inputs TEXT,result TEXT,error_code TEXT,updated_at INTEGER);");
 sql.exec("CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT,output TEXT,error_code TEXT,updated_at INTEGER,PRIMARY KEY(run_id,step_id));");
 for(const file of ['0013_cloudflare_action_invocations.sql','0018_cloudflare_action_migration_fence.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const raw=await candidate(kind);
 const plan=(await compilePlan(raw)).plan;
 const business=await cloudflareActionManifest(kind),bark=await cloudflareActionManifest('bark');
 plan.cloudflare_execution_approved=true;
 plan.cloudflare_action_approvals=[business,bark].map(m=>({executor:'cloudflare' as const,provider:m.provider,
  action:m.action,contract_digest:m.contract_digest,deployment_id:version}));
 const outputs={dub:{status:'accepted',short_link:'https://dub.sh/abcXYZ'},
  envshare:{status:'accepted',share_id:'123456789ABCDEFG'},
  litterbox:{status:'accepted',download_url:'https://litterbox.catbox.moe/file.zip'}};
 const inputs=kind==='dub'?{url:'https://example.com'}:kind==='envshare'?{ttl:86400,reads:2,key_digest:'x'}:
  {time:'24h',file_name:'file.zip'};
 sql.prepare('INSERT INTO runs(id,outcome,inputs) VALUES(?,?,?)').run(runId,'running',JSON.stringify(inputs));
 sql.prepare('INSERT INTO run_steps(run_id,step_id,status,output) VALUES(?,?,?,?)').run(runId,'business',trusted?'succeeded':'failed',JSON.stringify(outputs[kind]));
 sql.prepare('INSERT INTO cloudflare_action_invocations VALUES(?,?,?,?,?,?,?,?,?)').run(
  runId,'business','22222222-2222-4222-8222-222222222222','source','digest',0,business.contract_digest,version,1);
 const prepare=(query:string)=>{
  const bound=(args:unknown[])=>({
   first:async<T>()=>(sql.prepare(query).get(...(args as []))??null) as T|null,
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...(args as [])).changes)}}),
  });
  return {...bound([]),bind:(...args:unknown[])=>bound(args)};
 };
 let sends=0,notification:Record<string,unknown>|undefined;
 const env={DB:{prepare},ACTIONS:{
  getContract:async()=>({deployment_id:version,contract_digest:bark.contract_digest}),
  execute:async(_action:string,input:any)=>{
   sends++;notification=input.notification;
   return {status:'accepted',input_digest:input.input_digest};
  },
 }} as unknown as Env;
 const ctx={inputs:{},steps:{business:{status:'succeeded',output:{status:'accepted',short_link:'https://evil.example'}}}};
 const call=()=>runBarkAction(env,plan,plan.steps[1]!,runId,ctx);
 return {call,sends:()=>sends,notification:()=>notification,sql,env,plan};
}
test('Bark uses only same-run persisted business receipts, not injected Step output; sends once',async t=>{
 for(const kind of ['dub','envshare','litterbox'] as const){
  await t.test(kind,async sub=>{
   const f=await fixture(sub,kind);
   assert.equal((await f.call()).status,'succeeded');
   assert.equal((await f.call()).status,'indeterminate');
   assert.equal(f.sends(),1);
   const note=f.notification()!;
   assert.notEqual(note.url,'https://evil.example');
   assert(!JSON.stringify(note).includes('123456789ABCDEFG'));
   if(kind==='envshare')assert(!Object.hasOwn(note,'url'));
   if(kind==='litterbox')assert.equal(note.url,'https://litterbox.catbox.moe/file.zip');
   if(kind==='dub')assert.equal(note.url,'https://dub.sh/abcXYZ');
  });
 }
});
test('Bark cannot send when source business Step is failed, even if Context claims success',async t=>{
 for(const kind of ['dub','envshare','litterbox'] as const){
  const f=await fixture(t,kind,false);
  assert.equal((await f.call()).status,'failed');
  assert.equal(f.sends(),0);
 }
});

test('native interruption after verified Cloudflare success preserves business result and Bark Unknown without replay',async t=>{
 for(const kind of ['dub','envshare','litterbox'] as const){
  await t.test(kind,async sub=>{
   const f=await fixture(sub,kind);
   assert.equal(auxiliaryBarkStepId(f.plan),'notify');
   assert.equal(await settleVerifiedAuxiliaryBusiness(f.env.DB,f.plan,runId),true);
   const row=f.sql.prepare('SELECT outcome,result,error_code FROM runs').get() as any;
   assert.equal(row.outcome,'succeeded');
   assert.equal(JSON.parse(row.result).status,'accepted');
   assert.equal(row.error_code,null);
   const bark=f.sql.prepare("SELECT status,error_code FROM run_steps WHERE step_id='notify'").get() as any;
   assert.equal(bark.status,'indeterminate');
   assert.equal(bark.error_code,'bark_outcome_unconfirmed');
   assert.equal(f.sends(),0,'recovering is read-only with respect to Provider');
   assert.equal(await settleVerifiedAuxiliaryBusiness(f.env.DB,f.plan,runId),true);
   assert.equal(f.sends(),0);
  });
 }
});
test('native recovery fails closed without trusted business proof and never overwrites cancellation',async t=>{
 const f=await fixture(t,'dub',false);
 assert.equal(await settleVerifiedAuxiliaryBusiness(f.env.DB,f.plan,runId),false);
 assert.equal((f.sql.prepare('SELECT outcome FROM runs').get() as any).outcome,'running');
 f.sql.prepare("UPDATE run_steps SET status='succeeded' WHERE step_id='business'").run();
 f.sql.prepare("UPDATE cloudflare_action_invocations SET contract_digest='wrong' WHERE step_id='business'").run();
 assert.equal(await settleVerifiedAuxiliaryBusiness(f.env.DB,f.plan,runId),false);
 f.sql.prepare("UPDATE cloudflare_action_invocations SET contract_digest=? WHERE step_id='business'").run((await cloudflareActionManifest('dub')).contract_digest);
 f.sql.prepare("UPDATE runs SET outcome='cancelled' WHERE id=?").run(runId);
 assert.equal(await settleVerifiedAuxiliaryBusiness(f.env.DB,f.plan,runId),false);
 assert.equal((f.sql.prepare('SELECT outcome FROM runs').get() as any).outcome,'cancelled');
});
test('the three new Session + Bark Plans are isolated, historical Chrome remains unchanged',async()=>{
 for(const [name,path] of [['ubuntu','ubuntu'],['windows','windows'],['code-server','code-server'],['chrome','chrome']] as const){
  const identity={repository:'autoactions/github-actions',repositoryId:10,workflowId:22,
    workflowPath:'.github/workflows/'+path+'.yml',commitSha:'a'.repeat(40),
    type:'session' as const,contractDigest:'b'.repeat(64)};
  const plan={version:1,name,steps:[
   {id:'business',uses:'github.run',needs:[],with:{capability:'github.action',action:{...identity,ref:'refs/heads/main'}}},
   {id:'notify',uses:'action.run',needs:['business'],with:{executor:'cloudflare',provider:'bark',
     action:'bark.send_notification',input:{session_step_id:'business',notification:{body:'Completed'}}}},
  ]} as unknown as Plan;
  assert.equal(auxiliaryBarkStepId(plan),name==='chrome'?null:'notify');
  const injected=structuredClone(plan);(injected.steps[1]!.with.input as Record<string,unknown>).notification={body:'other'};
  assert.equal(auxiliaryBarkStepId(injected),null);
 }
});
test('recovery requires the exact owned signed Ready attempt for Session business',async t=>{
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT,result TEXT,error_code TEXT,updated_at INTEGER)');
 sql.exec('CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT,output TEXT,error_code TEXT,updated_at INTEGER,PRIMARY KEY(run_id,step_id))');
 sql.exec('CREATE TABLE step_attempts(run_id TEXT,step_id TEXT,capability_id TEXT,candidate_run_id INTEGER,candidate_run_attempt INTEGER,owner_run_id INTEGER,owner_run_attempt INTEGER)');
 sql.prepare('INSERT INTO runs(id,outcome) VALUES(?,?)').run(runId,'running');
 sql.prepare('INSERT INTO run_steps(run_id,step_id,status,output) VALUES(?,?,?,?)').run(runId,'business','succeeded',JSON.stringify({session:{recorded_state:'ready',private_hostname:'session-ubuntu',github_run_id:42}}));
 const identity={repository:'autoactions/github-actions',repositoryId:10,workflowId:22,
  workflowPath:'.github/workflows/ubuntu.yml',commitSha:'a'.repeat(40),
  type:'session' as const,contractDigest:'b'.repeat(64)};
 const plan={version:1,name:'ubuntu',steps:[
  {id:'business',uses:'github.run',needs:[],with:{capability:'github.action',action:identity}},
  {id:'notify',uses:'action.run',needs:['business'],with:{executor:'cloudflare',provider:'bark',action:'bark.send_notification',input:{session_step_id:'business',notification:{body:'Completed'}}}},
 ],github_execution_approved:true,github_action_approvals:[identity]} as unknown as Plan;
 const prepare=(query:string)=>{const bound=(args:unknown[])=>({
  first:async<T>()=>(sql.prepare(query).get(...(args as []))??null) as T|null,
  run:async()=>({meta:{changes:Number(sql.prepare(query).run(...(args as [])).changes)}}),
 });return {...bound([]),bind:(...args:unknown[])=>bound(args)};};
 const db={prepare} as unknown as D1Database;
 assert.equal(await settleVerifiedAuxiliaryBusiness(db,plan,runId),false);
 sql.prepare('INSERT INTO step_attempts VALUES(?,?,?,?,?,?,?)').run(runId,'business','github.action',42,1,43,1);
 assert.equal(await settleVerifiedAuxiliaryBusiness(db,plan,runId),false);
 sql.prepare('UPDATE step_attempts SET owner_run_id=42').run();
 assert.equal(await settleVerifiedAuxiliaryBusiness(db,plan,runId),true);
 assert.equal((sql.prepare('SELECT outcome FROM runs').get() as any).outcome,'succeeded');
});
