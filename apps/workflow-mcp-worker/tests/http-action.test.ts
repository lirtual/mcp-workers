import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {compilePlan} from '../src/plan.ts';
import {approvedHttpTarget,callApprovedHttp,HttpDispatchError} from '../src/http-action.ts';
import {WorkflowService} from '../src/store.ts';
import type {Env} from '../src/store.ts';

const url='https://example.com/';
const definition=(method:'GET'|'HEAD'|'POST'='GET',body?:unknown)=>({
 version:1,name:'Reviewed HTTP',steps:[{id:'send',uses:'http.request',
   with:{url,method,...(body===undefined?{}:{body})}}],
});
test('compiler accepts reviewed HTTPS operation and rejects dynamic/unsafe targets',async()=>{
 const {plan}=await compilePlan(definition('POST',{message:'reviewed literal'}));
 assert.equal(plan.steps[0]?.uses,'http.request');
 await assert.rejects(()=>compilePlan(definition('POST',{message:{ref:'inputs.message'}})),/http_dynamic_body_unsupported/);
 for(const target of [
  'http://example.com/','https://localhost/','https://127.0.0.1/',
  'https://example.com/path?api_key=x','https://example.com/#f',
  'https://user:pass@example.com/','https://example.com:8443/',
  'https://example.com/%2e%2e/admin','https://a.internal/',
  'https://[::1]/','https://example.com'
 ])await assert.rejects(()=>compilePlan({...definition(),steps:[
  {id:'send',uses:'http.request',with:{url:target,method:'GET'}}]}),/invalid_http_operation/);
 for(const withData of [
  {url,method:'DELETE'}, {url,method:'GET',body:{x:1}},
  {url,method:'POST',headers:{authorization:'Bearer x'}},
  {url:{ref:'inputs.url'},method:'GET'}, {url,method:{ref:'inputs.method'}},
 ])await assert.rejects(()=>compilePlan({...definition(),steps:[{id:'send',uses:'http.request',with:withData}]}));
 await assert.rejects(()=>compilePlan({version:1,name:'No repeated HTTP',steps:[
  {id:'loop',flow:'repeat',times:2,template:{uses:'http.request',with:{url,method:'POST',body:{event:1}}}}
 ]}),/unsupported_capability/);
 assert.equal(approvedHttpTarget(url).origin,'https://example.com');
});
function dummy(){
 let used=false;let calls=0;const queries:string[]=[];
 const db={prepare:(sql:string)=>{queries.push(sql);return {bind:(..._args:unknown[])=>({
  run:async()=>({meta:{changes:used?0:(used=true,1)}}),
  first:async()=>used?{reserved:1}:null,
 })};}} as unknown as Env['DB'];
 return {db,queries,calls:()=>calls,called:()=>calls++};
}
async function published(method:'GET'|'POST'='GET',body?:unknown){
 const {plan}=await compilePlan(definition(method,body));
 return {plan:{...plan,http_execution_approved:true as const,http_connection_generation:0,http_approvals:[{url,method}]},
   step:plan.steps[0]!};
}
test('one durable fence permits only one outbound request and rejects replay',async()=>{
 const {db,queries,called,calls}=dummy();const {plan,step}=await published();
 const send=(async(input:string|URL|Request,init?:RequestInit)=>{
  called();assert.equal(String(input),url);assert.equal(init?.method,'GET');
  assert.equal(init?.redirect,'manual');assert.equal(init?.headers,undefined);
  return new Response('ok',{status:200});
 }) as typeof fetch;
 assert.deepEqual(await callApprovedHttp(db,plan,step,'run',undefined,send),
  {status:200,ok:true,body:'ok',truncated:false});
 await assert.rejects(()=>callApprovedHttp(db,plan,step,'run',undefined,send),
  (e:unknown)=>e instanceof HttpDispatchError&&e.uncertain&&e.code==='http_dispatch_unconfirmed');
 assert.equal(calls(),1);
 assert.match(queries[0]??'',/INSERT INTO mcp_dispatch_fences/);
 assert.match(queries[0]??'',/outcome='running'/);
});
test('missing grant or oversized body fails before outbound request',async()=>{
 const {db,called,calls}=dummy();const {plan,step}=await published('POST',{a:1});
 const send=(async()=>{called();return new Response('ok');}) as typeof fetch;
 await assert.rejects(()=>callApprovedHttp(db,{...plan,http_approvals:[]},step,'run',{},send),
  (e:unknown)=>e instanceof HttpDispatchError&&e.code==='http_approval_missing');
 await assert.rejects(()=>callApprovedHttp(db,plan,step,'run','x'.repeat(5000),send),
  (e:unknown)=>e instanceof HttpDispatchError&&e.code==='http_invalid_body');
 assert.equal(calls(),0);
});
test('POST uses reviewed target and JSON body but never follows redirects',async()=>{
 const {db,called,calls}=dummy();const {plan,step}=await published('POST',{message:'fixed'});
 const send=(async(input:string|URL|Request,init?:RequestInit)=>{
  called();assert.equal(String(input),url);assert.equal(init?.method,'POST');
  assert.equal(init?.body,JSON.stringify({message:'hello'}));
  return new Response('',{status:302,headers:{location:'https://attacker.example/'}});
 }) as typeof fetch;
 await assert.rejects(()=>callApprovedHttp(db,plan,step,'run',{message:'hello'},send),
  (e:unknown)=>e instanceof HttpDispatchError&&e.uncertain&&e.code==='http_redirect_rejected');
 assert.equal(calls(),1);
});
test('lost response is indeterminate without resending POST',async()=>{
 const {db,called,calls}=dummy();const {plan,step}=await published('POST',{message:'x'});
 const send=(async()=>{called();throw Error('network may have accepted');}) as typeof fetch;
 await assert.rejects(()=>callApprovedHttp(db,plan,step,'run',{message:'x'},send),
  (e:unknown)=>e instanceof HttpDispatchError&&e.uncertain&&e.code==='http_outcome_unknown');
 await assert.rejects(()=>callApprovedHttp(db,plan,step,'run',{message:'x'},send),
  (e:unknown)=>e instanceof HttpDispatchError&&e.uncertain&&e.code==='http_dispatch_unconfirmed');
 assert.equal(calls(),1);
});
test('response content is bounded',async()=>{
 const {db}=dummy();const {plan,step}=await published();
 const response=await callApprovedHttp(db,plan,step,'run',undefined,
   (async()=>new Response('a'.repeat(10000))) as typeof fetch);
 assert.equal(response.body.length,8192);assert.equal(response.truncated,true);
});
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../migrations/0001_s1.sql',import.meta.url),'utf8'));
 sqlite.exec('ALTER TABLE workflows ADD COLUMN deleted_at INTEGER');
 sqlite.exec(readFileSync(new URL('../migrations/0016_portal_connection_revocation.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('../migrations/0017_http_connection_auth.sql',import.meta.url),'utf8'));
 const db={prepare:(sql:string)=>{
  let args:unknown[]=[];return {bind(...v:unknown[]){args=v;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...args as any[])??null) as T|null;},
   async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as any[]).changes)}};},
   async all<T>(){return {results:sqlite.prepare(sql).all(...args as any[]) as T[]};}};
 },async batch(stmts:Array<{run:()=>Promise<{meta:{changes:number}}>}>){
  sqlite.exec('BEGIN');try{const out=[];for(const st of stmts)out.push(await st.run());sqlite.exec('COMMIT');return out;}
  catch(e){sqlite.exec('ROLLBACK');throw e;}
 }} as unknown as Env['DB'];
 return {sqlite,db,service:new WorkflowService({DB:db} as Env)};
}
test('inline validate lists exact HTTP grant; Publish requires exact owner consent',async()=>{
 const {sqlite,service}=fixture();
 try{
  const source=JSON.stringify(definition());
  const validated=await service.validateDefinition(source);
  assert.equal(validated.valid,true);
  assert.deepEqual('required_http_operations' in validated ? validated.required_http_operations : undefined,[{url,method:'GET'}]);
  const id='11111111-1111-4111-8111-111111111111';
  sqlite.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,'draft',1,1)")
   .run(id,'HTTP',source);
  await assert.rejects(()=>service.publish(id,1),/http_action_approval_required/);
  await assert.rejects(()=>service.publish(id,1,[],true,false,[],[],[],false,[{url,method:'POST'}],true),
    /http_action_approval_required/);
  await assert.rejects(()=>service.publish(id,1,[],false,false,[],[],[],false,[{url,method:'GET'}],true),
    /http_action_approval_required/);
  const published=await service.publish(id,1,[],true,false,[],[],[],false,[{url,method:'GET'}],true);
  const saved=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(published.published_version_id) as {plan:string};
  assert.deepEqual(JSON.parse(saved.plan).http_approvals,[{url,method:'GET'}]);
  assert.equal(JSON.parse(saved.plan).http_execution_approved,true);
  const repeated=await service.publish(id,1,[],true,false,[],[],[],false,[{url,method:'GET'}],true);
  assert.equal(repeated.published_version_id,published.published_version_id);
 }finally{sqlite.close();}
});
test('HTTP Connection revoke fences old Published Plan; enable requires exact republish',async()=>{
 const {sqlite,db,service}=fixture();
 const id='11111111-1111-4111-8111-111111111111';
 const runA='22222222-2222-4222-8222-222222222222';
 const runB='33333333-3333-4333-8333-333333333333';
 const runC='44444444-4444-4444-8444-444444444444';
 const insert=(runId:string,versionId:string)=>{
  sqlite.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at) VALUES(?,?,?,?,?,'{}','running',1,1)")
   .run(runId,id,versionId,runId,'request');
 };
 try{
  const source=JSON.stringify(definition());
  sqlite.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,'draft',1,1)")
   .run(id,'HTTP',source);
  const grant=[{url,method:'GET' as const}];
  const initial=await service.httpConnectionStatus();
  assert.deepEqual(initial,{state:'enabled',generation:0});
  const published=await service.publish(id,1,[],true,false,[],[],[],false,grant,true);
  const getPlan=(versionId:string)=>JSON.parse(String(
   (sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(versionId) as {plan:string}).plan));
  const original=getPlan(published.published_version_id);
  assert.equal(original.http_connection_generation,0);
  assert.deepEqual(await service.httpConnectionRevoke(),{state:'revoked',generation:1});
  assert.deepEqual(await service.httpConnectionRevoke(),{state:'revoked',generation:1});
  await assert.rejects(()=>service.publish(id,1,[],true,false,[],[],[],false,grant,true),
   /http_connection_revoked/);
  insert(runA,published.published_version_id);
  let calls=0;
  const send=(async()=>{calls++;return new Response('ok');}) as typeof fetch;
  await assert.rejects(()=>callApprovedHttp(db,original,original.steps[0],runA,undefined,send),
   (e:unknown)=>e instanceof HttpDispatchError&&!e.uncertain&&e.code==='http_dispatch_not_authorized');
  assert.equal(calls,0);
  assert.deepEqual(await service.httpConnectionEnable(),{state:'enabled',generation:1});
  insert(runB,published.published_version_id);
  await assert.rejects(()=>callApprovedHttp(db,original,original.steps[0],runB,undefined,send),
   (e:unknown)=>e instanceof HttpDispatchError&&!e.uncertain&&e.code==='http_dispatch_not_authorized');
  assert.equal(calls,0);
  const renewed=await service.publish(id,1,[],true,false,[],[],[],false,grant,true);
  assert.notEqual(renewed.published_version_id,published.published_version_id);
  const next=getPlan(renewed.published_version_id);
  assert.equal(next.http_connection_generation,1);
  insert(runC,renewed.published_version_id);
  const actual=await callApprovedHttp(db,next,next.steps[0],runC,undefined,send);
  assert.equal(actual.ok,true);assert.equal(calls,1);
  assert.equal((sqlite.prepare('SELECT generation FROM mcp_dispatch_fences WHERE run_id=?').get(runC) as {generation:number}).generation,1);
  assert.deepEqual(await service.httpConnectionRevoke(),{state:'revoked',generation:2});
  // The reservation won before revoke; it remains recorded exactly once.
  await assert.rejects(()=>callApprovedHttp(db,next,next.steps[0],runC,undefined,send),
   (e:unknown)=>e instanceof HttpDispatchError&&e.uncertain&&e.code==='http_dispatch_unconfirmed');
  assert.equal(calls,1);
 }finally{sqlite.close();}
});
