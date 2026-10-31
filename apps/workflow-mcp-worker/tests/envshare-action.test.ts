import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createDecipheriv} from 'node:crypto';
import {compilePlan} from '../src/plan.ts';
import {WorkflowService,type Env,StateError} from '../src/store.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {runPublishedCloudflareAction} from '../src/cloudflare-action-executor.ts';
import {fromBase58,checkedSharePayload} from '../src/envshare-secret.ts';
const version='33333333-3333-4333-8333-333333333333';
const secret='private 你好 token';
const id='1'.repeat(16);
async function definition(){
 const m=await cloudflareActionManifest('envshare');
 return {version:1,name:'Manual secret',steps:[{id:'share',uses:'action.run',with:{
  executor:'cloudflare',provider:'envshare',action:m.action,contract_digest:m.contract_digest,
  input:{encrypted:{ref:'inputs.encrypted'},iv:{ref:'inputs.iv'},ttl:86400,reads:1}}}]};
}
test('compiler bans triggers, arbitrary fields, plaintext and complex Plans',async()=>{
 const value=await definition();
 assert.equal((await compilePlan(value)).plan.steps.length,1);
 for(const change of [
  (p:any)=>{p.triggers=[{type:'cron',schedule:'* * * * *'}];},
  (p:any)=>{p.steps.push({id:'emit',uses:'result.emit',with:{data:'x'}});},
  (p:any)=>{p.steps[0].with.input.encrypted='plain';},
  (p:any)=>{p.steps[0].with.input.iv={ref:'inputs.text'};},
  (p:any)=>{p.steps[0].with.input.ttl=0;},
  (p:any)=>{p.steps[0].with.input.extra='key';},
  (p:any)=>{p.steps[0].with.contract_digest='0'.repeat(64);}
 ]){
  const altered=structuredClone(value);change(altered);await assert.rejects(compilePlan(altered));
 }
});
function fixture(t:test.TestContext){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const f of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql','0011_awaited_child_capacity.sql',
  '0013_cloudflare_action_invocations.sql','0018_cloudflare_action_migration_fence.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
 const db={prepare(sql:string){
  let args:any[]=[];return {bind(...v:any[]){args=v;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...args)??null) as T|null;},
   async all<T>(){return {results:sqlite.prepare(sql).all(...args) as T[]};},
   async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};
 },async batch(stmts:any[]){sqlite.exec('BEGIN IMMEDIATE');try{
  const out=[];for(const x of stmts)out.push(await x.run());sqlite.exec('COMMIT');return out;
 }catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 let posts=0,created=0,lost=false;
 const m=cloudflareActionManifest('envshare');
 const env={DB:db,WORKFLOW:{async create(){created++;},
  async get(){return {async status(){return {status:'running'};}};}},
  ACTIONS_DEPLOYMENT_ID:version,ACTIONS:{
   async getContract(){return {deployment_id:version,contract_digest:(await m).contract_digest};},
   async execute(_action:string,input:any){
    posts++;assert.equal(input.text,undefined);assert.equal(input.key,undefined);
    assert(checkedSharePayload({encrypted:input.encrypted,iv:input.iv,ttl:input.ttl,reads:input.reads}));
    if(lost)throw Error('ack lost');
    return {status:'accepted',share_id:id,input_digest:input.input_digest};
   }}} as unknown as Env;
 return {sqlite,env,service:new WorkflowService(env),get posts(){return posts;},
  get created(){return created;},lose(){lost=true;}};
}
async function setup(f:ReturnType<typeof fixture>){
 const draft=await f.service.create(JSON.stringify(await definition()));
 const manifest=await cloudflareActionManifest('envshare');
 await f.service.publish(draft.workflow_id,1,[],false,false,[],[],[{
  executor:'cloudflare',provider:'envshare',action:manifest.action,
  contract_digest:manifest.contract_digest,deployment_id:version}],true);
 return draft.workflow_id;
}
test('admission encrypts before D1, emits one ephemeral key, one POST, authenticates link',async t=>{
 const f=fixture(t),wid=await setup(f);
 await assert.rejects(()=>f.service.start(wid,{text:secret}),/envshare_manual_one_shot_only/);
 const r=await f.service.start(wid,{text:secret},'once');
 const key='envshare_key_base58' in r?r.envshare_key_base58:undefined;
 assert(key);
 assert(key);assert.equal(f.created,1);
 const saved=f.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(r.run_id) as any;
 const inputs=JSON.parse(saved.inputs);
 assert(checkedSharePayload(inputs));
 assert(!JSON.stringify(saved).includes(secret));
 assert(!JSON.stringify(saved).includes(key));
 await assert.rejects(()=>f.service.start(wid,{text:secret},'once'),
  (e:unknown)=>e instanceof StateError&&e.code==='envshare_key_unrecoverable');
 assert.equal(f.created,1);
 await assert.rejects(()=>f.service.start(wid,{text:' '},'bad-text'),
  (e:unknown)=>e instanceof StateError&&e.code==='envshare_invalid_input');
 const plan=JSON.parse((f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
  .get(r.published_version_id) as any).plan);
 f.sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(r.run_id);
 const invoke=()=>runPublishedCloudflareAction(f.env,plan,plan.steps[0],r.run_id,undefined,{inputs,steps:{}});
 const result=await invoke();
 assert.deepEqual(result,{status:'succeeded',output:{status:'accepted',share_id:id}});
 assert.equal((await invoke()).status,'indeterminate');assert.equal(f.posts,1);
 f.sqlite.prepare("INSERT INTO run_steps(run_id,step_id,status,output,updated_at) VALUES(?,'share','succeeded',?,1)")
  .run(r.run_id,JSON.stringify(result.output));
 f.sqlite.prepare("UPDATE runs SET outcome='succeeded',result=? WHERE id=?")
  .run(JSON.stringify(result.output),r.run_id);
 const link=await f.service.envshareLink(r.run_id,key);
 const composite=fromBase58(link.share_url.split('#')[1],64)!;
 assert.equal(composite.length,33);assert.equal(composite[0],2);
 assert.deepEqual(composite.slice(17),fromBase58(key,30));
 const iv=fromBase58(inputs.iv,32)!,enc=fromBase58(inputs.encrypted)!;
 const d=createDecipheriv('aes-128-gcm',composite.slice(17),iv);
 d.setAuthTag(enc.slice(-16));
 assert.equal(Buffer.concat([d.update(enc.slice(0,-16)),d.final()]).toString(),secret);
 assert(!JSON.stringify(f.sqlite.prepare('SELECT * FROM runs').all()).includes(key));
 assert(!JSON.stringify(f.sqlite.prepare('SELECT * FROM run_steps').all()).includes(key));
 await assert.rejects(()=>f.service.envshareLink(r.run_id,'1'.repeat(16)),/envshare_invalid_key_or_result/);
});
test('lost acknowledgement remains unknown; no resend and no link',async t=>{
 const f=fixture(t),wid=await setup(f),r=await f.service.start(wid,{text:secret},'lost-one');
 const inputs=JSON.parse((f.sqlite.prepare('SELECT inputs FROM runs WHERE id=?').get(r.run_id) as any).inputs);
 const plan=JSON.parse((f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
  .get(r.published_version_id) as any).plan);
 f.sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(r.run_id);
 f.lose();
 const invoke=()=>runPublishedCloudflareAction(f.env,plan,plan.steps[0],r.run_id,undefined,{inputs,steps:{}});
 assert.equal((await invoke()).status,'indeterminate');
 assert.equal((await invoke()).status,'indeterminate');assert.equal(f.posts,1);
 await assert.rejects(()=>f.service.envshareLink(r.run_id,('envshare_key_base58' in r?r.envshare_key_base58!: "")),/envshare_result_not_ready/);
});
