import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';
import {WorkflowService,type Env} from '../src/store.ts';
const wf='11111111-1111-4111-8111-111111111111';
const v1='33333333-3333-4333-8333-333333333333';
const v2='44444444-4444-4444-8444-444444444444';

test('same Draft, changed actual action Worker version gets new immutable grant; identical approvals reuse',async t=>{
 const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
 for(const file of ['0001_s1.sql','0014_workflow_deletion.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const manifest=await cloudflareActionManifest('bark');
 const definition={version:1,name:'Bark',steps:[{id:'notify',uses:'action.run',with:{
  executor:'cloudflare',provider:'bark',action:'bark.send_notification',
  contract_digest:manifest.contract_digest,input:{notification:{body:'Hello'}}}}]};
 sqlite.prepare(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
  VALUES(?,?,?,1,'draft',1,1)`).run(wf,'Bark',JSON.stringify(definition));
 let live=v1;
 const env={DB:{prepare(sql:string){let args:unknown[]=[];return {
   bind(...values:unknown[]){args=values;return this;},
   async first<T>(){return (sqlite.prepare(sql).get(...args as [])??null) as T|null;},
   async all<T>(){return {results:sqlite.prepare(sql).all(...args as []) as T[]};},
   async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args as []).changes)}};},
  };},async batch(statements:{run:()=>Promise<unknown>}[]){
   sqlite.exec('BEGIN');try{const results=[];for(const stmt of statements)results.push(await stmt.run());
    sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}
  }},
  get ACTIONS_DEPLOYMENT_ID(){return live;},
  ACTIONS:{async getContract(actionId:string){assert.equal(actionId,'bark.send_notification');
    return {deployment_id:live,contract_digest:manifest.contract_digest};}},
 } as unknown as Env;
 const service=new WorkflowService(env);
 const publish=()=>service.publish(wf,1,[],false,false,[],[],[{executor:'cloudflare',
  provider:'bark',action:'bark.send_notification',contract_digest:manifest.contract_digest,
  deployment_id:live}],true);
 const first=await publish();
 assert.equal((await publish()).published_version_id,first.published_version_id);
 live=v2;
 const next=await publish();
 assert.notEqual(next.published_version_id,first.published_version_id);
 assert.equal((await publish()).published_version_id,next.published_version_id);
 const old=JSON.parse(String(sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(first.published_version_id)?.plan));
 const newer=JSON.parse(String(sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(next.published_version_id)?.plan));
 assert.equal(old.cloudflare_action_approvals[0].deployment_id,v1);
 assert.equal(newer.cloudflare_action_approvals[0].deployment_id,v2);
});
