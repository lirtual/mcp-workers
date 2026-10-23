import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {reservePublishedSessionSlot,releaseVerifiedSessionSlot}
 from '../src/github-action-session.ts';
import {WorkflowService} from '../src/store.ts';
import {reconcilePersistedGitHubActionAttempt} from '../src/github-action-attempt-reconcile.ts';
import {inspectPersistedGitHubActionAttempt} from '../src/github-action-attempt-inspection.ts';
import type {Env} from '../src/store.ts';

const run=(n:number)=>'11111111-1111-4111-8111-'+n.toString(16).padStart(12,'0');
const action={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
 workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),
 type:'session',contractDigest:'b'.repeat(64)};
const plan={github_execution_approved:true,github_action_approvals:[action],
 steps:[{id:'launch',uses:'github.run',with:{
  capability:'github.action',action:{...action,ref:'refs/tags/release-v1',inputs:{duration_minutes:5}},
 }}]};
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql']){
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 }
 db.exec('BEGIN');
 for(const name of ['0005_action_attempt_capabilities.sql','0006_session_executions.sql']){
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 }
 db.exec('COMMIT');
 db.exec(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
  VALUES('wf','wf','{}',1,'active',1,1);
  INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at)
  VALUES('v','wf','x','{}',1)`);
 db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(plan),'v');
 for(let i=1;i<=6;i++)
  db.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at)
   VALUES(?,'wf','v',?,'x','{}','running',1,1)`).run(run(i),'instance-'+i);
 const adapter={prepare:(sql:string)=>({bind:(...args:unknown[])=>({
  first:async()=>db.prepare(sql).get(...args as []),
  all:async()=>({results:db.prepare(sql).all(...args as [])}),
  run:async()=>({meta:{changes:db.prepare(sql).run(...args as []).changes}}),
 })})} as any;
 const claim=(index:number,state:'claimed'|'failed'|'succeeded'|'cancelled',owner:boolean)=>{
  db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,
   capability_id,dispatch_id,state,repository,repository_id,
   workflow_ref,ref,candidate_run_id,candidate_run_attempt,
   owner_run_id,owner_run_attempt,created_at,updated_at)
   VALUES(?,?,'launch','github.action',?,?,?,?,?,?,42,1,?,?,1,1)`)
  .run(run(index+10),run(index),'dispatch-'+index,state,
   action.repository,String(action.repositoryId),action.repository+'/'+action.workflowPath+'@refs/tags/release-v1',
   'refs/tags/release-v1',owner?42:null,owner?1:null);
 };
 return {db,adapter,claim};
}
test('four concurrent Sessions reserve distinct slots, fifth denied until physically settled',async()=>{
 const f=fixture();
 try{
  const result=await Promise.all([1,2,3,4].map(i=>reservePublishedSessionSlot(f.adapter,run(i),'launch')));
  assert.deepEqual(result,['reserved','reserved','reserved','reserved']);
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'existing');
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(5),'launch'),'full');
  const slots=f.db.prepare("SELECT slot FROM session_executions WHERE state!='terminated' ORDER BY slot")
   .all().map(x=>x.slot);
  assert.deepEqual(slots,[1,2,3,4]);
  f.db.prepare("UPDATE session_executions SET state='ready' WHERE run_id=?").run(run(1));
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(5),'launch'),'full');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
  f.claim(1,'claimed',true);
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
  f.db.prepare("UPDATE step_attempts SET state='succeeded' WHERE run_id=?").run(run(1));
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'released');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'already_released');
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(5),'launch'),'reserved');
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{f.db.close();}
});
test('uncertain and stopping Sessions keep capacity until a verified physical terminal',async()=>{
 const f=fixture();
 try{
  for(let i=1;i<=4;i++)assert.equal(await reservePublishedSessionSlot(f.adapter,run(i),'launch'),'reserved');
  f.db.exec("UPDATE session_executions SET state='uncertain' WHERE slot=1");
  f.db.exec("UPDATE session_executions SET state='stopping' WHERE slot=2");
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(5),'launch'),'full');
  f.claim(2,'failed',false); // Verified failure before OIDC Claim.
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(2),'launch'),'released');
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(5),'launch'),'reserved');
 }finally{f.db.close();}
});
test('publication, identity, and terminal parent are required before Session admission',async()=>{
 const f=fixture();
 try{
  const changed={...plan,github_action_approvals:[]};
  f.db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(changed),'v');
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'denied');
  f.db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(plan),'v');
  f.db.prepare("UPDATE runs SET outcome='cancelled' WHERE id=?").run(run(1));
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'denied');
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(2),'other'),'denied');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_executions').get()?.n,0);
 }finally{f.db.close();}
});

test('existing Workflow status and result preserve Session record after parent succeeds',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.prepare("UPDATE session_executions SET state='ready' WHERE run_id=?").run(run(1));
  f.db.prepare("UPDATE runs SET outcome='succeeded',start_state='started' WHERE id=?").run(run(1));
  f.db.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
    VALUES(?,'launch','succeeded',1)`).run(run(1));
  const env={DB:f.adapter,WORKFLOW:{}} as Env;
  const service=new WorkflowService(env);
  const status=await service.status(run(1));
  assert.equal(status.status,'succeeded');
  assert.equal(status.steps[0]?.status,'succeeded');
  assert.equal(status.sessions?.[0]?.recorded_state,'ready');
  assert.equal(status.sessions?.[0]?.physical_health,'unverified');
  const result=await service.result(run(1));
  assert.equal(result.sessions?.[0]?.recorded_state,'ready');
  assert.equal(result.sessions?.[0]?.physical_health,'unverified');
 }finally{f.db.close();}
});

test('verified physical GitHub completion after parent Ready still settles and frees Session slot',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.prepare("UPDATE session_executions SET state='ready' WHERE run_id=?").run(run(1));
  f.db.prepare("UPDATE runs SET outcome='succeeded',start_state='started' WHERE id=?").run(run(1));
  f.claim(1,'claimed',true);
  let physicalReads=0;
  const settled=await reconcilePersistedGitHubActionAttempt(f.adapter,run(11),'token',
    (database,id,credential)=>inspectPersistedGitHubActionAttempt(database,id,credential,
      async(identity,physicalRunId,physicalAttempt,bearer,ref)=>{
        physicalReads++;
        assert.equal(identity.repository,action.repository);
        assert.equal(physicalRunId,42);
        assert.equal(physicalAttempt,1);
        assert.equal(bearer,'token');
        assert.equal(ref,'refs/tags/release-v1');
        return {state:'completed',conclusion:'success'};
      }));
  assert.equal(settled,'updated');
  assert.equal(physicalReads,1);
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'succeeded');
  assert.equal(f.db.prepare('SELECT outcome FROM runs WHERE id=?').get(run(1))?.outcome,'succeeded');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'released');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
 }finally{f.db.close();}
});
