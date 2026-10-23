import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  SignJWT,generateKeyPair,exportJWK,createLocalJWKSet,
} from 'jose';
import {
  registerGithubAttempt,recordGithubDispatchResult,verifyAndClaimGithubAttempt,
  type AttemptDatabase,type ExecutorIdentity,type AttemptRegistration,
} from '../src/github-claim.ts';
import { recordGithubCallback,notifyStoredGithubReceipt } from '../src/github-callback.ts';

const runId='run-github-fixture';
const attemptId='b6835141-0b3a-4fcb-a9ae-b4b75bfae93c';
const dispatchId='d9b3439b-b7ed-4812-9064-75c925f93c6a';
const identity:ExecutorIdentity={
  repository:'lirtual/test-executor',repositoryId:'987654321',
  workflowRef:'lirtual/test-executor/.github/workflows/workflow-github-executor.yml@refs/heads/main',
  ref:'refs/heads/main',audience:'workflow-github-claim:test',
};
const registration:AttemptRegistration={
  ...identity,attemptId,dispatchId,runId,stepId:'heavy',capabilityId:'github.workflow.check',
};

function setup(t:test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql','0007_run_cancel.sql','0008_grant_revocation.sql','0009_runtime_approval.sql','0010_child_run.sql']){
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  sqlite.prepare(`INSERT INTO workflows (id,name,draft,created_at,updated_at)
    VALUES (?,?,?,?,?)`).run('wf-github-fixture','GitHub fixture','{}',1,1);
  sqlite.prepare(`INSERT INTO workflow_versions (id,workflow_id,digest,plan,created_at)
    VALUES (?,?,?,?,?)`).run('version-github-fixture','wf-github-fixture','test','{}',1);
  sqlite.prepare(`INSERT INTO runs
    (id,workflow_id,version_id,instance_id,request_digest,inputs,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    runId,'wf-github-fixture','version-github-fixture','instance-fixture','digest','{}',1,1,
  );
  const db={
    prepare(sql:string){
      let params:unknown[]=[];
      return {
        bind(...values:unknown[]){params=values;return this;},
        async first<T>(){return sqlite.prepare(sql).get(...params as any[]) as T|null;},
        async run(){const r=sqlite.prepare(sql).run(...params as any[]);return {meta:{changes:Number(r.changes)}};},
      };
    },
  } as unknown as AttemptDatabase;
  return {sqlite,db};
}
async function fixtureSigner(){
  const pair=await generateKeyPair('RS256');
  const jwk=await exportJWK(pair.publicKey);
  const keys=createLocalJWKSet({keys:[{...jwk,kid:'github-fixture',use:'sig',alg:'RS256'}]});
  async function issue(overrides:Record<string,unknown>={},expiry:string|number='5m'){
    const fields={
      repository:identity.repository,repository_id:identity.repositoryId,
      workflow_ref:identity.workflowRef,ref:identity.ref,
      run_id:'39410780231',run_attempt:'1',event_name:'workflow_dispatch',
      ...overrides,
    };
    return new SignJWT(fields).setProtectedHeader({alg:'RS256',kid:'github-fixture'})
      .setIssuer('https://token.actions.githubusercontent.com')
      .setAudience(identity.audience).setIssuedAt()
      .setExpirationTime(expiry).sign(pair.privateKey);
  }
  return {issue,keys};
}

test('registered, confirmed, signed GitHub candidate obtains exactly one D1 Claim',async t=>{
  const {db,sqlite}=setup(t);
  const {issue,keys}=await fixtureSigner();
  await registerGithubAttempt(db,registration);
  assert.equal(await recordGithubDispatchResult(db,attemptId,{
    status:'confirmed',runId:39410780231,runAttempt:1,
  }),true);
  const jwt=await issue();
  const results=await Promise.all([
    verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),
    verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),
  ]);
  assert.deepEqual(results.sort(),[false,true]);
  const row=sqlite.prepare('SELECT state,owner_run_id,owner_run_attempt FROM step_attempts WHERE attempt_id=?')
    .get(attemptId) as Record<string,unknown>;
  assert.deepEqual({...row},{state:'claimed',owner_run_id:39410780231,owner_run_attempt:1});
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),false);
});

test('unconfirmed and ambiguous dispatch states cannot Claim, even with signed identity',async t=>{
  const {db}=setup(t),{issue,keys}=await fixtureSigner();
  await registerGithubAttempt(db,registration);
  const jwt=await issue();
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),false);
  assert.equal(await recordGithubDispatchResult(db,attemptId,{status:'dispatch_unknown'}),true);
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),false);
  assert.equal(await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1}),false);
});

test('rejects signed wrong repo, ref, workflow, run, attempt, event and repository ID',async t=>{
  const {db,sqlite}=setup(t),{issue,keys}=await fixtureSigner();
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1});
  for(const payload of [
    {repository:'lirtual/other'},
    {repository_id:'9'},
    {workflow_ref:'lirtual/test-executor/.github/workflows/admin.yml@refs/heads/main'},
    {ref:'refs/heads/other'},
    {run_id:'39410780232'},
    {run_attempt:'2'},
    {event_name:'push'},
  ]){
    assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,await issue(payload),identity,keys),false);
  }
  const row=sqlite.prepare('SELECT state,owner_run_id FROM step_attempts WHERE attempt_id=?').get(attemptId) as Record<string,unknown>;
  assert.deepEqual({...row},{state:'confirmed',owner_run_id:null});
});

test('rejects forged, wrong-audience, and expired JWT before D1 Claim',async t=>{
  const {db}=setup(t),{issue,keys}=await fixtureSigner();
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1});
  const forged=(await fixtureSigner()).issue;
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,await forged(),identity,keys),false);
  assert.equal(await verifyAndClaimGithubAttempt(db,'not-an-allowed-id',await issue(),identity,keys),false);
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,await issue(),{...identity,audience:'workflow-github-other:test'},keys),false);
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,'not-a-jwt',identity,keys),false);
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,await issue({},Math.floor(Date.now()/1000)-60),identity,keys),false);
});

test('duplicate logical Run/Step or dispatch identities are rejected by D1 constraints',async t=>{
  const {db}=setup(t);
  await registerGithubAttempt(db,registration);
  await assert.rejects(registerGithubAttempt(db,{
    ...registration,attemptId:'b6835141-0b3a-4fcb-a9ae-b4b75bfae93d',
    dispatchId:'d9b3439b-b7ed-4812-9064-75c925f93d',
  }));
  await assert.rejects(registerGithubAttempt(db,{
    ...registration,attemptId:'b6835141-0b3a-4fcb-a9ae-b4b75bfae93d',
    stepId:'other',
  }));
});


test('authenticated callback is durable, idempotent and cannot be overwritten',async t=>{
  const {db,sqlite}=setup(t),{issue,keys}=await fixtureSigner();
  const jwt=await issue();
  const callbackId='f8835141-0b3a-4fcb-a9ae-b4b75bfae93c';
  const fact={attemptId,callbackId,outcome:'succeeded' as const,result:{message:'safe echo'}};
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1});
  assert.equal(await recordGithubCallback(db,fact,jwt,identity,keys),false,
    'not yet claimed must not accept callback');
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),true);
  assert.equal(await recordGithubCallback(db,fact,await issue({run_attempt:'2'}),identity,keys),false);
  assert.equal(await recordGithubCallback(db,fact,jwt,identity,keys),true);
  assert.equal(await recordGithubCallback(db,fact,jwt,identity,keys),true,
    'identical callback replay is safe');
  assert.equal(await recordGithubCallback(db,{
    ...fact,callbackId:'f8835141-0b3a-4fcb-a9ae-b4b75bfae93d',
  },jwt,identity,keys),false);
  assert.equal(await recordGithubCallback(db,{
    ...fact,result:{message:'different'},
  },jwt,identity,keys),false);
  assert.equal(await recordGithubCallback(db,{
    ...fact,result:{payload:'x'.repeat(5000)},
  },jwt,identity,keys),false);
  const row=sqlite.prepare('SELECT COUNT(*) AS total,result_json FROM callback_receipts')
    .get() as {total:number;result_json:string};
  assert.equal(row.total,1);
  assert.equal(row.result_json,JSON.stringify(fact.result));
});

test('failed notification leaves durable receipt pending for safe reconciliation',async t=>{
  const {db,sqlite}=setup(t),{issue,keys}=await fixtureSigner();
  const jwt=await issue();
  const callbackId='f8835141-0b3a-4fcb-a9ae-b4b75bfae93c';
  const fact={attemptId,callbackId,outcome:'failed' as const,result:{code:'test_failure'}};
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1});
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),true);
  assert.equal(await notifyStoredGithubReceipt(db,attemptId,async()=>{
    throw Error('must not notify before callback persisted');
  }),false);
  assert.equal(await recordGithubCallback(db,fact,jwt,identity,keys),true);
  let sends=0;
  await assert.rejects(notifyStoredGithubReceipt(db,attemptId,async()=>{
    sends++;
    throw Error('event connection unavailable');
  }),/event connection unavailable/);
  let status=sqlite.prepare('SELECT notification_delivered FROM callback_receipts')
    .get() as {notification_delivered:number};
  assert.equal(status.notification_delivered,0,'receipt survived failed wake');
  assert.equal(await notifyStoredGithubReceipt(db,attemptId,async event=>{
    sends++;
    assert.deepEqual(event,{attemptId,callbackId});
  }),true);
  assert.equal(await notifyStoredGithubReceipt(db,attemptId,async()=>{
    throw Error('already notified');
  }),true);
  status=sqlite.prepare('SELECT notification_delivered FROM callback_receipts')
    .get() as {notification_delivered:number};
  assert.equal(status.notification_delivered,1);
  assert.equal(sends,2);
});

test('late callback after cancellation cannot create a terminal receipt',async t=>{
  const {db,sqlite}=setup(t),{issue,keys}=await fixtureSigner();
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1});
  const jwt=await issue();
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),true);
  sqlite.prepare("UPDATE step_attempts SET state='cancelled' WHERE attempt_id=?").run(attemptId);
  assert.equal(await recordGithubCallback(db,{
    attemptId,callbackId:'f8835141-0b3a-4fcb-a9ae-b4b75bfae93c',
    outcome:'succeeded',result:{value:'late'},
  },jwt,identity,keys),false);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS total FROM callback_receipts')
    .get() as {total:number}).total,0);
});


test('a cancelled Run cannot authorize a new GitHub Claim even with valid signed OIDC',async t=>{
  const {db,sqlite}=setup(t),{issue,keys}=await fixtureSigner();
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1});
  sqlite.prepare("UPDATE runs SET outcome='cancelled' WHERE id=?").run(runId);
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,await issue(),identity,keys),false);
  const row=sqlite.prepare('SELECT state,owner_run_id FROM step_attempts WHERE attempt_id=?')
    .get(attemptId) as {state:string;owner_run_id:number|null};
  assert.equal(row.state,'confirmed');
  assert.equal(row.owner_run_id,null);
});

test('a cancelled Run refuses late success callbacks without mutating its durable outcome',async t=>{
  const {db,sqlite}=setup(t),{issue,keys}=await fixtureSigner();
  const jwt=await issue();
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{status:'confirmed',runId:39410780231,runAttempt:1});
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),true);
  sqlite.prepare("UPDATE runs SET outcome='cancelled' WHERE id=?").run(runId);
  const accepted=await recordGithubCallback(db,{
    attemptId,callbackId:'f8835141-0b3a-4fcb-a9ae-b4b75bfae93c',
    outcome:'succeeded',result:{message:'late'},
  },jwt,identity,keys);
  assert.equal(accepted,false);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM callback_receipts')
    .get() as {n:number}).n,0);
  assert.equal((sqlite.prepare('SELECT outcome FROM runs WHERE id=?')
    .get(runId) as {outcome:string}).outcome,'cancelled');
});

test('a valid very late GitHub callback cannot overwrite a terminally indeterminate Run',async t=>{
  const {db,sqlite}=setup(t),{issue,keys}=await fixtureSigner();
  const jwt=await issue();
  await registerGithubAttempt(db,registration);
  await recordGithubDispatchResult(db,attemptId,{
    status:'confirmed',runId:39410780231,runAttempt:1,
  });
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),true);
  // The native Workflow already exhausted its bounded callback window.
  sqlite.prepare("UPDATE runs SET outcome='indeterminate',error_code='github_callback_unconfirmed' WHERE id=?")
    .run(runId);
  const id='f8835141-0b3a-4fcb-a9ae-b4b75bfae93c';
  assert.equal(await recordGithubCallback(db,{
    attemptId,callbackId:id,outcome:'succeeded',result:{echo:'late'},
  },jwt,identity,keys),false);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM callback_receipts')
    .get() as {n:number}).n,0);
  const run=sqlite.prepare('SELECT outcome,error_code FROM runs WHERE id=?')
    .get(runId) as {outcome:string;error_code:string};
  assert.equal(run.outcome,'indeterminate');
  assert.equal(run.error_code,'github_callback_unconfirmed');
  // A signed Run cannot re-acquire a Claim or duplicate an external Job.
  assert.equal(await verifyAndClaimGithubAttempt(db,attemptId,jwt,identity,keys),false);
});
