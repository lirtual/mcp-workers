import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {WorkflowService,type Env} from '../src/store.ts';
import {canonical} from '../src/cloudflare-action-contract.ts';

const workflowId='11111111-1111-4111-8111-111111111111';
const deploymentId='22222222-2222-4222-8222-222222222222';
const baseManifest={executor:'cloudflare',provider:'json',action:'json.mark',version:1,
 source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',
 entrypoint:'ActionsEntrypoint',side_effect:'record_audited_marker',
 input_schema:{type:'object',additionalProperties:false,
  required:['message'],properties:{message:{type:'string',maxLength:100}}}};

async function fixture(t:test.TestContext,changes:Record<string,unknown>){
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const manifest={...baseManifest,...changes};
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(manifest))));
 const digest=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
 const definition=JSON.stringify({version:1,name:'reviewed marker',steps:[{
  id:'mark',uses:'action.run',with:{action_id:'json.mark',input:{message:'hello'}}}]});
 sqlite.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,'draft',1,1)")
  .run(workflowId,'reviewed marker',definition);
 const db={prepare(sql:string){let args:unknown[]=[];return {
  bind(...values:unknown[]){args=values;return this;},
  async first<T>(){return (sqlite.prepare(sql).get(...args as [])??null) as T|null;},
  async all<T>(){return {results:sqlite.prepare(sql).all(...args as []) as T[]};},
  async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as []).changes)}};},
 };},async batch(stmts:Array<{run:()=>Promise<unknown>}>){
  sqlite.exec('BEGIN');try{const result=[];for(const stmt of stmts)result.push(await stmt.run());
   sqlite.exec('COMMIT');return result;}
  catch(error){sqlite.exec('ROLLBACK');throw error;}
 }} as unknown as Env['DB'];
 const provider={listActions:async()=>[{action_id:'json.mark'}],
  getContract:async()=>({manifest,contract_digest:digest,deployment_id:deploymentId})};
 const service=new WorkflowService({DB:db,ACTIONS:provider} as unknown as Env);
 const approval={executor:'cloudflare' as const,provider:'json',action:'json.mark',
  contract_digest:digest,deployment_id:deploymentId};
 return {sqlite,service,approval};
}

test('unclassified side effects cannot inherit an automatic Publish grant',async t=>{
 const f=await fixture(t,{side_effect:'alter_production_database'});
 await assert.rejects(f.service.publishReviewed(workflowId,1),
  /cloudflare_action_explicit_authorization_required/);
 assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get() as {n:number}).n,0);
 assert.equal((f.sqlite.prepare('SELECT state FROM workflows WHERE id=?').get(workflowId) as {state:string}).state,'draft');
 // Existing lower-level Publish continues to demand an exact, independently
 // supplied grant. This is NOT exposed by the public auto-grant operation.
 await assert.rejects(f.service.publish(workflowId,1),/cloudflare_action_approval_required/);
 const approved=await f.service.publish(workflowId,1,[],false,false,[],[],[f.approval],true);
 assert.equal(approved.state,'active');
});

test('Provider review marker alone never authorizes new write effects',async t=>{
 for(const side_effect of ['record_audited_marker','alter_production_database','exfiltrate_owner_data']){
  await t.test(side_effect,async t=>{
   const f=await fixture(t,{side_effect,auto_grant_reviewed:true});
   await assert.rejects(f.service.publishReviewed(workflowId,1),
    /cloudflare_action_explicit_authorization_required/);
   assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions')
    .get() as {n:number}).n,0);
  });
 }
});

test('effect-free and read-only JSON Actions still receive bounded automatic Grants',async t=>{
 for(const side_effect of ['none','read_only']){
  await t.test(side_effect,async t=>{
   const f=await fixture(t,{side_effect});
   const result=await f.service.publishReviewed(workflowId,1);
   assert.equal(result.state,'active');
   const row=f.sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
    .get(result.published_version_id) as {plan:string};
   const plan=JSON.parse(row.plan);
   assert.deepEqual(plan.cloudflare_action_approvals,[f.approval]);
  });
 }
});

test('Provider review marker must be a real boolean, not a string',async t=>{
 const f=await fixture(t,{auto_grant_reviewed:'true'});
 await assert.rejects(f.service.publishReviewed(workflowId,1),/cloudflare_action_catalog_untrusted/);
 assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get() as {n:number}).n,0);
});
