import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {settlePhysicalGitHubActionAttempt} from '../src/github-action-terminal-cas.ts';
const aid='11111111-1111-4111-8111-111111111111';
function dbFixture(){
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql']){
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 }
 db.exec(readFileSync(new URL('../migrations/0005_github_workflow_check.sql',import.meta.url),'utf8'));
 db.exec('BEGIN');
 db.exec(readFileSync(new URL('../migrations/0006_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 db.exec('COMMIT');
 db.exec(readFileSync(new URL('../migrations/0007_session_executions.sql',import.meta.url),'utf8'));
 db.exec(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
 VALUES('wf','wf','{}',1,'active',1,1);
 INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','x','{}',1);
 INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at)
 VALUES('r','wf','v','instance','x','{}','running',1,1)`);
 db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,
 repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,
 owner_run_id,owner_run_attempt,created_at,updated_at)
 VALUES(?,'r','step','github.action','dispatch','claimed','lirtual/github-actions','1',
 '.github/workflows/a.yml','refs/heads/main',42,1,42,1,1,1)`).run(aid);
 return db;
}
function adapter(db:DatabaseSync){return {prepare:(sql:string)=>({bind:(...args:unknown[])=>({
 run:async()=>({meta:{changes:db.prepare(sql).run(...args as []).changes}}),
 first:async()=>db.prepare(sql).get(...args as []),
 })})} as any;}
test('terminal settlement is atomic, idempotent, and cannot be overwritten',async()=>{
 const db=dbFixture();
 try{
  const wrap=adapter(db);
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'running'}),'held');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'success'}),'updated');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'success'}),'already_settled');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'failed' as never}),'held');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'cancelled'}),'conflict');
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'succeeded');
  assert.equal(db.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
 }finally{db.close();}
});
test('physical identity mismatch cannot update persisted state',async()=>{
 const db=dbFixture();
 try{
  const wrap=adapter(db);
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,43,1,{state:'completed',conclusion:'success'}),'conflict');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,2,{state:'completed',conclusion:'success'}),'conflict');
  db.exec("UPDATE runs SET outcome='cancelled' WHERE id='r'");
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'success'}),'conflict');
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'claimed');
 }finally{db.close();}
});

test('physically failed job before OIDC claim terminates as failed, but never succeeds',async()=>{
 const db=dbFixture();
 try{
  const wrap=adapter(db);
  db.exec("UPDATE step_attempts SET state='confirmed',owner_run_id=NULL,owner_run_attempt=NULL");
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'success'}),'conflict');
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'confirmed');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'failure'}),'updated');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'failure'}),'already_settled');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'success'}),'conflict');
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'failed');
 }finally{db.close();}
});
test('pre-claim physical failure cannot settle a cancelled parent or a different candidate',async()=>{
 const db=dbFixture();
 try{
  const wrap=adapter(db);
  db.exec("UPDATE step_attempts SET state='confirmed',owner_run_id=NULL,owner_run_attempt=NULL");
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,43,1,{state:'completed',conclusion:'failure'}),'conflict');
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,2,{state:'completed',conclusion:'failure'}),'conflict');
  db.exec("UPDATE runs SET outcome='cancelled'");
  assert.equal(await settlePhysicalGitHubActionAttempt(wrap,aid,42,1,{state:'completed',conclusion:'failure'}),'conflict');
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'confirmed');
 }finally{db.close();}
});
