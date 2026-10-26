import type {WorkflowStep} from 'cloudflare:workers';
import type {Env} from './store.ts';
import {publishedGitHubActionStep,publishedForeachTaskController,type Step} from './plan.ts';
import {registerAndDispatchGitHubAction} from './github-action-orchestration.ts';
import {reconcilePersistedGitHubActionAttempt} from './github-action-attempt-reconcile.ts';
import {inspectGitHubActionRun} from './github-action-run-inspection.ts';
import {verifyPinnedGitHubActionIdentity,type GithubActionKeys} from './github-action-oidc-claim.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import type {Plan} from './plan.ts';

type Db=Pick<D1Database,'prepare'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TUNNEL_URL=/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\/?$/;
const WEB_PATHS=new Set(['.github/workflows/chrome.yml',
  '.github/workflows/code-server.yml','.github/workflows/openlist.yml']);
export type SessionReservation='reserved'|'existing'|'fixed_conflict'|'full'|'denied';
export type SessionRelease='released'|'already_released'|'held';

/**
 * Reserve one of four durable physical Session slots in a single SQL write.
 * Reservation never follows a callback, an ACK, or parent Workflow success.
 * It must happen before the corresponding physical Session dispatch.
 */
export function isGoOpenListDownloadAction(action:ReviewedGitHubAction):boolean{
 return action.type==='task'&&action.repository==='lirtual/session-actions'&&
  action.workflowPath==='.github/workflows/download.yml';
}

export function planHasGoOpenListDownload(plan:Plan):boolean{
 return Array.isArray(plan.steps)&&plan.steps.some(step=>{
  if(step.uses!=='flow.foreach'||step.with.max_items!==1)return false;
  const template=step.with.template as {uses?:unknown;with?:{action?:ReviewedGitHubAction}}|undefined;
  return template?.uses==='github.run'&&!!template.with?.action&&
   isGoOpenListDownloadAction(template.with.action);
 });
}

export async function reservePublishedSessionSlot(
 db:Db,runId:string,stepId:string,
):Promise<SessionReservation>{
 return reservePhysicalActionSlot(db,runId,stepId,'session');
}

export async function reserveGoOpenListDownloadSlot(
 db:Db,runId:string,stepId:string,
):Promise<SessionReservation>{
 return reservePhysicalActionSlot(db,runId,stepId,'download');
}

async function reservePhysicalActionSlot(
 db:Db,runId:string,stepId:string,kind:'session'|'download',
):Promise<SessionReservation>{
 if(!UUID.test(runId)||!STEP.test(stepId))return 'denied';
 const source=await db.prepare(`SELECT r.outcome,v.plan
   FROM runs r JOIN workflow_versions v ON v.id=r.version_id WHERE r.id=?`)
  .bind(runId).first<{outcome:string;plan:string}>();
 if(!source||!['queued','running'].includes(source.outcome))return 'denied';
 let plan:Plan;
 try{plan=JSON.parse(source.plan) as Plan;}
 catch{return 'denied';}
 if(plan.github_execution_approved!==true||!Array.isArray(plan.steps))return 'denied';
 const step=publishedGitHubActionStep(plan,stepId);
 if(!step||step.with.capability!=='github.action')return 'denied';
 const raw=step.with.action as (ReviewedGitHubAction & {ref?:unknown;inputs?:unknown})|undefined;
 if(!raw||raw.type!==(kind==='session'?'session':'task'))return 'denied';
 const reviewed:ReviewedGitHubAction={
  repository:raw.repository,repositoryId:raw.repositoryId,workflowId:raw.workflowId,
  workflowPath:raw.workflowPath,commitSha:raw.commitSha,
  type:raw.type,contractDigest:raw.contractDigest,
 };
 if(!isPublishedGitHubActionApproved(plan.github_action_approvals,reviewed))return 'denied';
 if(kind==='download'){
  if(!isGoOpenListDownloadAction(reviewed))return 'denied';
  const controller=publishedForeachTaskController(plan,stepId);
  const spec=controller?.with.template as {with?:{action?:{inputs?:unknown}}}|undefined;
  const fields=spec?.with?.action?.inputs;
  if(!controller||controller.with.max_items!==1||!fields||typeof fields!=='object'||
     Array.isArray(fields)||Object.keys(fields).length!==1||
     (fields as {batch_json?:{ref?:unknown}}).batch_json?.ref!=='item.value')return 'denied';
 }

 const declaredInputs=raw.inputs;
 const mode=declaredInputs&&typeof declaredInputs==='object'&&!Array.isArray(declaredInputs)
  ?(declaredInputs as Record<string,unknown>).session_mode:undefined;
 if(kind==='session'&&mode!==undefined&&mode!=='fixed'&&mode!=='temporary')return 'denied';
 // Shared Go OpenList resource is exclusive even for temporary Sessions.
 // Unrelated fixed/temporary Sessions keep their original isolation rules.
 const goResource=reviewed.repository==='lirtual/session-actions'&&(
  (kind==='session'&&reviewed.workflowPath==='.github/workflows/openlist.yml')||
  (kind==='download'&&isGoOpenListDownloadAction(reviewed)));
 const fixedKey=goResource?String(reviewed.repositoryId)+':go-openlist':
  mode==='fixed'?String(reviewed.repositoryId)+':'+reviewed.workflowPath:null;
 const created=await db.prepare(`INSERT OR IGNORE INTO session_executions
   (run_id,step_id,slot,fixed_key,state,created_at,updated_at)
   SELECT ?,?,free.slot,?,'queued',?,? FROM (
     SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
   ) AS free
   WHERE NOT EXISTS (
      SELECT 1 FROM session_executions AS active
      WHERE active.slot=free.slot AND active.state!='terminated'
   )
   AND EXISTS (SELECT 1 FROM runs WHERE id=? AND outcome IN ('queued','running'))
   -- Old published Go Sessions may still hold a legacy fixed/null key.
   -- Never admit the new resource while they have no verified termination.
   AND (?=0 OR NOT EXISTS(
     SELECT 1 FROM session_executions old
     JOIN runs older_run ON older_run.id=old.run_id
     JOIN workflow_versions older_version ON older_version.id=older_run.version_id
     JOIN json_each(older_version.plan,'$.steps') AS old_step
     WHERE old.state!='terminated'
       AND json_extract(old_step.value,'$.id')=old.step_id
       AND json_extract(old_step.value,'$.with.action.repositoryId')=?
       AND json_extract(old_step.value,'$.with.action.workflowPath')='.github/workflows/openlist.yml'
   ))
   ORDER BY free.slot LIMIT 1`)
  .bind(runId,stepId,fixedKey,Date.now(),Date.now(),runId,
    goResource?1:0,reviewed.repositoryId).run();
 if(created.meta.changes===1)return 'reserved';
 const prior=await db.prepare(`SELECT state FROM session_executions
   WHERE run_id=? AND step_id=?`)
  .bind(runId,stepId).first<{state:string}>();
 // Duplicate admission must never reserve a second slot; the original
 // reservation remains authoritative even when a transport reply is lost.
 if(prior)return prior.state==='terminated'?'denied':'existing';
 // The DB unique index, not this read, closes concurrent admissions.
 if(fixedKey!==null){
  const holder=await db.prepare(`SELECT 1 AS present FROM session_executions
   WHERE fixed_key=? AND state!='terminated' LIMIT 1`)
   .bind(fixedKey).first<{present:number}>();
  if(holder)return 'fixed_conflict';
 }
 if(goResource){
  const legacy=await db.prepare(`SELECT 1 AS present FROM session_executions old
   JOIN runs older_run ON older_run.id=old.run_id
   JOIN workflow_versions older_version ON older_version.id=older_run.version_id
   JOIN json_each(older_version.plan,'$.steps') AS old_step
   WHERE old.state!='terminated'
     AND json_extract(old_step.value,'$.id')=old.step_id
     AND json_extract(old_step.value,'$.with.action.repositoryId')=?
     AND json_extract(old_step.value,'$.with.action.workflowPath')='.github/workflows/openlist.yml'
   LIMIT 1`).bind(reviewed.repositoryId).first<{present:number}>();
  if(legacy)return 'fixed_conflict';
 }
 return 'full';
}

/**
 * Reclaim quota only after durable physical terminal evidence was already
 * verified and persisted by the exact Action Attempt reconciliation path.
 * A successful parent Workflow step, Ready or GitHub cancel ACK is insufficient.
 */
export async function releaseVerifiedSessionSlot(
 db:Db,runId:string,stepId:string,
):Promise<SessionRelease>{
 if(!UUID.test(runId)||!STEP.test(stepId))return 'held';
 const changed=await db.prepare(`UPDATE session_executions SET state='terminated',session_url=NULL,
   updated_at=? WHERE run_id=? AND step_id=? AND state!='terminated'
   AND EXISTS (
     SELECT 1 FROM step_attempts AS a
     WHERE a.run_id=session_executions.run_id
       AND a.step_id=session_executions.step_id
       AND a.capability_id='github.action'
       AND a.state IN ('succeeded','failed','cancelled')
       AND a.candidate_run_id IS NOT NULL AND a.candidate_run_attempt IS NOT NULL
       AND (
         (a.owner_run_id=a.candidate_run_id
           AND a.owner_run_attempt=a.candidate_run_attempt)
         OR (a.owner_run_id IS NULL AND a.owner_run_attempt IS NULL
           AND a.state IN ('failed','cancelled'))
       )
   )`).bind(Date.now(),runId,stepId).run();
 const prior=await db.prepare(`SELECT state FROM session_executions
   WHERE run_id=? AND step_id=?`).bind(runId,stepId)
  .first<{state:string}>();
 if(prior?.state==='terminated'){
  // Verified termination is the only deletion gate. A failed cleanup is
  // retryable on the next reconciliation, without reviving any data.
  try{
   await db.prepare(`DELETE FROM session_runtime_data WHERE run_id=? AND step_id=?
     AND EXISTS (SELECT 1 FROM session_executions s
       WHERE s.run_id=? AND s.step_id=? AND s.state='terminated')`)
    .bind(runId,stepId,runId,stepId).run();
  }catch{ /* Migration not yet present or transient D1 failure. */ }
 }
 return changed.meta.changes===1?'released':prior?.state==='terminated'?'already_released':'held';
}

/** Recover a Session slot only if GitHub *definitively rejected* dispatch
 * and no physical Run was ever registered. A transport-unknown dispatch
 * cannot use this path, even if a GitHub Run is not yet visible.
 */
export async function releaseRejectedSessionSlot(
 db:Db,runId:string,stepId:string,
):Promise<boolean>{
 if(!UUID.test(runId)||!STEP.test(stepId))return false;
 const written=await db.prepare(`UPDATE session_executions
   SET state='terminated',updated_at=?
   WHERE run_id=? AND step_id=?
     AND state IN ('queued','starting')
     AND EXISTS (
       SELECT 1 FROM step_attempts AS a
       WHERE a.run_id=session_executions.run_id
         AND a.step_id=session_executions.step_id
         AND a.capability_id='github.action'
         AND a.state='rejected'
         AND a.candidate_run_id IS NULL
         AND a.candidate_run_attempt IS NULL
         AND a.owner_run_id IS NULL
         AND a.owner_run_attempt IS NULL
     )`).bind(Date.now(),runId,stepId).run();
 return written.meta.changes===1;
}

/** Recover a reservation interrupted BEFORE the durable Action Attempt INSERT.
 * Registration always persists the Attempt before any outbound GitHub POST.
 * Never reclaim when an Attempt exists, even dispatch_unknown or rejected,
 * and never reclaim an active parent that could still resume dispatch.
 */
export async function releaseNeverDispatchedSessionSlot(
 db:Db,runId:string,stepId:string,expiredBefore:number,
):Promise<boolean>{
 if(!UUID.test(runId)||!STEP.test(stepId)||
    !Number.isSafeInteger(expiredBefore)||expiredBefore<0)return false;
 const written=await db.prepare(`UPDATE session_executions
   SET state='terminated',updated_at=?
   WHERE run_id=? AND step_id=? AND state='queued'
     AND created_at<=?
     AND NOT EXISTS(
       SELECT 1 FROM step_attempts a
       WHERE a.run_id=session_executions.run_id
         AND a.step_id=session_executions.step_id
     )
     AND EXISTS(
       SELECT 1 FROM runs r WHERE r.id=session_executions.run_id
         AND r.outcome IN ('succeeded','failed','indeterminate','cancelled')
     )`).bind(Date.now(),runId,stepId,expiredBefore).run();
 return written.meta.changes===1;
}

export type SessionReadyResult='ready'|'already_ready'|'denied'|'physical_unconfirmed';
/**
 * OIDC-signed Ready: the already-claimed physical GitHub job must still be
 * running under the exact immutable published Session identity. Readback is
 * advisory proof of current liveness; the CAS and later terminal reconciliation
 * protect the persisted state against callbacks racing with cancellation.
 */
export async function recordSignedSessionReady(
 db:Db,attemptId:string,jwt:string,audience:string,token:string,
 keys?:GithubActionKeys,
 inspect:typeof inspectPersistedGitHubActionAttempt=inspectPersistedGitHubActionAttempt,
 sessionUrl?:string,
):Promise<SessionReadyResult>{
 const verified=await verifyPinnedGitHubActionIdentity(
   db,attemptId,jwt,audience,keys,true);
 if(!verified||verified.action.type!=='session')return 'denied';
 if(sessionUrl!==undefined &&
    (verified.action.repository!=='lirtual/session-actions'||
     !WEB_PATHS.has(verified.action.workflowPath)||
     sessionUrl.length>180||!TUNNEL_URL.test(sessionUrl)))return 'denied';
 const {row}=verified;
 if(row.state!=='claimed'||row.owner_run_id!==row.candidate_run_id||
    row.owner_run_attempt!==row.candidate_run_attempt)return 'denied';
 const physical=await inspect(db,attemptId,token);
 if(physical.state!=='running')
  return physical.state==='unknown'||physical.state==='queued'
   ?'physical_unconfirmed':'denied';
 const updated=await db.prepare(`UPDATE session_executions
   SET state='ready',session_url=?,updated_at=?
   WHERE run_id=? AND step_id=? AND state IN ('queued','starting')
   AND EXISTS (
     SELECT 1 FROM step_attempts a
     WHERE a.attempt_id=? AND a.run_id=session_executions.run_id
       AND a.step_id=session_executions.step_id
       AND a.capability_id='github.action' AND a.state='claimed'
       AND a.candidate_run_id=? AND a.candidate_run_attempt=?
       AND a.owner_run_id=a.candidate_run_id
       AND a.owner_run_attempt=a.candidate_run_attempt
   ) AND NOT EXISTS (
     SELECT 1 FROM github_action_cancellations c
     WHERE c.attempt_id=?
   ) AND EXISTS (
     SELECT 1 FROM runs r WHERE r.id=session_executions.run_id
       AND r.outcome IN ('queued','running')
   )`).bind(sessionUrl??null,Date.now(),row.run_id,row.step_id,attemptId,
   row.candidate_run_id,row.candidate_run_attempt,attemptId).run();
 if(updated.meta.changes===1)return 'ready';
 const state=await db.prepare(`SELECT state,session_url FROM session_executions
  WHERE run_id=? AND step_id=?`).bind(row.run_id,row.step_id)
  .first<{state:string;session_url:string|null}>();
 if(state?.state!=='ready'||state.session_url!==(sessionUrl??null))return 'denied';
 // HTTP 200 replay is only valid for the original healthy Ready, not after
 // a cancellation intent has been durably recorded but before 'stopping'.
 const cancelling=await db.prepare(`SELECT 1 AS present
   FROM github_action_cancellations WHERE attempt_id=?`)
   .bind(attemptId).first<{present:number}>();
 return cancelling?'denied':'already_ready';
}

type SessionOutcome={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:unknown};
type Http=(request:Request)=>Promise<Response>;

/**
 * The Session step resolves on a *signed and physically verified* Ready,
 * not on GitHub job completion. D1 Session reservation continues occupying
 * one of four slots independently of the parent Workflow's business outcome.
 * Dispatch and wake waits are native, durable Cloudflare Workflow steps.
 *
 * This path is internally wired, but WorkflowService.start continues denying
 * Session admission until user cancellation and post-Ready physical recovery
 * are implemented and independently accepted.
 */
export async function runPublishedGitHubActionSession(
 env:Env,plan:Plan,stepPlan:Step,runId:string,step:WorkflowStep,
 http:Http=fetch,
):Promise<SessionOutcome>{
 const raw=stepPlan.with.action as (ReviewedGitHubAction & {
  ref?:unknown;inputs?:unknown;
 })|undefined;
 if(!raw||raw.type!=='session')
  return {status:'failed',error_code:'github_action_session_required'};
 const identity:ReviewedGitHubAction={
  repository:raw.repository,repositoryId:raw.repositoryId,
  workflowId:raw.workflowId,workflowPath:raw.workflowPath,
  commitSha:raw.commitSha,type:raw.type,contractDigest:raw.contractDigest,
 };
 if(plan.github_execution_approved!==true||
    !isPublishedGitHubActionApproved(plan.github_action_approvals,identity))
  return {status:'failed',error_code:'github_action_approval_missing'};
 if(!env.WORKFLOW_GITHUB_DISPATCH_TOKEN||!env.GITHUB_ACTION_OIDC_AUDIENCE)
  return {status:'failed',error_code:'github_action_executor_not_configured'};
 if(typeof raw.ref!=='string'||!raw.ref.startsWith('refs/tags/')||
    !raw.inputs||typeof raw.inputs!=='object'||Array.isArray(raw.inputs))
  return {status:'failed',error_code:'github_action_invalid_publication'};
 const inputs:Record<string,string>={};
 for(const [key,value] of Object.entries(raw.inputs)){
  if(typeof value!=='string'&&typeof value!=='boolean'&&
    (typeof value!=='number'||!Number.isFinite(value)))
   return {status:'failed',error_code:'github_action_invalid_publication'};
  inputs[key]=String(value);
 }
 const db=env.DB,token=env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
 const dispatched=await step.do('github-session-dispatch-'+stepPlan.id,{
  retries:{limit:0,delay:'1 second'},timeout:'45 seconds',
 },async()=>{
  const slot=await reservePublishedSessionSlot(db,runId,stepPlan.id);
  if(slot==='full')return {status:'quota_full'} as const;
  if(slot==='fixed_conflict')return {status:'fixed_conflict'} as const;
  if(slot!=='reserved'&&slot!=='existing')return {status:'denied'} as const;
  const attemptId=crypto.randomUUID(),dispatchId=crypto.randomUUID();
  const ack=await registerAndDispatchGitHubAction(db,{
   runId,stepId:stepPlan.id,attemptId,dispatchId,action:identity,
   ref:raw.ref as string,token,inputs,
  },http);
  return {attemptId,...ack};
 });
 if(dispatched.status==='quota_full')
  return {status:'failed',error_code:'github_session_capacity_exceeded'};
 if(dispatched.status==='fixed_conflict'){
  const key=String(identity.repositoryId)+':'+identity.workflowPath;
  const holder=await db.prepare(`SELECT run_id,step_id FROM session_executions
   WHERE fixed_key=? AND state!='terminated' LIMIT 1`)
   .bind(key).first<{run_id:string;step_id:string}>();
  // No duplicate physical dispatch; expose the existing run for status lookup.
  return {status:'failed',error_code:'github_session_fixed_already_active',
   output:{existing_session:holder??null}};
 }
 if(dispatched.status==='denied')
  return {status:'failed',error_code:'github_session_admission_denied'};
 if(dispatched.status==='rejected'){
  await releaseRejectedSessionSlot(db,runId,stepPlan.id);
  return {status:'failed',error_code:'github_session_dispatch_rejected'};
 }
 if(dispatched.status!=='confirmed')
  return {status:'indeterminate',error_code:'github_session_dispatch_unknown'};
 const attemptId=dispatched.attemptId;
 await db.prepare(`UPDATE session_executions SET state='starting',updated_at=?
   WHERE run_id=? AND step_id=? AND state='queued'`)
  .bind(Date.now(),runId,stepPlan.id).run();

 for(let i=0;i<30;i++){
  const snapshot=await db.prepare(`SELECT s.state,a.state AS attempt_state
    FROM session_executions s JOIN step_attempts a
    ON a.run_id=s.run_id AND a.step_id=s.step_id
    WHERE s.run_id=? AND s.step_id=? AND a.attempt_id=?`)
    .bind(runId,stepPlan.id,attemptId)
    .first<{state:string;attempt_state:string}>();
  if(snapshot?.state==='ready'&&snapshot.attempt_state==='claimed')
   return {status:'succeeded',output:{session:{recorded_state:'ready'}}};
  // A verified physical terminal may race the native Ready waiter.
  // Inspect the durable Attempt first: a terminated Session paired with a
  // *verified* failed/cancelled physical job is a definite pre-Ready failure,
  // not an unknown outcome that would unnecessarily block future releases.
  if(snapshot&&['succeeded','failed','cancelled'].includes(snapshot.attempt_state)){
   await releaseVerifiedSessionSlot(db,runId,stepPlan.id);
   return {status:'failed',error_code:'github_session_ended_before_ready'};
  }
  if(!snapshot||['terminated','stopping'].includes(snapshot.state))
   return {status:'indeterminate',error_code:'github_session_no_ready'};
  const physical=await step.do('github-session-check-'+stepPlan.id+'-'+i,{
   retries:{limit:0,delay:'1 second'},timeout:'45 seconds',
  },()=>reconcilePersistedGitHubActionAttempt(db,attemptId,token,
   (database,id,credential)=>inspectPersistedGitHubActionAttempt(database,id,credential,
    (action,run,attempt,bearer,ref)=>
     inspectGitHubActionRun(action,run,attempt,bearer,ref,http))));
  if(physical==='conflict')
   return {status:'indeterminate',error_code:'github_session_identity_conflict'};
  if(physical==='updated'||physical==='already_settled'){
   await releaseVerifiedSessionSlot(db,runId,stepPlan.id);
   return {status:'failed',error_code:'github_session_ended_before_ready'};
  }
  try{
   await step.waitForEvent('github-session-wait-'+stepPlan.id+'-'+i,{
    type:'github-session-ready-'+stepPlan.id,timeout:'30 seconds',
   });
  }catch{
   // Read the durable record on timeout or lost wake; never re-dispatch.
  }
 }
 await db.prepare(`UPDATE session_executions SET state='uncertain',updated_at=?
   WHERE run_id=? AND step_id=? AND state IN ('queued','starting')`)
  .bind(Date.now(),runId,stepPlan.id).run();
 return {status:'indeterminate',error_code:'github_session_ready_unconfirmed'};
}
