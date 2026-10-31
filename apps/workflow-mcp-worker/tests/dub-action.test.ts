import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {compilePlan} from '../src/plan.ts';
import {canonical,cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {runPublishedCloudflareAction} from '../src/cloudflare-action-executor.ts';
import type {Env} from '../src/store.ts';
import type {Plan,Step} from '../src/plan.ts';
const runId='11111111-1111-4111-8111-111111111111';
const version='33333333-3333-4333-8333-333333333333';
const url='https://example.org/file?key=private-query&n=2';
async function spec(){
 const manifest=await cloudflareActionManifest('dub');
 const step:Step={id:'shorten',uses:'action.run',needs:[],with:{
  executor:'cloudflare',provider:'dub',action:'dub.shorten_url',contract_digest:manifest.contract_digest,
  input:{url:{ref:'inputs.url'},public_stats:false}}};
 const def:Plan={version:1,name:'Explicit manual Dub',inputs:{},steps:[step]};
 const plan:Plan={...def,cloudflare_execution_approved:true,
  cloudflare_action_approvals:[{executor:'cloudflare',provider:'dub',action:manifest.action,
   contract_digest:manifest.contract_digest,deployment_id:version}]};
 return {manifest,step,def,plan};
}
test('compiler requires manual-only, explicit URL input reference, and reviewed manifest',async()=>{
 const {def}=await spec();
 assert.equal((await compilePlan(def)).plan.steps[0]?.with.provider,'dub');
 for(const mutate of [
  (p:Plan)=>{p.triggers=[{type:'cron',schedule:'* * * * *'}];},
  (p:Plan)=>{(p.steps[0]!.with.input as any).url='https://example.org/?secret=x';},
  (p:Plan)=>{(p.steps[0]!.with.input as any).url={ref:'steps.source.output'};},
  (p:Plan)=>{(p.steps[0]!.with.input as any).public_stats={ref:'inputs.stats'};},
  (p:Plan)=>{p.steps[0]!.with.contract_digest='0'.repeat(64);},
  (p:Plan)=>{p.steps[0]!.with.input={url:{ref:'inputs.url'},recipient:'evil'};},
 ]){const copy=structuredClone(def);mutate(copy);await assert.rejects(compilePlan(copy));}
});
async function fixture(t:test.TestContext){
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec("CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT NOT NULL);");
 sql.exec("INSERT INTO runs(id,outcome) VALUES('11111111-1111-4111-8111-111111111111','running')");
 sql.exec(readFileSync(new URL('../migrations/0013_cloudflare_action_invocations.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('../migrations/0018_cloudflare_action_migration_fence.sql',import.meta.url),'utf8'));
 const prepare=(query:string)=>{const bound=(args:unknown[])=>({
  first:async<T>()=>(sql.prepare(query).get(...args as [])??null) as T|null,
  run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args as []).changes)}}),
 });return {...bound([]),bind:(...args:unknown[])=>bound(args)};};
 const {plan,step,manifest}=await spec();
 let sends=0,uncertain=false;
 const provider={getContract:async()=>({deployment_id:version,contract_digest:manifest.contract_digest}),
  execute:async(_id:string,input:any)=>{
   sends++;assert.equal(input.url,url);assert.equal(input.public_stats,false);
   if(uncertain)throw Error('response lost');
   return {status:'accepted',input_digest:input.input_digest,short_link:'https://dub.sh/AbC123'};
  }};
 const env={DB:{prepare},ACTIONS:provider,ACTIONS_DEPLOYMENT_ID:version} as unknown as Env;
 const ctx={inputs:{url},steps:{}};
 const run=()=>runPublishedCloudflareAction(env,plan,step,runId,undefined,ctx);
 return {sql,plan,step,env,ctx,run,sends:()=>sends,uncertain:()=>{uncertain=true}};
}
test('single admitted manual Dub create, second entry is unknown without resend',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.run(),{status:'succeeded',output:{status:'accepted',short_link:'https://dub.sh/AbC123'}});
 assert.equal((await f.run()).status,'indeterminate');assert.equal(f.sends(),1);
 const row=f.sql.prepare('SELECT * FROM cloudflare_action_invocations').get();
 assert.equal((row as any).binding_generation,0);
 assert(!JSON.stringify(row).includes('private-query'));
});
test('unapproved version, malformed URL, canceled Run and frozen gate prevent POST',async t=>{
 const f=await fixture(t);
 delete f.plan.cloudflare_execution_approved;
 assert.equal((await f.run()).status,'failed');
 f.plan.cloudflare_execution_approved=true;
 f.ctx.inputs.url='https://me:pw@example.org/';
 assert.equal((await f.run()).status,'failed');f.ctx.inputs.url=url;
 f.env.ACTIONS_DEPLOYMENT_ID='44444444-4444-4444-8444-444444444444';
 assert.equal((await f.run()).status,'failed');f.env.ACTIONS_DEPLOYMENT_ID=version;
 f.sql.prepare("UPDATE cloudflare_action_gate SET state='frozen' WHERE id=1").run();
 assert.equal((await f.run()).status,'failed');
 f.sql.prepare("UPDATE cloudflare_action_gate SET state='open' WHERE id=1").run();
 f.sql.prepare("INSERT INTO cloudflare_action_cancellations(run_id,step_id,created_at) VALUES(?,'shorten',1)").run(runId);
 assert.equal((await f.run()).status,'failed');assert.equal(f.sends(),0);
});
test('lost response and parallel competitors cannot repeat a third-party create',async t=>{
 const f=await fixture(t);f.uncertain();
 const outcomes=await Promise.all(Array.from({length:5},()=>f.run()));
 assert(outcomes.every(x=>x.status==='indeterminate'));
 assert.equal(f.sends(),1);
 assert.equal((await f.run()).status,'indeterminate');assert.equal(f.sends(),1);
});
test('provider and consumer share exact immutable Dub digest',async()=>{
 const {manifest}=await spec();
 assert.equal(manifest.contract_digest,'7affc30ef28efc869a264e6ad5b7bc86226991a15be5d59f5447f0ad26919a20');
 assert.equal(manifest.service,'cloudflare-actions');
 assert.equal(manifest.entrypoint,'ActionsEntrypoint');
 assert.equal(typeof canonical(manifest),'object');
});
