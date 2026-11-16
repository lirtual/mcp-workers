import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudflareSelectedFilePlan} from '../src/cloudflare-selected-file.ts';
import type {Plan} from '../src/plan.ts';

const policy={delivery:'cloudflare_memory_bytes_v1',extensions:['.txt'],
 max_bytes:1024,input_slots:['file_name','size_bytes','sha256','time'],
 consent:'owner_public_upload_v1',receipt:'reviewed_output_v1'};
const digest='a'.repeat(64);
const manifest={executor:'cloudflare',source_repository:'lirtual/cloudflare-actions',
 service:'cloudflare-actions',entrypoint:'ActionsEntrypoint',
 action:'files.store_preview',provider:'files',version:1,
 side_effect:'public_file_upload',input_schema:{
 type:'object',additionalProperties:false,
 required:['file_name','size_bytes','sha256','time'],
 properties:{file_name:{type:'string'},size_bytes:{type:'integer'},sha256:{type:'string'},
 time:{type:'string'}}},output_schema:{type:'object',additionalProperties:false,
 required:['status'],properties:{status:{enum:['accepted','rejected','unknown']}}},
 selected_file:policy,contract_digest:digest};
const plan:Plan={version:1,name:'any-preview',cloudflare_execution_approved:true,
 cloudflare_action_approvals:[{executor:'cloudflare',provider:'files',
 action:'files.store_preview',contract_digest:digest,
 deployment_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}],
 cloudflare_action_contracts:{file:manifest},
 steps:[{id:'file',uses:'action.run',needs:[],with:{executor:'cloudflare',
 provider:'files',action:'files.store_preview',contract_digest:digest,
 input:{file_name:{ref:'inputs.file_name'},size_bytes:{ref:'inputs.size_bytes'},
 sha256:{ref:'inputs.sha256'},time:{ref:'inputs.time'}}}}]};
test('a third source-reviewed Cloudflare Action declares bounded in-memory file without name switch',()=>{
 const result=cloudflareSelectedFilePlan(plan);
 assert.ok(result);
 assert.equal(result.step_id,'file');
 assert.equal(result.manifest,manifest);
});
test('Cloudflare selected file refuses arbitrary fields, unapproved consumer and triggers',()=>{
 assert.equal(cloudflareSelectedFilePlan({...plan,triggers:[{
 type:'cron',expression:'* * * * *'}] as unknown as Plan['triggers']}),null);
 assert.equal(cloudflareSelectedFilePlan({...plan,cloudflare_action_approvals:[]}),null);
 assert.equal(cloudflareSelectedFilePlan({...plan,
 cloudflare_action_contracts:{file:{...manifest,selected_file:{
 ...policy,input_slots:['arbitrary']}}}}),null);
 assert.equal(cloudflareSelectedFilePlan({...plan,steps:[{...plan.steps[0],
 with:{...plan.steps[0].with,input:{file_name:'literal'}}}]}),null);
});

test('source-reviewed Cloudflare file ingress makes exactly one bounded private invocation, with no locator in D1',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {readFileSync}=await import('node:fs');
 const {startSelectedFile}=await import('../src/drop-file-ingress.ts');
 const {WorkflowService}=await import('../src/store.ts');
 const {recordedCloudflareFileStep}=await import('../src/cloudflare-selected-file-ingress.ts');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const migration of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
   '0011_awaited_child_capacity.sql','0013_cloudflare_action_invocations.sql',
   '0018_cloudflare_action_migration_fence.sql'])
  db.exec(readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 const workflow='11111111-1111-4111-8111-111111111111';
 const version='33333333-3333-4333-8333-333333333333';
 const {canonical}=await import('../src/cloudflare-action-contract.ts');
 const {contract_digest:_old,...source}=manifest;
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(
  JSON.stringify(canonical(source))));
 const actualDigest=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
 const authenticatedPlan:Plan={...plan,
  cloudflare_action_contracts:{file:{...manifest,contract_digest:actualDigest}},
  cloudflare_action_approvals:plan.cloudflare_action_approvals!.map(g=>({...g,contract_digest:actualDigest})),
  steps:[{...plan.steps[0],with:{...plan.steps[0].with,contract_digest:actualDigest}}]};
 db.prepare('INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
  .run(workflow,'synthetic','{}',1,'active',1,1);
 db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
  .run(version,workflow,actualDigest,JSON.stringify(authenticatedPlan),1);
 db.prepare('UPDATE workflows SET active_version_id=? WHERE id=?').run(version,workflow);
 const prepare=(sql:string)=>{
  let args:unknown[]=[];
  return {
   bind(...values:unknown[]){args=values;return this;},
   async first(){return db.prepare(sql).get(...args as [])??null;},
   async all(){return {results:db.prepare(sql).all(...args as [])};},
   async run(){
    const changes=db.prepare(sql).run(...args as []).changes;
    return {meta:{changes:Number(changes)}};
   },
  };
 };
 let reads=0,posts=0,starts=0,signals=0;
 const file={file_id:'opaque-file',file_name:'fixture.txt',mime_type:'text/plain',
  download_url:'https://files.oaiusercontent.com/approved-file?sig=synthetic'};
 const body='test source-reviewed bounded bytes';
 const orig=globalThis.fetch;
 globalThis.fetch=(async(url:string,init:RequestInit)=>{
  reads++;assert.equal(url,file.download_url);assert.equal(init.redirect,'manual');
  return new Response(body);
 }) as typeof fetch;
 t.after(()=>{globalThis.fetch=orig;});
 const env={DB:{prepare},WORKFLOW:{async create(){starts++;},
  async get(){return {async status(){return {status:'running'};},
   async sendEvent(event:{type:string}){assert.equal(event.type,'selected-file-complete-file');signals++;}}}},
  ACTIONS:{async getContract(_name:string,d:string){return {
   deployment_id:version,contract_digest:d};},
   async execute(_name:string,params:Record<string,unknown>){
    posts++;assert.equal(params.bytes instanceof Uint8Array,true);
    assert.equal(new TextDecoder().decode(params.bytes as Uint8Array),body);
    assert(!JSON.stringify(params).includes(file.download_url));
    return {status:'accepted',input_digest:params.input_digest};
   }}} as unknown as import('../src/store.ts').Env;
 const run=(inputs:Record<string,unknown>,key='once')=>startSelectedFile(env,{
  workflow_id:workflow,file,inputs,idempotency_key:key});
 await assert.rejects(()=>new WorkflowService(env).start(workflow,{},'without-file'),
  /selected_file_tool_required/);
 for(const v of [{},{public_file_upload_accepted:false},
   {public_file_upload_accepted:'true'},{
    public_file_upload_accepted:true,extra:1}])
  await assert.rejects(run(v),/selected_file_public_upload_consent_required/);
 assert.equal(reads,0);assert.equal(posts,0);
 const result=await run({public_file_upload_accepted:true});
 assert.equal(result.status,'succeeded');assert.equal(reads,1);assert.equal(posts,1);
 assert.equal(starts,1);assert.equal(signals,1);
 const row=db.prepare('SELECT inputs FROM runs WHERE id=?').get(result.run_id) as {inputs:string};
 assert(!row.inputs.includes(file.download_url));
 assert(!row.inputs.includes(file.file_id));
 assert(!row.inputs.includes(body));
 assert.equal((await recordedCloudflareFileStep(env.DB,authenticatedPlan,result.run_id,'file'))?.status,'succeeded');
 await assert.rejects(run({public_file_upload_accepted:true}),/selected_file_duplicate_admission/);
 assert.equal(posts,1);
});
