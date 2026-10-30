import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {compilePlan} from '../src/plan.ts';
import {WorkflowService} from '../src/store.ts';
import {workflowCapabilities} from '../src/capabilities.ts';
import {portalAuthorization,changePortalAuthorization,reservePortalCall} from '../src/portal-authorization.ts';
import type {Env} from '../src/store.ts';

const workflowId='11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
const portal='https://mcp.lirtual.dpdns.org/mcp';
const definition={version:1,name:'Reviewed MCP read',steps:[
 {id:'read',uses:'mcp.call',with:{endpoint:portal,tool:'ima_list_notebooks',scope:'read',
  arguments:{limit:1},input_schema:{type:'object',properties:{limit:{type:'integer'}}}}},
]};
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../migrations/0001_s1.sql',import.meta.url),'utf8'));
 sqlite.exec('ALTER TABLE workflows ADD COLUMN deleted_at INTEGER');
 sqlite.exec(readFileSync(new URL('../migrations/0016_portal_connection_revocation.sql',import.meta.url),'utf8'));
 const prepare=(sql:string)=>{
  let args:unknown[]=[];
  return {bind(...v:unknown[]){args=v;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...args as any[])??null) as T|null;},
   async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as any[]).changes)}};},
   async all<T>(){return {results:sqlite.prepare(sql).all(...args as any[]) as T[]};}};
 };
 const db={prepare,async batch(statements:Array<{run:()=>Promise<{meta:{changes:number}}>}>){
  sqlite.exec('BEGIN');try{
   const out=[];for(const stmt of statements)out.push(await stmt.run());
   sqlite.exec('COMMIT');return out;
  }catch(e){sqlite.exec('ROLLBACK');throw e;}
 }} as unknown as Env['DB'];
 const env={DB:db,MCP_PORTAL_ENDPOINT:portal} as Env;
 const service=new WorkflowService(env);
 return {sqlite,db,service};
}

test('fixed Portal revocation and re-enable are idempotent; old generation never revives',async()=>{
 const {sqlite,db}=fixture();try{
  assert.deepEqual(await portalAuthorization(db),{state:'enabled',generation:0});
  assert.deepEqual(await changePortalAuthorization(db,'revoke'),{state:'revoked',generation:1});
  assert.deepEqual(await changePortalAuthorization(db,'revoke'),{state:'revoked',generation:1});
  assert.deepEqual(await changePortalAuthorization(db,'enable'),{state:'enabled',generation:1});
  assert.deepEqual(await changePortalAuthorization(db,'enable'),{state:'enabled',generation:1});
  assert.deepEqual(await changePortalAuthorization(db,'revoke'),{state:'revoked',generation:2});
 }finally{sqlite.close();}
});

test('published MCP grants pin generation; revoke fences new effect and same-Draft re-enable republish',async()=>{
 const {sqlite,db,service}=fixture();try{
  sqlite.prepare(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
   VALUES(?,?,?,1,'draft',1,1)`).run(workflowId,'MCP',JSON.stringify(definition));
  const {plan}=await compilePlan(definition);
  const s=plan.steps[0]!;
  const grants=[{endpoint:portal,tool:'ima_list_notebooks',scope:'read' as const,
   schema_digest:String(s.with.schema_digest)}];
  const first=await service.publish(workflowId,1,grants,true);
  const firstPlan=JSON.parse(String(sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(first.published_version_id)?.plan));
  assert.equal(firstPlan.mcp_connection_generation,0);
  const same=await service.publish(workflowId,1,grants,true);
  assert.equal(same.published_version_id,first.published_version_id);
  sqlite.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at)
   VALUES(?,?,?,?,?,'{}','running',1,1)`).run(runId,workflowId,first.published_version_id,runId,'input');
  assert.equal(await reservePortalCall(db,runId,'read',0),'reserved');
  assert.equal(await reservePortalCall(db,runId,'read',0),'already_reserved');
  assert.equal((await service.portalConnectionRevoke()).generation,1);
  await assert.rejects(()=>service.publish(workflowId,1,grants,true),/portal_connection_revoked/);
  await service.portalConnectionEnable();
  assert.equal(await reservePortalCall(db,runId,'another_step',0),'revoked');
  const renewed=await service.publish(workflowId,1,grants,true);
  assert.notEqual(renewed.published_version_id,first.published_version_id);
  const nextPlan=JSON.parse(String(sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(renewed.published_version_id)?.plan));
  assert.equal(nextPlan.mcp_connection_generation,1);
  const renewedRun='33333333-3333-4333-8333-333333333333';
  sqlite.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at)
   VALUES(?,?,?,?,?,'{}','running',1,1)`).run(renewedRun,workflowId,renewed.published_version_id,renewedRun,'input');
  assert.equal(await reservePortalCall(db,renewedRun,'read',1),'reserved');
  assert.equal((await service.portalConnectionRevoke()).generation,2);
  assert.equal(await reservePortalCall(db,renewedRun,'late',1),'revoked');
 }finally{sqlite.close();}
});

test('revoke and reservation serialize: only reservation-first may proceed after revocation',async()=>{
 const {sqlite,db}=fixture();try{
  sqlite.prepare(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
   VALUES(?,?,?,1,'draft',1,1)`).run(workflowId,'MCP',JSON.stringify(definition));
  sqlite.prepare(`INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at)
   VALUES(?,?,?,'{}',1)`).run('44444444-4444-4444-8444-444444444444',workflowId,'digest');
  sqlite.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at)
   VALUES(?,?,?,?,?,'{}','running',1,1)`).run(runId,workflowId,'44444444-4444-4444-8444-444444444444',runId,'input');
  const [reserved,revoked]=await Promise.all([
   reservePortalCall(db,runId,'first',0),changePortalAuthorization(db,'revoke')]);
  assert.equal(reserved,'reserved');assert.deepEqual(revoked,{state:'revoked',generation:1});
  assert.equal(await reservePortalCall(db,runId,'second',0),'revoked');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM mcp_dispatch_fences').first<{n:number}>())?.n,1);
 }finally{sqlite.close();}
});

test('public discovery reports revoked and does not advertise reviewed tools after revoke',async()=>{
 const {sqlite,db}=fixture();try{
  await changePortalAuthorization(db,'revoke');
  let lookups=0;
  const env={DB:db,MCP_PORTAL_ENDPOINT:portal,
   MCP_PORTAL_CLIENT_ID:'test-client',MCP_PORTAL_CLIENT_SECRET:'test-secret'} as Env;
  const discover=async()=>{lookups++;throw Error('portal_discovery_should_not_run');};
  const overview=await workflowCapabilities(env,undefined,discover) as unknown as {
   connections:{portal:{availability:string;generation:number}};
   capability_ids:Array<{id:string;availability:string}>
  };
  assert.equal(overview.connections.portal.availability,'revoked');
  assert.equal(overview.connections.portal.generation,1);
  assert.equal(overview.capability_ids.find(x=>x.id==='action.mcp.call')?.availability,'revoked');
  for(const id of ['action.mcp.call','flow.foreach_mcp_read','flow.foreach_multi_mcp_read',
   'flow.foreach_mixed_task']){
   const detail=await workflowCapabilities(env,id,discover);
   assert.equal(detail.availability,'revoked');
   assert.deepEqual(detail.discovered_tools??[],[]);
  }
  assert.equal(lookups,0);
 }finally{sqlite.close();}
});
