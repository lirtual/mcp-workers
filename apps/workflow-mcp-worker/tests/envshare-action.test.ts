import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createDecipheriv} from 'node:crypto';
import {compilePlan,type Plan} from '../src/plan.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {WorkflowService,type Env} from '../src/store.ts';
import {buildEnvshareLink,encryptEnvshareAdmission} from '../src/envshare-transient.ts';
import {runPublishedCloudflareAction} from '../src/cloudflare-action-executor.ts';
const WF='11111111-1111-4111-8111-111111111111';
const VERSION='33333333-3333-4333-8333-333333333333';
const ABC='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decode(s:string){let n=0n;for(const c of s){const d=ABC.indexOf(c);assert(d>=0);n=n*58n+BigInt(d);}const out:number[]=[];while(n){out.unshift(Number(n%256n));n/=256n;}for(const c of s){if(c!=='1')break;out.unshift(0);}return Buffer.from(out);}
const manifest=()=>cloudflareActionManifest('envshare');
async function definition(){
 const m=await manifest();
 return {version:1,name:'Manual encrypted EnvShare',inputs:{},steps:[
  {id:'share',uses:'action.run',with:{executor:'cloudflare',provider:'envshare',
   action:'envshare.share_text',contract_digest:m.contract_digest,
   input:Object.fromEntries(['encrypted','iv','ttl','reads'].map(k=>[k,{ref:'inputs.'+k}]))}}
 ]};
}
test('compiler rejects literal plaintext, key fields, chained writes, Cron and unsafe references',async()=>{
 const def=await definition();
 assert.equal((await compilePlan(def)).plan.steps.length,1);
 for(const change of [
  (p:any)=>{p.inputs={text:'inline secret'};},
  (p:any)=>{p.triggers=[{type:'cron',schedule:'* * * * *'}];},
  (p:any)=>{p.steps.push({id:'second',uses:'result.emit',with:{data:'secret'}});},
  (p:any)=>{p.steps[0].with.input.encrypted={ref:'inputs.text'};},
  (p:any)=>{p.steps[0].with.input.key='plaintext';},
  (p:any)=>{p.steps[0].with.contract_digest='0'.repeat(64);},
  (p:any)=>{p.steps[0].if=false;},
 ]){const copy=structuredClone(def);change(copy);await assert.rejects(()=>compilePlan(copy));}
});
test('admission crypto is interoperable with independent AES-128-GCM and never persists a key in sealed fields',async()=>{
 const text='Spec35 PRIVATEKEY=test-2026 UTF8内容';
 const r=await encryptEnvshareAdmission({text});
 assert(!JSON.stringify(r.inputs).includes(text));
 assert(!JSON.stringify(r.inputs).includes(r.delivery_key));
 assert.equal(r.inputs.ttl,86400);assert.equal(r.inputs.reads,1);
 const iv=decode(r.inputs.iv),encrypted=decode(r.inputs.encrypted),key=decode(r.delivery_key);
 assert.equal(iv.length,16);assert.equal(key.length,16);
 const d=createDecipheriv('aes-128-gcm',key,iv);
 d.setAuthTag(encrypted.subarray(-16));
 assert.equal(Buffer.concat([d.update(encrypted.subarray(0,-16)),d.final()]).toString('utf8'),text);
 const shareId='1'.repeat(16);
 const link=await buildEnvshareLink(r.inputs,shareId,r.delivery_key);
 assert(link.startsWith('https://envshare.dev/unseal#'));
 const composite=decode(link.split('#')[1]!);
 assert.equal(composite.length,33);assert.equal(composite[0],2);
 assert.deepEqual(composite.subarray(17),key);
 await assert.rejects(()=>buildEnvshareLink(r.inputs,shareId,'1'.repeat(16)));
 for(const bad of [{text:''},{text:'x'.repeat(16385)},{text:'ok',ttl_seconds:0},
  {text:'ok',max_reads:11},{text:'ok',key:'attacker'}])
  await assert.rejects(()=>encryptEnvshareAdmission(bad));
});
test('single manual run persists only ciphertext and ID; original key works once-only admission and no replay creation',async t=>{
 const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
  '0011_awaited_child_capacity.sql','0013_cloudflare_action_invocations.sql',
  '0018_cloudflare_action_migration_fence.sql'])
  sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const {plan}=await compilePlan(await definition());
 const m=await manifest();
 assert.equal(m.contract_digest,'15c76abb4ebe16edfdb24e5a63cc55fb97227ea16bc51cfccaa132126c86bb44');
 const approved:Plan={...plan,cloudflare_execution_approved:true,
  cloudflare_action_approvals:[{executor:'cloudflare' as const,provider:'envshare',
   action:m.action,contract_digest:m.contract_digest,deployment_id:VERSION}]};
 sql.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .run(WF,'envshare','{}',1,'active',1,1);
 sql.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
  .run(VERSION,WF,'f'.repeat(64),JSON.stringify(approved),1);
 sql.prepare("UPDATE workflows SET active_version_id=? WHERE id=?").run(VERSION,WF);
 let starts=0,posts=0;
 const prepare=(query:string)=>{let args:unknown[]=[];return {
  bind(...a:unknown[]){args=a;return this;},
  async first<T>(){return (sql.prepare(query).get(...args as [])??null) as T|null;},
  async all<T>(){return {results:sql.prepare(query).all(...args as []) as T[]};},
  async run(){return {meta:{changes:Number(sql.prepare(query).run(...args as []).changes)}};},
 }};
 const env={DB:{prepare},WORKFLOW:{
  async create(){starts++;},async get(){return {async status(){return {status:'complete'};}};}},
  ACTIONS_DEPLOYMENT_ID:VERSION,ACTIONS:{
   async getContract(){return {deployment_id:VERSION,contract_digest:m.contract_digest};},
   async execute(_name:string,payload:any){
    posts++;assert.equal(Object.hasOwn(payload,'text'),false);
    assert.equal(Object.hasOwn(payload,'key_digest'),false);
    assert.equal(payload.ttl,86400);assert.equal(payload.reads,1);
    return {status:'accepted',input_digest:payload.input_digest,share_id:'1'.repeat(16)};
   },
  }} as unknown as Env;
 const service=new WorkflowService(env);
 const plaintext='secret that must never enter D1! Unicode密钥';
 const result=await service.start(WF,{text:plaintext},'envshare-once');
 assert.equal(result.status,'queued');assert.equal(starts,1);
 const delivery_key='delivery_key' in result?result.delivery_key:undefined;
 assert(delivery_key);
 const run=(result as {run_id:string}).run_id;
 const row=sql.prepare('SELECT inputs,request_digest FROM runs WHERE id=?').get(run) as {inputs:string;request_digest:string};
 assert(!row.inputs.includes(plaintext));assert(!row.inputs.includes(delivery_key!));
 assert(!row.request_digest.includes(delivery_key!));
 await assert.rejects(()=>service.start(WF,{text:plaintext},'envshare-once'),
  /envshare_key_unrecoverable/);
 assert.equal(starts,1);
 sql.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(run);
 const output=await runPublishedCloudflareAction(env,approved,approved.steps[0]!,run,
  undefined,{inputs:JSON.parse(row.inputs),steps:{}});
 assert.equal(output.status,'succeeded');assert.equal(posts,1);
 sql.prepare("UPDATE runs SET outcome='succeeded',result=? WHERE id=?")
  .run(JSON.stringify(output.output),run);
 const safe=await service.result(run);
 assert(!JSON.stringify(safe).includes(delivery_key!));
 assert(!JSON.stringify(safe).includes('unseal#'));
 const restored=await service.result(run,delivery_key!);
 assert.match(restored.share_url!,/^https:\/\/envshare\.dev\/unseal#/);
 assert.equal(posts,1);
 await assert.rejects(()=>service.result(run,'1'.repeat(16)),/invalid_envshare_key/);
 assert(!JSON.stringify(sql.prepare('SELECT inputs,result FROM runs WHERE id=?').get(run)).includes(delivery_key!));
});
