import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {decideSessionAdmission} from '../src/session-device-authority.ts';
import type {Env} from '../src/store.ts';

const attemptId='11111111-1111-4111-8111-111111111111';
const runId='22222222-2222-4222-8222-222222222222';
const action={repository:'lirtual/github-actions',repositoryId:1430925009,workflowId:456,
  workflowPath:'.github/workflows/ubuntu.yml',commitSha:'a'.repeat(40),
  type:'session' as const,contractDigest:'b'.repeat(64)};
const ref='refs/tags/release-v1';
const plan={github_execution_approved:true,github_action_approvals:[action],
  steps:[{id:'launch',uses:'github.run',with:{capability:'github.action',
    action:{...action,ref,inputs:{duration_mode:'explicit',duration_minutes:20}}}}]};

function fixture(onRead?: (readCount:number)=>void){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001_s1.sql','0014_workflow_deletion.sql',
      '0002_native_complete_seen.sql','0003_s3_attempt_claim.sql',
      '0004_s3_callback_receipts.sql','0005_github_workflow_check.sql']){
    db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  db.exec('BEGIN');
  for(const name of ['0006_action_attempt_capabilities.sql',
      '0007_session_executions.sql','0008_session_locator.sql',
      '0009_fixed_sessions.sql','0011_awaited_child_capacity.sql',
      '0019_session_rca_duration.sql']){
    db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  db.exec('COMMIT');
  db.prepare(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
    VALUES('wf','wf','{}',1,'active',1,1)`).run();
  db.prepare(`INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at)
    VALUES('v','wf','x',?,1)`).run(JSON.stringify(plan));
  db.prepare(`INSERT INTO runs(id,workflow_id,version_id,instance_id,
    request_digest,inputs,outcome,created_at,updated_at)
    VALUES(?,'wf','v','session-attempt','x','{}','succeeded',1,1)`).run(runId);
  db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,
    capability_id,dispatch_id,state,repository,repository_id,workflow_ref,
    ref,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,
    created_at,updated_at)
    VALUES(?,?,'launch','github.action','dispatch','claimed',?,?,?, ?,123,2,123,2,1,1)`)
      .run(attemptId,runId,action.repository,String(action.repositoryId),
        action.repository+'/'+action.workflowPath+'@'+ref,ref);
  db.prepare(`INSERT INTO session_executions
    (run_id,step_id,slot,state,created_at,updated_at)
    VALUES(?,'launch',1,'ready',1,1)`).run(runId);
  let readCount=0;
  const adapter={prepare:(sql:string)=>({bind:(...values:unknown[])=>({
    first:async<T>()=>{
      const result=db.prepare(sql).get(...(values as []))??null;
      onRead?.(++readCount);
      return result as T|null;
    },
  })})} as unknown as D1Database;
  const env={DB:adapter,WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token',
    GITHUB_ACTION_OIDC_AUDIENCE:'test-audience'} as Env;
  const services={oidc:async()=>true,physical:async()=>({state:'running' as const}),
    jobStart:async()=>Date.now()-60_000};
  const admit=(overrides:object={})=>decideSessionAdmission(env,
    {attempt_id:attemptId,oidc_jwt:'signed-jwt'}, {...services,...overrides});
  const cancel=()=>db.prepare(`INSERT INTO github_action_cancellations
    (attempt_id,run_id,step_id,cancel_requested_at)
    VALUES(?,?,'launch',1)`).run(attemptId,runId);
  return {db,admit,cancel};
}

test('real D1 migration and persisted ready attempt allow reviewed physical Session',async()=>{
  const f=fixture();
  try {
    const result=await f.admit();
    assert.equal(result.allowed,true);
    if(result.allowed){
      assert.equal(result.github_run_id,123);
      assert.equal(result.github_run_attempt,2);
      assert.equal(result.workflow_name,'ubuntu');
    }
  }finally{f.db.close();}
});

test('durable cancellation committed before admission denies despite Ready parent',async()=>{
  const f=fixture();
  try {f.cancel();assert.deepEqual(await f.admit(),{allowed:false});}
  finally{f.db.close();}
});

test('cancellation committed after physical inspection but before final admission read denies',async()=>{
  const f=fixture();
  try {
    const result=await f.admit({jobStart:async()=>{
      f.cancel();
      return Date.now()-60_000;
    }});
    assert.deepEqual(result,{allowed:false});
  }finally{f.db.close();}
});

test('physical Session leaving Ready while inspection is in flight denies',async()=>{
  const f=fixture();
  try {
    const result=await f.admit({jobStart:async()=>{
      f.db.prepare(`UPDATE session_executions SET state='stopping' WHERE run_id=?`).run(runId);
      return Date.now()-60_000;
    }});
    assert.deepEqual(result,{allowed:false});
  }finally{f.db.close();}
});


test('expired during final cancellation read is denied at the return boundary',async t=>{
  const started=Date.parse('2026-10-30T00:00:00Z');
  const deadline=started+20*60_000;
  let now=deadline-1;
  let reads=0;
  t.mock.method(Date,'now',()=>now);
  const f=fixture(count=>{
    reads=count;
    if(count===2) now=deadline+1;
  });
  try {
    const result=await f.admit({jobStart:async()=>started});
    assert.equal(reads,2,'the final D1 read must have occurred');
    assert.deepEqual(result,{allowed:false});
  }finally{f.db.close();}
});
