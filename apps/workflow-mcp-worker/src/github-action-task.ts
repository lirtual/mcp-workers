import type {WorkflowStep} from 'cloudflare:workers';
import {verifyPinnedGitHubActionIdentity,type GithubActionKeys} from './github-action-oidc-claim.ts';
import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import {registerAndDispatchGitHubAction} from './github-action-orchestration.ts';
import {reconcilePersistedGitHubActionAttempt} from './github-action-attempt-reconcile.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';
import {inspectGitHubActionRun} from './github-action-run-inspection.ts';

type Outcome={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:unknown};
type Http=(request:Request)=>Promise<Response>;
// Bounded wait includes GitHub queueing. A missing GitHub observation is NEVER
// a reason to re-dispatch, declare success, or issue an implicit cancellation.
const MAX_TASK_POLLS=420;

export async function runPublishedGitHubActionTask(
 env:Env,plan:Plan,stepPlan:Step,runId:string,step:WorkflowStep,
 http:Http=fetch,
):Promise<Outcome>{
 const raw=stepPlan.with.action as (ReviewedGitHubAction & {
  ref?:unknown;inputs?:unknown;
 })|undefined;
 if(!raw||raw.type!=='task')return {status:'failed',error_code:'github_action_task_required'};
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
 const dispatched=await step.do('github-action-dispatch-'+stepPlan.id,{
  retries:{limit:0,delay:'1 second'},timeout:'45 seconds',
 },async()=>{
  const attemptId=crypto.randomUUID(),dispatchId=crypto.randomUUID();
  const ack=await registerAndDispatchGitHubAction(db,{
   runId,stepId:stepPlan.id,attemptId,dispatchId,
   action:identity,ref:raw.ref as string,token,inputs,
  },http);
  return {attemptId,...ack};
 });
 if(dispatched.status==='rejected')return {status:'failed',error_code:'github_action_dispatch_rejected'};
 if(dispatched.status!=='confirmed')return {status:'indeterminate',error_code:'github_action_dispatch_unknown'};
 const attemptId=dispatched.attemptId;
 for(let i=0;i<MAX_TASK_POLLS;i++){
  // Every poll has a distinct durable name, is read-only outside D1 CAS,
  // and never triggers another GitHub dispatch or GitHub job retry.
  const state=await step.do('github-action-check-'+stepPlan.id+'-'+i,{
   retries:{limit:0,delay:'1 second'},timeout:'45 seconds',
  },()=>reconcilePersistedGitHubActionAttempt(db,attemptId,token,
   (database,id,credential)=>inspectPersistedGitHubActionAttempt(database,id,credential,
    (action,run,attempt,bearer,ref)=>inspectGitHubActionRun(action,run,attempt,bearer,ref,http))));
  if(state==='conflict')return {status:'indeterminate',error_code:'github_action_identity_conflict'};
  if(state==='updated'||state==='already_settled'){
   const settled=await db.prepare(`SELECT a.state,r.outcome AS parent_outcome
     FROM step_attempts a JOIN runs r ON r.id=a.run_id
     WHERE a.attempt_id=? AND a.capability_id='github.action'`)
     .bind(attemptId).first<{state:string;parent_outcome:string}>();
   if(!settled||!['queued','running'].includes(settled.parent_outcome))
    return {status:'indeterminate',error_code:'github_action_parent_not_active'};
   if(settled.state==='succeeded'){
    // A signed JSON receipt is only business output. Native GitHub success
    // is still the sole positive Task termination evidence.
    const receipt=await db.prepare(`SELECT c.result_json FROM callback_receipts c
      JOIN step_attempts a ON a.attempt_id=c.attempt_id
      WHERE a.attempt_id=? AND a.capability_id='github.action'
        AND a.state='succeeded' AND c.outcome='succeeded'`)
      .bind(attemptId).first<{result_json:string}>();
    try{return {status:'succeeded',output:receipt?JSON.parse(receipt.result_json):null};}
    catch{return {status:'indeterminate',error_code:'github_action_task_result_invalid'};}
   }
   if(settled.state==='failed'||settled.state==='cancelled')
    return {status:'failed',error_code:settled.state==='cancelled'?
     'github_action_cancelled':'github_action_failed'};
   return {status:'indeterminate',error_code:'github_action_terminal_unconfirmed'};
  }
  if(i<MAX_TASK_POLLS-1)
   await step.sleep('github-action-sleep-'+stepPlan.id+'-'+i,'1 minute');
 }
 return {status:'indeterminate',error_code:'github_action_terminal_unconfirmed'};
}

/** Store a small optional Task value, never a terminal conclusion. The
 * published source, exact physical Run, signed JWT and active Claim are all
 * revalidated before an immutable, bounded D1 receipt is inserted. Reuses
 * the existing authenticated callback storage; no new service or migration.
 */
export async function recordSignedGitHubActionTaskResult(
 db:Pick<D1Database,'prepare'>,attemptId:string,jwt:string,audience:string,
 result:Record<string,unknown>,keys?:GithubActionKeys,
):Promise<'recorded'|'already_recorded'|'denied'>{
 if(!result||typeof result!=='object'||Array.isArray(result))return 'denied';
 const serialized=JSON.stringify(result);
 if(new TextEncoder().encode(serialized).byteLength>4096)return 'denied';
 const verified=await verifyPinnedGitHubActionIdentity(db,attemptId,jwt,audience,keys);
 if(!verified||verified.action.type!=='task')return 'denied';
 const {row}=verified;
 if(row.state!=='claimed'||row.owner_run_id!==row.candidate_run_id||
    row.owner_run_attempt!==row.candidate_run_attempt)return 'denied';
 const inserted=await db.prepare(`INSERT OR IGNORE INTO callback_receipts
  (callback_id,attempt_id,outcome,result_json,notification_delivered,created_at)
  SELECT ?,?,'succeeded',?,1,? WHERE EXISTS (
    SELECT 1 FROM step_attempts a JOIN runs r ON r.id=a.run_id
    WHERE a.attempt_id=? AND a.capability_id='github.action'
      AND a.state='claimed'
      AND a.candidate_run_id=? AND a.candidate_run_attempt=?
      AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt
      AND r.outcome IN ('queued','running')
      AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c
        WHERE c.attempt_id=a.attempt_id)
  )`).bind(crypto.randomUUID(),attemptId,serialized,Date.now(),attemptId,
    row.candidate_run_id,row.candidate_run_attempt).run();
 const persisted=await db.prepare(`SELECT outcome,result_json FROM callback_receipts
   WHERE attempt_id=?`).bind(attemptId).first<{outcome:string;result_json:string}>();
 if(!persisted||persisted.outcome!=='succeeded'||persisted.result_json!==serialized)
  return 'denied';
 // UNIQUE(attempt_id) permits exactly one receipt. Return the INSERT
 // outcome only after verifying the persisted content: identical replays are
 // acknowledged without overwriting the original, conflicts fail closed.
 return inserted.meta.changes===1?'recorded':'already_recorded';
}
