import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {WorkflowService} from '../src/store.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import type {Env} from '../src/store.ts';

test('unchanged Draft reuses only the same reviewed Provider version, and repins after version rotation',async t=>{
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const migration of ['0001_s1.sql','0014_workflow_deletion.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 const db={
  prepare(sql:string){
   let args:unknown[]=[];
   return {bind(...values:unknown[]){args=values;return this;},
    async first<T>(){return (sqlite.prepare(sql).get(...args as any[])??null) as T|null;},
    async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as any[]).changes)}};},
    async all<T>(){return {results:sqlite.prepare(sql).all(...args as any[]) as T[]};}};
  },
  async batch(stmts:Array<{run:()=>Promise<{meta:{changes:number}}>}>){
   sqlite.exec('BEGIN');
   try{const result=[];for(const stmt of stmts)result.push(await stmt.run());
    sqlite.exec('COMMIT');return result;
   }catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
 } as unknown as Env['DB'];
 const manifest=await cloudflareActionManifest('unified-generic');
 const id='11111111-1111-4111-8111-111111111111';
 const definition={version:1,name:'generic repin',steps:[{
  id:'notify',uses:'action.run',with:{executor:'cloudflare',provider:'weixin',
   action:'weixin.send_text',contract_digest:manifest.contract_digest,
   input:{text:'Safe Owner-only test'}}}]};
 sqlite.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,'draft',1,1)")
  .run(id,'generic repin',JSON.stringify(definition));
 const firstId='33333333-3333-4333-8333-333333333333';
 const nextId='44444444-4444-4444-8444-444444444444';
 let active=firstId;
 const provider={getContract:async()=>({deployment_id:active,contract_digest:manifest.contract_digest})};
 const env={DB:db,ACTIONS:provider,
  get ACTIONS_DEPLOYMENT_ID(){return active;}} as unknown as Env;
 const service=new WorkflowService(env);
 const grant=()=>[{executor:'cloudflare' as const,provider:'weixin',
  action:'weixin.send_text',contract_digest:manifest.contract_digest,deployment_id:active}];
 const publish=()=>service.publish(id,1,[],false,false,[],[],grant(),true);
 const first=await publish();
 assert.equal((await publish()).published_version_id,first.published_version_id);
 active=nextId;
 const next=await publish();
 assert.notEqual(next.published_version_id,first.published_version_id,
  'a new Provider Version must not reuse the old immutable grant');
 assert.equal((await publish()).published_version_id,next.published_version_id);
 const rows=sqlite.prepare('SELECT id,plan FROM workflow_versions ORDER BY created_at').all() as
  Array<{id:string;plan:string}>;
 assert.equal(rows.length,2);
 assert.deepEqual(rows.map(x=>JSON.parse(x.plan).cloudflare_action_approvals[0].deployment_id)
  .sort(),[firstId,nextId]);
});

test('EnvShare Validate and Publish grant the real EnvShare contract, never a Weixin fallback',async t=>{
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const migration of ['0001_s1.sql','0014_workflow_deletion.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 const db={prepare(sql:string){
  let args:unknown[]=[];
  return {bind(...values:unknown[]){args=values;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...args as any[])??null) as T|null;},
   async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as any[]).changes)}};},
   async all<T>(){return {results:sqlite.prepare(sql).all(...args as any[]) as T[]};}};
 },async batch(stmts:Array<{run:()=>Promise<unknown>}>){
  sqlite.exec('BEGIN');try{const out=[];for(const stmt of stmts)out.push(await stmt.run());
   sqlite.exec('COMMIT');return out;
  }catch(e){sqlite.exec('ROLLBACK');throw e;}
 }} as unknown as Env['DB'];
 const manifest=await cloudflareActionManifest('envshare');
 const version='33333333-3333-4333-8333-333333333333';
 let contractReads=0;
 const env={DB:db,ACTIONS_DEPLOYMENT_ID:version,ACTIONS:{async getContract(action:string,digest:string){
  contractReads++;
  assert.equal(action,'envshare.share_text');
  assert.equal(digest,manifest.contract_digest);
  return {deployment_id:version,contract_digest:manifest.contract_digest};
 }}} as unknown as Env;
 const service=new WorkflowService(env);
 const definition={version:1,name:'EnvShare single manual',inputs:{},steps:[{
  id:'share',uses:'action.run',with:{executor:'cloudflare',provider:'envshare',
   action:'envshare.share_text',contract_digest:manifest.contract_digest,
   input:Object.fromEntries(['encrypted','iv','ttl','reads'].map(k=>[k,{ref:'inputs.'+k}]))}}]};
 const expected={executor:'cloudflare' as const,provider:'envshare',action:'envshare.share_text',
  contract_digest:manifest.contract_digest,deployment_id:version};
 const validated=await service.validateDefinition(JSON.stringify(definition));
 assert.equal(validated.valid,true);
 assert.deepEqual('reviewed_cloudflare_actions' in validated?validated.reviewed_cloudflare_actions:null,[expected]);
 const id='11111111-1111-4111-8111-111111111111';
 sqlite.prepare("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES(?,?,?,1,'draft',1,1)")
  .run(id,'EnvShare single manual',JSON.stringify(definition));
 await assert.rejects(()=>service.publish(id,1,[],false,false,[],[],[{
  ...expected,provider:'weixin',action:'weixin.send_text'}],true),
  /cloudflare_action_approval_required/);
 const published=await service.publish(id,1,[],false,false,[],[],[expected],true);
 assert.equal(published.state,'active');
 const row=sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
  .get(published.published_version_id) as {plan:string};
 assert.deepEqual(JSON.parse(row.plan).cloudflare_action_approvals,[expected]);
 assert.equal(JSON.parse(row.plan).cloudflare_execution_approved,true);
 assert(contractReads>=2);
});
