import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {compilePlan,type Plan} from '../src/plan.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {WorkflowService,type Env} from '../src/store.ts';
import {startLitterboxUpload,recordedLitterboxStep} from '../src/litterbox-executor.ts';

const WF='11111111-1111-4111-8111-111111111111';
const VERSION='33333333-3333-4333-8333-333333333333';
const filename='fixture.txt',text='Spec35 disposable synthetic bytes; no secrets';
const file={file_id:'file_000001',file_name:filename,mime_type:'text/plain',
 download_url:'https://files.oaiusercontent.com/fixture?token=fake-only'};
const makeDefinition=async()=>{
 const m=await cloudflareActionManifest('litterbox');
 return {version:1,name:'Manual Litterbox approved file',inputs:{},steps:[
  {id:'upload',uses:'action.run',with:{
    executor:'cloudflare',provider:'litterbox',action:'litterbox.upload_file',
    contract_digest:m.contract_digest,
    input:Object.fromEntries(['file_name','size_bytes','sha256','time'].map(k=>[k,{ref:'inputs.'+k}]))
  }},
 ]};
};
function fixture(t:any,{grant=true,gate='open',response='accepted',providerVersion=VERSION}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
  '0011_awaited_child_capacity.sql','0013_cloudflare_action_invocations.sql',
  '0018_cloudflare_action_migration_fence.sql'])
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 if(gate!=='open')db.prepare("UPDATE cloudflare_action_gate SET state=? WHERE id=1").run(gate);
 const audit={reads:0,posts:0,nativeStarts:0,signals:0};
 const prepare=(query:string)=>{
  let args:unknown[]=[];
  return {bind(...a:unknown[]){args=a;return this;},
   async first<T>(){return (db.prepare(query).get(...args as [])??null) as T|null;},
   async all<T>(){return {results:db.prepare(query).all(...args as []) as T[]};},
   async run(){return {meta:{changes:Number(db.prepare(query).run(...args as []).changes)}};},
  };
 };
 const env={DB:{prepare},WORKFLOW:{
   async create(){audit.nativeStarts++;},
   async get(){return {async status(){return {status:'running'};},
    async sendEvent(event:any){assert.equal(event.type,'litterbox-complete-upload');
     assert.deepEqual(Object.keys(event.payload),['run_id']);audit.signals++;}}},
  },ACTIONS_DEPLOYMENT_ID:VERSION,ACTIONS:{
    async getContract(_action:string,digest:string){return {deployment_id:providerVersion,contract_digest:digest};},
    async execute(_action:string,params:any){
     audit.posts++;
     assert.equal(params.bytes instanceof Uint8Array,true);
     assert.equal(new TextDecoder().decode(params.bytes),text);
     assert.equal(params.file_name,filename);
     assert.equal(params.time,'24h');
     assert(!JSON.stringify(params).includes(file.download_url));
     if(response==='throw')throw Error('uncertain network result');
     return response==='rejected'?{status:'rejected',input_digest:params.input_digest}:
      {status:'accepted',input_digest:params.input_digest,
       download_url:'https://litter.catbox.moe/fixture.txt'};
    },
  }} as unknown as Env;
 const orig=globalThis.fetch;
 globalThis.fetch=(async(url:string,init:RequestInit)=>{
  audit.reads++;
  assert.equal(url,file.download_url);assert.equal(init.redirect,'manual');
  return new Response(text);
 }) as typeof fetch;
 t.after(()=>{globalThis.fetch=orig;});
 return {db,env,audit,async publish(){
  const m=await cloudflareActionManifest('litterbox');
  const {plan}=await compilePlan(await makeDefinition());
  const approved:Plan={...plan,cloudflare_execution_approved:true,
   cloudflare_action_approvals:grant?[{executor:'cloudflare',provider:'litterbox',
    action:m.action,contract_digest:m.contract_digest,deployment_id:VERSION}]:[]};
  db.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run(WF,'litterbox','{}',1,'active',1,1);
  db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
   .run(VERSION,WF,'a'.repeat(64),JSON.stringify(approved),1);
  db.prepare('UPDATE workflows SET active_version_id=? WHERE id=?').run(VERSION,WF);
  return approved;
 }};
}

test('compiler allows only one manual pinned file Action and denies literal URLs or fan-out',async()=>{
 const d=await makeDefinition();
 const {plan}=await compilePlan(d);
 assert.equal(plan.steps.length,1);
 for(const mutation of [
  (x:any)=>{x.triggers=[{type:'cron',schedule:'* * * * *'}]},
  (x:any)=>{x.steps.push({id:'other',uses:'result.emit',with:{data:'extra'}})},
  (x:any)=>{x.steps[0].with.input.url='https://evil.example/'},
  (x:any)=>{x.steps[0].with.input.file_name={ref:'inputs.download_url'}},
  (x:any)=>{x.steps[0].with.input.sha256='raw'},
  (x:any)=>{x.steps[0].approval={required:true}},
  (x:any)=>{x.inputs={file_id:'file_id_in_plan'}},
 ]){
  const changed=structuredClone(d);mutation(changed);
  await assert.rejects(()=>compilePlan(changed));
 }
});

test('one real native Run and D1 fence, one private RPC, no signed URL or bytes persisted',async t=>{
 const f=fixture(t);const plan=await f.publish();
 await assert.rejects(()=>new WorkflowService(f.env).start(WF,{},'plain-run'),/litterbox_file_tool_required/);
 const r=await startLitterboxUpload(f.env,{workflow_id:WF,file,idempotency_key:'once-01'});
 assert.equal(r.status,'succeeded');
 assert.equal(r.download_url,'https://litter.catbox.moe/fixture.txt');
 assert.equal(f.audit.nativeStarts,1);
 assert.equal(f.audit.posts,1);
 assert.equal(f.audit.reads,1);
 assert.equal(f.audit.signals,1);
 const persisted=f.db.prepare('SELECT inputs,result,admission_key FROM runs WHERE id=?')
  .get(r.run_id) as {inputs:string;result:null|string;admission_key:string};
 assert.deepEqual(JSON.parse(persisted.inputs),{
  file_name:filename,size_bytes:new TextEncoder().encode(text).byteLength,
  sha256:JSON.parse(persisted.inputs).sha256,time:'24h',
 });
 assert.equal(persisted.admission_key,'once-01');
 assert(!JSON.stringify(persisted).includes(file.file_id));
 assert(!JSON.stringify(persisted).includes(file.download_url));
 assert(!JSON.stringify(persisted).includes(text));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cloudflare_action_invocations').get()!.n,1);
 const receipt=await recordedLitterboxStep(f.env.DB,r.run_id,plan.steps[0]!.id);
 assert.equal(receipt?.status,'succeeded');
 assert.equal(receipt?.output?.download_url,r.download_url);
 await assert.rejects(()=>startLitterboxUpload(f.env,{
  workflow_id:WF,file,idempotency_key:'once-01'}),/litterbox_duplicate_admission/);
 assert.equal(f.audit.posts,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n,1);
});

test('unknown private RPC outcome stays fenced and never retries, even with same key',async t=>{
 const f=fixture(t,{response:'throw'});await f.publish();
 const r=await startLitterboxUpload(f.env,{workflow_id:WF,file,idempotency_key:'uncertain01'});
 assert.equal(r.status,'indeterminate');
 assert.equal(r.error_code,'litterbox_outcome_unknown');
 assert.equal(f.audit.posts,1);
 const receipt=await recordedLitterboxStep(f.env.DB,r.run_id,'upload');
 assert.equal(receipt?.status,'indeterminate');
 await assert.rejects(()=>startLitterboxUpload(f.env,{
  workflow_id:WF,file,idempotency_key:'uncertain01'}),/litterbox_duplicate_admission/);
 assert.equal(f.audit.posts,1);
});

test('missing grant, bound provider mismatch, or frozen gate never sends file POST',async t=>{
 for(const variant of [
  {grant:false},{providerVersion:'44444444-4444-4444-8444-444444444444'},
  {gate:'frozen'},
 ]){
  await t.test(JSON.stringify(variant),async sub=>{
   const f=fixture(sub,variant);await f.publish();
   await assert.rejects(()=>startLitterboxUpload(f.env,{
    workflow_id:WF,file,idempotency_key:'blocked01'}));
   assert.equal(f.audit.posts,0);
  });
 }
});

test('concurrent identical admissions reserve at most one provider POST',async t=>{
 const f=fixture(t);await f.publish();
 const outcomes=await Promise.allSettled([
  startLitterboxUpload(f.env,{workflow_id:WF,file,idempotency_key:'concurrent01'}),
  startLitterboxUpload(f.env,{workflow_id:WF,file,idempotency_key:'concurrent01'}),
 ]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
 assert.equal(f.audit.posts,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM cloudflare_action_invocations').get()!.n,1);
 await assert.rejects(()=>new WorkflowService(f.env).start(WF,{},'concurrent01'),
  /litterbox_file_tool_required/);
 assert.equal(f.audit.posts,1);
});

test('tampered persisted Plan cannot use a different runtime file reference',async t=>{
 const f=fixture(t);await f.publish();
 const row=f.db.prepare('SELECT plan FROM workflow_versions WHERE id=?')
  .get(VERSION) as {plan:string};
 const altered=JSON.parse(row.plan);
 altered.steps[0].with.input.file_name={ref:'inputs.download_url'};
 f.db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
  .run(JSON.stringify(altered),VERSION);
 await assert.rejects(()=>startLitterboxUpload(f.env,{
   workflow_id:WF,file,idempotency_key:'tampered01'}),/litterbox_published_plan_required/);
 assert.equal(f.audit.reads,0);
 assert.equal(f.audit.posts,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM runs').get()!.n,0);
});
