import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {reservePublishedSessionSlot,releaseVerifiedSessionSlot,releaseNeverDispatchedSessionSlot,recordSignedSessionReady,runPublishedGitHubActionSession}
 from '../src/github-action-session.ts';
import {generateKeyPair,SignJWT} from 'jose';
import {handleGithubActionClaimRequest} from '../src/github-action-ingress.ts';
import {verifyAndClaimPinnedGitHubAction} from '../src/github-action-oidc-claim.ts';
import type {WorkflowStep} from 'cloudflare:workers';
import type {Plan} from '../src/plan.ts';
import {WorkflowService} from '../src/store.ts';
import {requestGitHubActionCancellation,FORCE_CANCEL_DELAY_MS} from '../src/github-action-cancel.ts';
import {watchPersistedSessions,sessionCancellationDue,SESSION_READY_GRACE_MS} from '../src/github-action-session-watch.ts';
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
 const adapter={prepare:(sql:string)=>{
  const statement=(args:unknown[])=>({
   first:async()=>db.prepare(sql).get(...args as []),
   all:async()=>({results:db.prepare(sql).all(...args as [])}),
   run:async()=>({meta:{changes:db.prepare(sql).run(...args as []).changes}}),
  });
  return {...statement([]),bind:(...args:unknown[])=>statement(args)};
 }} as any;
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
  assert.equal(status.sessions?.[0]?.private_hostname,null);
  const result=await service.result(run(1));
  assert.equal(result.sessions?.[0]?.recorded_state,'ready');
  assert.equal(result.sessions?.[0]?.physical_health,'unverified');
  assert.equal(result.sessions?.[0]?.private_hostname,null);
 }finally{f.db.close();}
});

test('status provides stable private Tailnet name only for signed Ready, never as online proof',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  f.db.prepare("UPDATE session_executions SET state='ready'").run();
  const service=new WorkflowService({DB:f.adapter,WORKFLOW:{}} as Env);
  const status=await service.status(run(1));
  assert.equal(status.sessions?.[0]?.private_hostname,'sa-42-a1');
  assert.equal(status.sessions?.[0]?.physical_health,'unverified');
  f.db.prepare("UPDATE session_executions SET state='stopping'").run();
  const stopping=await service.status(run(1));
  assert.equal(stopping.sessions?.[0]?.private_hostname,null);
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

const audience='workflow-github-action:production';
async function signedReady(claims:Record<string,unknown>={}){
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwt=await new SignJWT({
  repository:action.repository,repository_id:'123',
  workflow_ref:action.repository+'/'+action.workflowPath+'@refs/tags/release-v1',
  ref:'refs/tags/release-v1',sha:action.commitSha,
  run_id:'42',run_attempt:'1',event_name:'workflow_dispatch',...claims,
 }).setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 return {jwt,publicKey};
}
test('signed Ready must own the exact claimed physical running GitHub Session; duplicate is idempotent',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  const {jwt,publicKey}=await signedReady();
  let checked=0;
  const inspect=async()=>{
   checked++;return {state:'running' as const};
  };
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),jwt,audience,'token',publicKey,inspect),'ready');
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),jwt,audience,'token',publicKey,inspect),'already_ready');
  assert.equal(checked,2);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'ready');
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'claimed');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
 }finally{f.db.close();}
});
test('lost Ready HTTP receipt is idempotent even after parent Workflow succeeded',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  const {jwt,publicKey}=await signedReady();
  const inspect=async()=>({state:'running' as const});
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),jwt,audience,'token',
   publicKey,inspect),'ready');
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  // The first response can be lost after a durable D1 Ready and parent
  // completion. A signed duplicate must not be treated as a new late Ready.
  const env={DB:f.adapter,GITHUB_ACTION_OIDC_AUDIENCE:audience,
   WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as Env;
  const request=()=>new Request('https://worker.example/github/action/ready',{
   method:'POST',headers:{authorization:'Bearer '+jwt},
   body:JSON.stringify({attemptId:run(11)}),
  });
  const retry=await handleGithubActionClaimRequest(request(),env,publicKey,inspect);
  assert.equal(retry.status,200);
  assert.deepEqual(await retry.json(),{result:'already_ready'});
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'ready');
  // Replay exception must never reopen a first Claim for the finished Run.
  assert.equal(await verifyAndClaimPinnedGitHubAction(f.adapter,run(11),jwt,
   audience,publicKey),false);
  // A cancelled or stopping session cannot recover Ready via replay.
  f.db.prepare("UPDATE session_executions SET state='stopping'").run();
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),jwt,audience,
   'token',publicKey,inspect),'denied');
 }finally{f.db.close();}
});
test('terminal parent never authorizes a first late signed Ready',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  const {jwt,publicKey}=await signedReady();
  let fetched=0;
  const outcome=await recordSignedSessionReady(f.adapter,run(11),jwt,audience,'token',
   publicKey,async()=>{fetched++;return {state:'running'};});
  assert.equal(outcome,'denied');
  assert.equal(fetched,0);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'queued');
 }finally{f.db.close();}
});
test('cancel intent committed during physical readback prevents a late signed Ready CAS',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  const {jwt,publicKey}=await signedReady();
  let inspections=0;
  const status=await recordSignedSessionReady(f.adapter,run(11),jwt,audience,'token',
   publicKey,async()=>{
    inspections++;
    // The cancel POST has not yet been sent, and Session state is still
    // 'queued': the intent itself MUST fence a concurrent signed Ready.
    f.db.prepare(`INSERT INTO github_action_cancellations
      (attempt_id,run_id,step_id,cancel_requested_at,cancel_ack)
      VALUES(?,?,?,?,'unknown')`).run(run(11),run(1),'launch',Date.now());
    return {state:'running'};
   });
  assert.equal(inspections,1);
  assert.equal(status,'denied');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'queued');
  // Cancellation intent also disallows idempotent Ready response in the
  // interval before the Session row is updated to 'stopping'.
  f.db.prepare("UPDATE session_executions SET state='ready'").run();
  const replay=await recordSignedSessionReady(f.adapter,run(11),jwt,audience,
   'token',publicKey,async()=>({state:'running'}));
  assert.equal(replay,'denied');
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  const terminalParentReplay=await recordSignedSessionReady(f.adapter,run(11),jwt,
   audience,'token',publicKey,async()=>({state:'running'}));
  assert.equal(terminalParentReplay,'denied');
 }finally{f.db.close();}
});
test('bad signed identity, unclaimed owner, unknown or ended physical Job cannot set Ready',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  const good=await signedReady();
  let polls=0;
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),good.jwt,audience,'token',
    good.publicKey,async()=>{polls++;return {state:'running'};}),'denied');
  f.claim(1,'claimed',true);
  const wrong=await signedReady({sha:'c'.repeat(40)});
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),wrong.jwt,audience,'token',
    wrong.publicKey,async()=>{polls++;return {state:'running'};}),'denied');
  assert.equal(polls,0);
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),good.jwt,audience,'token',
    good.publicKey,async()=>({state:'unknown'})),'physical_unconfirmed');
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),good.jwt,audience,'token',
    good.publicKey,async()=>({state:'queued'})),'physical_unconfirmed');
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),good.jwt,audience,'token',
    good.publicKey,async()=>({state:'completed',conclusion:'failure'})),'denied');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'queued');
  f.db.prepare("UPDATE session_executions SET state='stopping'").run();
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),good.jwt,audience,'token',
    good.publicKey,async()=>({state:'running'})),'denied');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'stopping');
 }finally{f.db.close();}
});
test('HTTP Ready is OIDC-only and returns no private credentials; wake is advisory',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  const {jwt,publicKey}=await signedReady();
  let notifications=0;
  const env={DB:f.adapter,GITHUB_ACTION_OIDC_AUDIENCE:audience,
   WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token',
   WORKFLOW:{get:async()=>({sendEvent:async()=>{notifications++;}})}} as unknown as Env;
  const url='https://worker.example/github/action/ready';
  const request=()=>new Request(url,{method:'POST',headers:{authorization:'Bearer '+jwt},
   body:JSON.stringify({attemptId:run(11)})});
  const inspect=async()=>({state:'running' as const});
  const response=await handleGithubActionClaimRequest(request(),env,publicKey,inspect);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{result:'ready'});
  assert.equal(notifications,1);
  const repeat=await handleGithubActionClaimRequest(request(),env,publicKey,inspect);
  assert.equal(repeat.status,200);
  assert.deepEqual(await repeat.json(),{result:'already_ready'});
  assert.equal(notifications,1);
  const bad=await handleGithubActionClaimRequest(new Request(url,{method:'POST',
   headers:{authorization:'Bearer '+jwt},
   body:JSON.stringify({attemptId:run(11),access_token:'forged'})}),env,publicKey,inspect);
  assert.equal(bad.status,400);
 }finally{f.db.close();}
});

test('Session dispatches once, signed GitHub Claim and Ready complete startup but keep slot',async()=>{
 const f=fixture();
 try{
  const {jwt,publicKey}=await signedReady();
  let attemptId='',posts=0,waits=0;
  const http=async(request:Request):Promise<Response>=>{
   const path=new URL(request.url).pathname;
   if(path.endsWith('/git/ref/tags/release-v1'))
    return Response.json({ref:'refs/tags/release-v1',object:{type:'commit',sha:action.commitSha}});
   if(request.method==='POST'){
    posts++;
    const payload=await request.json() as {ref:string;inputs:{attempt_id:string;capability_id:string}};
    attemptId=payload.inputs.attempt_id;
    assert.equal(payload.inputs.capability_id,'github.action');
    assert.equal(payload.ref,'release-v1');
    return Response.json({workflow_run_id:42});
   }
   assert.ok(path.endsWith('/actions/runs/42'));
   return Response.json({
    id:42,workflow_id:456,run_attempt:1,
    repository:{id:123,full_name:action.repository},
    path:action.workflowPath+'@release-v1',head_sha:action.commitSha,
    event:'workflow_dispatch',status:'in_progress',conclusion:null,
   });
  };
  const workflow={
   do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
   waitForEvent:async()=>{
    waits++;
    assert.equal(await verifyAndClaimPinnedGitHubAction(f.adapter,attemptId,
      jwt,audience,publicKey),true);
    assert.equal(await recordSignedSessionReady(f.adapter,attemptId,jwt,audience,
      'token',publicKey,async()=>({state:'running'})),'ready');
    return {attemptId};
   },
  } as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token',
   GITHUB_ACTION_OIDC_AUDIENCE:audience} as Env;
  const outcome=await runPublishedGitHubActionSession(env,plan as unknown as Plan,
   (plan as unknown as Plan).steps[0],run(1),workflow,http);
  assert.deepEqual(outcome,{status:'succeeded',output:{session:{recorded_state:'ready'}}});
  assert.equal(posts,1);
  assert.equal(waits,1);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'ready');
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'claimed');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
  assert.equal(f.db.prepare('SELECT outcome FROM runs WHERE id=?').get(run(1))?.outcome,'running');
 }finally{f.db.close();}
});
test('fifth Session is rejected before any GitHub outbound request',async()=>{
 const f=fixture();
 try{
  for(let i=1;i<=4;i++)
   assert.equal(await reservePublishedSessionSlot(f.adapter,run(i),'launch'),'reserved');
  let requests=0;
  const workflow={do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb()} as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token',
   GITHUB_ACTION_OIDC_AUDIENCE:audience} as Env;
  const outcome=await runPublishedGitHubActionSession(env,plan as unknown as Plan,
   (plan as unknown as Plan).steps[0],run(5),workflow,async()=>{
     requests++;return new Response(null,{status:500});
   });
  assert.equal(outcome.status,'failed');
  assert.equal(outcome.error_code,'github_session_capacity_exceeded');
  assert.equal(requests,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM session_executions').get()?.n,4);
 }finally{f.db.close();}
});

test('workflow_status reconciles a Ready Session after parent success and releases slot only on physical terminal',async()=>{
 const f=fixture(),originalFetch=globalThis.fetch;
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.prepare("UPDATE session_executions SET state='ready'").run();
  f.db.prepare("UPDATE runs SET outcome='succeeded',start_state='started' WHERE id=?").run(run(1));
  f.claim(1,'claimed',true);
  let inspected=0;
  globalThis.fetch=async(input:RequestInfo|URL)=>{
   inspected++;
   const req=input instanceof Request?input:new Request(input);
   assert.ok(new URL(req.url).pathname.endsWith('/actions/runs/42'));
   return Response.json({
    id:42,workflow_id:456,run_attempt:1,repository:{id:123,full_name:action.repository},
    path:action.workflowPath+'@release-v1',head_sha:action.commitSha,
    event:'workflow_dispatch',status:'completed',conclusion:'failure',
   });
  };
  const service=new WorkflowService({DB:f.adapter,WORKFLOW:{},
   WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as unknown as Env);
  const result=await service.status(run(1));
  assert.equal(inspected,1);
  assert.equal(result.status,'succeeded');
  assert.equal(result.sessions?.[0]?.recorded_state,'terminated');
  assert.equal(result.sessions?.[0]?.physical_health,'terminated');
  assert.equal(result.sessions?.[0]?.attempt_state,'failed');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});
test('GitHub status outage cannot release Session quota even if parent succeeded',async()=>{
 const f=fixture(),originalFetch=globalThis.fetch;
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.prepare("UPDATE session_executions SET state='ready'").run();
  f.db.prepare("UPDATE runs SET outcome='succeeded',start_state='started' WHERE id=?").run(run(1));
  f.claim(1,'claimed',true);
  globalThis.fetch=async()=>new Response(null,{status:503});
  const service=new WorkflowService({DB:f.adapter,WORKFLOW:{},
   WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as unknown as Env);
  const result=await service.status(run(1));
  assert.equal(result.sessions?.[0]?.recorded_state,'ready');
  assert.equal(result.sessions?.[0]?.physical_health,'unverified');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});

test('normal cancel is one-shot and 202 never releases Session capacity; force is separately timed',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  let clock=500_000;
  const observed=async()=>({state:'running' as const});
  const requests:string[]=[];
  const http=async(req:Request)=>{
   assert.equal(req.method,'POST');
   assert.equal(req.redirect,'manual');
   assert.equal(req.headers.get('authorization'),'Bearer token');
   requests.push(new URL(req.url).pathname);
   return new Response(null,{status:202});
  };
  const invoke=(force=false)=>requestGitHubActionCancellation(f.adapter,run(1),'launch',
   'token',force,http,observed,()=>clock);
  assert.equal(await invoke(true),'normal_required');
  assert.equal(await invoke(),'cancel_requested');
  assert.equal(await invoke(),'already_requested');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'stopping');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
  clock+=FORCE_CANCEL_DELAY_MS-1;
  assert.equal(await invoke(true),'too_early');
  clock++;
  assert.equal(await invoke(true),'force_requested');
  assert.equal(await invoke(true),'already_force_requested');
  assert.deepEqual(requests,[
   '/repos/lirtual/session-actions/actions/runs/42/cancel',
   '/repos/lirtual/session-actions/actions/runs/42/force-cancel',
  ]);
  const record=f.db.prepare('SELECT cancel_ack,force_ack FROM github_action_cancellations').get();
  assert.equal(record?.cancel_ack,'accepted');
  assert.equal(record?.force_ack,'accepted');
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'claimed');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'stopping');
 }finally{f.db.close();}
});
test('durable cancel intent still sends exactly one POST if advisory stopping write fails',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  let writes=0,posts=0;
  const db={prepare:(sql:string)=>{
   if(sql.includes("UPDATE session_executions SET state='stopping'")){
    writes++;
    throw Error('D1 temporary state-update failure');
   }
   return f.adapter.prepare(sql);
  }} as unknown as D1Database;
  const result=await requestGitHubActionCancellation(db,run(1),'launch','token',false,
   async(request)=>{
    posts++;
    assert.ok(new URL(request.url).pathname.endsWith('/actions/runs/42/cancel'));
    return new Response(null,{status:202});
   },async()=>({state:'running'}));
  assert.equal(result,'cancel_requested');
  assert.equal(writes,1);
  assert.equal(posts,1);
  assert.equal(f.db.prepare('SELECT cancel_ack FROM github_action_cancellations').get()?.cancel_ack,'accepted');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'queued');
  const {jwt,publicKey}=await signedReady();
  // Cancellation intent is sufficient to fence new Ready, independently
  // of the secondary Session state write that failed.
  assert.equal(await recordSignedSessionReady(f.adapter,run(11),jwt,audience,
   'token',publicKey,async()=>({state:'running'})),'denied');
  assert.equal(await requestGitHubActionCancellation(f.adapter,run(1),'launch',
   'token',false,async()=>{posts++;throw Error('duplicate POST');},
   async()=>({state:'running'})),'already_requested');
  assert.equal(posts,1);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'stopping');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
 }finally{f.db.close();}
});
test('lost GitHub cancellation ACK is not retried; no unverified force or quota release',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  let calls=0,clock=500_000;
  const http=async()=>{calls++;throw Error('transport failed after POST');};
  const inspect=async()=>({state:'running' as const});
  const invoke=(force=false)=>requestGitHubActionCancellation(f.adapter,run(1),'launch',
   'token',force,http,inspect,()=>clock);
  assert.equal(await invoke(),'cancel_unknown');
  assert.equal(await invoke(),'already_requested');
  assert.equal(calls,1);
  clock+=FORCE_CANCEL_DELAY_MS;
  assert.equal(await invoke(true),'force_unknown');
  assert.equal(await invoke(true),'already_force_requested');
  assert.equal(calls,2);
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'stopping');
 }finally{f.db.close();}
});
test('a confirmed GitHub terminal cancels without POST, releases quota, and never corrupts parent',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  let calls=0;
  const result=await requestGitHubActionCancellation(f.adapter,run(1),'launch',
   'token',false,async()=>{calls++;throw Error('must not POST');},
   async()=>({state:'completed' as const,conclusion:'cancelled' as const}));
  assert.equal(result,'terminal_confirmed');
  assert.equal(calls,0);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'cancelled');
  assert.equal(f.db.prepare('SELECT outcome FROM runs WHERE id=?').get(run(1))?.outcome,'succeeded');
 }finally{f.db.close();}
});
test('ambiguous physical identity denies GitHub POST and keeps Session Ready',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.exec("UPDATE session_executions SET state='ready'");
  f.claim(1,'claimed',true);
  let calls=0;
  const state=await requestGitHubActionCancellation(f.adapter,run(1),'launch',
   'token',false,async()=>{calls++;throw Error('should not send');},
   async()=>({state:'identity_mismatch' as const}));
  assert.equal(state,'physical_unconfirmed');
  assert.equal(calls,0);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'ready');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM github_action_cancellations').get()?.n,0);
 }finally{f.db.close();}
});

test('native Workflow keeps monitoring physical Session after parent Ready without a user status query',async()=>{
 const f=fixture(),originalFetch=globalThis.fetch;
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.prepare("UPDATE session_executions SET state='ready',updated_at=?").run(Date.now());
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  f.claim(1,'claimed',true);
  let observations=0,sleeps=0;
  globalThis.fetch=async(input:RequestInfo|URL)=>{
   const request=input instanceof Request?input:new Request(input);
   assert.equal(request.method,'GET');
   observations++;
   return Response.json({
    id:42,workflow_id:456,run_attempt:1,
    repository:{id:123,full_name:action.repository},
    path:action.workflowPath+'@release-v1',head_sha:action.commitSha,
    event:'workflow_dispatch',status:observations===1?'in_progress':'completed',
    conclusion:observations===1?null:'success',
   });
  };
  const workflow={
   do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
   sleep:async()=>{sleeps++;},
  } as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as Env;
  assert.equal(await watchPersistedSessions(env,run(1),workflow,3),'terminated');
  assert.equal(observations,2);
  assert.equal(sleeps,1);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
  assert.equal(f.db.prepare('SELECT outcome FROM runs WHERE id=?').get(run(1))?.outcome,'succeeded');
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});
test('watcher requests normal expiry cancellation once but never force or release on active job',async()=>{
 const f=fixture(),originalFetch=globalThis.fetch;
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  f.db.prepare("UPDATE session_executions SET state='ready',updated_at=1000").run();
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  const time=1000+5*60_000+SESSION_READY_GRACE_MS;
  let posts=0,reads=0;
  globalThis.fetch=async(input:RequestInfo|URL)=>{
   const req=input instanceof Request?input:new Request(input);
   if(req.method==='POST'){
    assert.ok(new URL(req.url).pathname.endsWith('/actions/runs/42/cancel'));
    posts++;return new Response(null,{status:202});
   }
   reads++;
   return Response.json({id:42,workflow_id:456,run_attempt:1,
    repository:{id:123,full_name:action.repository},
    path:action.workflowPath+'@release-v1',head_sha:action.commitSha,
    event:'workflow_dispatch',status:'in_progress',conclusion:null});
  };
  const workflow={
   do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
  } as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as Env;
  assert.equal(await watchPersistedSessions(env,run(1),workflow,1,()=>time),'unverified');
  assert.equal(posts,1);
  assert.ok(reads>=2);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'stopping');
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'claimed');
  assert.equal(await watchPersistedSessions(env,run(1),workflow,1,()=>time+1),'unverified');
  assert.equal(posts,1);
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});
test('unconfirmed dispatch or GitHub outage retains four-slot reservation without false expiry',async()=>{
 const f=fixture(),originalFetch=globalThis.fetch;
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  let sleeps=0;
  const workflow={
   do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
   sleep:async()=>{sleeps++;},
  } as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as Env;
  assert.equal(await watchPersistedSessions(env,run(1),workflow,2),'unverified');
  assert.equal(sleeps,1);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'queued');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});
test('fallback elapsed-time rule cannot shorten true job duration and rejects invalid limits',()=>{
 assert.equal(sessionCancellationDue({state:'ready',created_at:100,updated_at:1000,duration_minutes:330},
  1000+330*60_000+SESSION_READY_GRACE_MS-1),false);
 assert.equal(sessionCancellationDue({state:'ready',created_at:100,updated_at:1000,duration_minutes:330},
  1000+330*60_000+SESSION_READY_GRACE_MS),true);
 assert.equal(sessionCancellationDue({state:'ready',created_at:100,updated_at:1000,duration_minutes:331},1e12),false);
 assert.equal(sessionCancellationDue({state:'stopping',created_at:100,updated_at:1000,duration_minutes:5},1e12),false);
});

test('abandoned pre-Attempt reservation is released only after terminal parent and 30-minute grace',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.prepare("UPDATE session_executions SET created_at=1000 WHERE run_id=?").run(run(1));
  const expiredAt=1000+30*60_000;
  assert.equal(await releaseNeverDispatchedSessionSlot(f.adapter,run(1),'launch',expiredAt),false);
  f.db.prepare("UPDATE runs SET outcome='indeterminate' WHERE id=?").run(run(1));
  assert.equal(await releaseNeverDispatchedSessionSlot(f.adapter,run(1),'launch',999),false);
  assert.equal(await releaseNeverDispatchedSessionSlot(f.adapter,run(1),'launch',expiredAt),true);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(2),'launch'),'reserved');
 }finally{f.db.close();}
});
test('a registered unknown-dispatch Attempt keeps Session quota after parent failure',async()=>{
 const f=fixture();
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  f.db.prepare("UPDATE step_attempts SET state='dispatch_unknown',owner_run_id=NULL,owner_run_attempt=NULL,candidate_run_id=NULL,candidate_run_attempt=NULL WHERE run_id=?").run(run(1));
  f.db.prepare("UPDATE session_executions SET created_at=1000").run();
  f.db.prepare("UPDATE runs SET outcome='indeterminate' WHERE id=?").run(run(1));
  assert.equal(await releaseNeverDispatchedSessionSlot(f.adapter,run(1),'launch',50000000),false);
  const step={do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb()} as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as Env;
  assert.equal(await watchPersistedSessions(env,run(1),step,1,()=>50000000),'unverified');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'queued');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
 }finally{f.db.close();}
});
test('unattended watcher reclaims confirmed never-dispatched reservation without a GitHub request',async()=>{
 const f=fixture(),oldFetch=globalThis.fetch;
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.db.prepare("UPDATE session_executions SET created_at=1000").run();
  f.db.prepare("UPDATE runs SET outcome='indeterminate' WHERE id=?").run(run(1));
  globalThis.fetch=async()=>{throw Error('must not contact GitHub without an Attempt');};
  const step={do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb()} as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as Env;
  assert.equal(await watchPersistedSessions(env,run(1),step,1,()=>3000000),'terminated');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
 }finally{globalThis.fetch=oldFetch;f.db.close();}
});
test('transient D1 outage does not permanently stop unattended Session reconciliation',async()=>{
 const f=fixture(),originalFetch=globalThis.fetch;
 try{
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(1),'launch'),'reserved');
  f.claim(1,'claimed',true);
  f.db.prepare("UPDATE session_executions SET state='ready',updated_at=?").run(Date.now());
  f.db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run(1));
  let failures=0,sleeps=0,reads=0;
  const db={prepare:(sql:string)=>{
   if(sql.includes("json_extract(v.plan")&&failures++===0)
    throw Error('transient D1 outage');
   return f.adapter.prepare(sql);
  }} as unknown as D1Database;
  globalThis.fetch=async()=>{
   reads++;
   return Response.json({
    id:42,workflow_id:456,run_attempt:1,
    repository:{id:123,full_name:action.repository},
    path:action.workflowPath+'@release-v1',head_sha:action.commitSha,
    event:'workflow_dispatch',status:'completed',conclusion:'success',
   });
  };
  const step={
   do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb(),
   sleep:async()=>{sleeps++;},
  } as unknown as WorkflowStep;
  const env={DB:db,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token'} as Env;
  assert.equal(await watchPersistedSessions(env,run(1),step,3),'terminated');
  assert.equal(sleeps,1);
  assert.equal(reads,1);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});

test('reviewed Session Run admission is allowed with server credentials and does not bypass physical slot gate',async()=>{
 const f=fixture();
 try{
  f.db.prepare("UPDATE workflows SET active_version_id='v' WHERE id='wf'").run();
  let created=0;
  const env={DB:f.adapter,
   WORKFLOW_EXECUTOR_GITHUB_TOKEN:'private-test-token',
   GITHUB_ACTION_OIDC_AUDIENCE:'workflow-github-action:production',
   WORKFLOW:{create:async()=>{created++;}}
  } as unknown as Env;
  const service=new WorkflowService(env);
  const started=await service.start('wf',{},'reviewed-session-admission');
  assert.equal(started.start_state,'started');
  assert.equal(started.status,'queued');
  assert.equal(created,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM session_executions').get()?.n,0);
  // Replaying the same request never creates a second physical/session Run.
  const repeated=await service.start('wf',{},'reviewed-session-admission');
  assert.equal(repeated.run_id,started.run_id);
  assert.equal(created,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM session_executions').get()?.n,0);
 }finally{f.db.close();}
});
test('Session admission fails before Run reservation if the Action executor is not configured',async()=>{
 const f=fixture();
 try{
  f.db.prepare("UPDATE workflows SET active_version_id='v' WHERE id='wf'").run();
  let created=0;
  const env={DB:f.adapter,WORKFLOW:{create:async()=>{created++;}}} as unknown as Env;
  const service=new WorkflowService(env);
  const before=f.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n;
  await assert.rejects(service.start('wf',{}),/github_action_executor_not_configured/);
  assert.equal(created,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n,before);
 }finally{f.db.close();}
});

test('definitively rejected GitHub dispatch releases a Session slot with no physical Run',async()=>{
 const f=fixture();
 try{
  const workflow={do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb()} as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token',
   GITHUB_ACTION_OIDC_AUDIENCE:audience} as Env;
  let posts=0;
  const response=await runPublishedGitHubActionSession(env,plan as unknown as Plan,
   (plan as unknown as Plan).steps[0],run(1),workflow,async req=>{
    if(req.method==='GET')return Response.json({ref:'refs/tags/release-v1',
      object:{type:'commit',sha:action.commitSha}});
    posts++;return new Response(null,{status:422});
   });
  assert.deepEqual(response,{status:'failed',error_code:'github_session_dispatch_rejected'});
  assert.equal(posts,1);
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'rejected');
  assert.equal(f.db.prepare('SELECT candidate_run_id FROM step_attempts').get()?.candidate_run_id,null);
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'terminated');
  assert.equal(await reservePublishedSessionSlot(f.adapter,run(2),'launch'),'reserved');
 }finally{f.db.close();}
});
test('unknown outbound dispatch ACK never releases a Session slot or posts twice',async()=>{
 const f=fixture();
 try{
  const workflow={do:async(_name:string,_opts:unknown,cb:()=>Promise<unknown>)=>cb()} as unknown as WorkflowStep;
  const env={DB:f.adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'token',
   GITHUB_ACTION_OIDC_AUDIENCE:audience} as Env;
  let posts=0;
  const response=await runPublishedGitHubActionSession(env,plan as unknown as Plan,
   (plan as unknown as Plan).steps[0],run(1),workflow,async req=>{
    if(req.method==='GET')return Response.json({ref:'refs/tags/release-v1',
      object:{type:'commit',sha:action.commitSha}});
    posts++;throw Error('GitHub may have accepted before ACK was lost');
   });
  assert.deepEqual(response,{status:'indeterminate',error_code:'github_session_dispatch_unknown'});
  assert.equal(posts,1);
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'dispatch_unknown');
  assert.equal(f.db.prepare('SELECT state FROM session_executions').get()?.state,'queued');
  assert.equal(await releaseVerifiedSessionSlot(f.adapter,run(1),'launch'),'held');
 }finally{f.db.close();}
});
