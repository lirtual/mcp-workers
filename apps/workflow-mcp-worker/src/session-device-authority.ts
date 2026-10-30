/** One source of truth for Session-only Remote Control admission.
 * Called only by the named private Workflow WorkerEntrypoint.
 * Never an HTTP endpoint, public bearer check or independent GitHub OIDC engine.
 */
import {verifyPinnedGitHubActionIdentity} from './github-action-oidc-claim.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';
import {inspectGitHubActionRun} from './github-action-run-inspection.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import {publishedGitHubActionStep,type Plan} from './plan.ts';
import {inspectSessionJobStart,resolveSessionDeadline} from './session-device-admission.ts';
import type {Env} from './store.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DENY={allowed:false} as const;
export type SessionAdmission=typeof DENY | {
  allowed:true;attempt_id:string;github_run_id:number;github_run_attempt:number;
  expires_at:number;workflow_name:'windows'|'ubuntu';
};
type Row={
 attempt_id:string;run_id:string;step_id:string;state:string;session_state:string;
 capability_id:string;repository:string;repository_id:string;workflow_ref:string;
 ref:string;candidate_run_id:number|null;candidate_run_attempt:number|null;
 owner_run_id:number|null;owner_run_attempt:number|null;
 plan:string;run_inputs:string;run_outcome:string;
};
type AdmissionServices={
 oidc:(env:Env,attemptId:string,jwt:string)=>Promise<boolean>;
 physical:(env:Env,attemptId:string)=>Promise<{state:string}>;
 jobStart:(action:ReviewedGitHubAction,runId:number,runAttempt:number,token:string)=>Promise<number|null>;
 approval:(approvals:Plan['github_action_approvals'],action:ReviewedGitHubAction)=>boolean;
};
const boundedHttp=(request:Request)=>fetch(new Request(request,{signal:AbortSignal.timeout(5_000)}));
const services:AdmissionServices={
 oidc:async(env,attemptId,jwt)=>{
   if(!env.GITHUB_ACTION_OIDC_AUDIENCE)return false;
   const verified=await verifyPinnedGitHubActionIdentity(env.DB,attemptId,jwt,
     env.GITHUB_ACTION_OIDC_AUDIENCE,undefined,true);
   return verified?.action.type==='session' && verified.row.state==='claimed';
 },
 physical:async(env,attemptId)=>{
   if(!env.WORKFLOW_GITHUB_DISPATCH_TOKEN)return {state:'unknown'};
   return inspectPersistedGitHubActionAttempt(env.DB,attemptId,
     env.WORKFLOW_GITHUB_DISPATCH_TOKEN,
     (action,runId,runAttempt,token,ref)=>inspectGitHubActionRun(
       action,runId,runAttempt,token,ref,boundedHttp));
 },
 jobStart:inspectSessionJobStart,
 approval:isPublishedGitHubActionApproved,
};
const read=async(db:D1Database,attemptId:string)=>db.prepare(
  `SELECT a.attempt_id,a.run_id,a.step_id,a.state,a.capability_id,
    a.repository,a.repository_id,a.workflow_ref,a.ref,
    a.candidate_run_id,a.candidate_run_attempt,a.owner_run_id,a.owner_run_attempt,
    s.state AS session_state,r.outcome AS run_outcome,r.inputs AS run_inputs,v.plan
   FROM step_attempts a JOIN runs r ON r.id=a.run_id
   JOIN workflow_versions v ON v.id=r.version_id
   JOIN session_executions s ON s.run_id=a.run_id AND s.step_id=a.step_id
   WHERE a.attempt_id=? AND a.capability_id='github.action' AND a.state='claimed'
    AND s.state='ready'
    AND a.owner_run_id=a.candidate_run_id
    AND a.owner_run_attempt=a.candidate_run_attempt
    AND a.owner_run_id IS NOT NULL AND a.owner_run_attempt IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.attempt_id=a.attempt_id)`)
 .bind(attemptId).first<Row>();

function reviewedAction(row:Row, approval:AdmissionServices['approval']):
  {action:ReviewedGitHubAction;pinned:Record<string,unknown>;
   defaults:Record<string,unknown>;supplied:Record<string,unknown>}|null{
 try{
  const plan=JSON.parse(row.plan) as Plan;
  const supplied=JSON.parse(row.run_inputs) as Record<string,unknown>;
  if(!plan||plan.github_execution_approved!==true||!Array.isArray(plan.steps)||
    !supplied||typeof supplied!=='object'||Array.isArray(supplied))return null;
  const step=publishedGitHubActionStep(plan,row.step_id);
  if(!step||step.uses!=='github.run'||step.with?.capability!=='github.action')return null;
  const raw=step.with.action as (ReviewedGitHubAction & {inputs?:Record<string,unknown>;ref?:string})|undefined;
  if(!raw||raw.type!=='session'||raw.repository!=='lirtual/session-actions'||
    !['.github/workflows/windows.yml','.github/workflows/ubuntu.yml'].includes(raw.workflowPath)||
    !raw.inputs||typeof raw.inputs!=='object'||Array.isArray(raw.inputs))return null;
  const action:ReviewedGitHubAction={
    repository:raw.repository,repositoryId:raw.repositoryId,workflowId:raw.workflowId,
    workflowPath:raw.workflowPath,commitSha:raw.commitSha,
    type:raw.type,contractDigest:raw.contractDigest,
  };
  if(!approval(plan.github_action_approvals,action) ||
    row.repository!==action.repository||row.repository_id!==String(action.repositoryId)||
    row.ref!==raw.ref||row.workflow_ref!==action.repository+'/'+action.workflowPath+'@'+row.ref||
    !/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(row.ref)||
    row.ref.includes('..')||row.ref.includes('//'))return null;
  const defaults=(plan.inputs??{}) as Record<string,unknown>;
  return {action,pinned:raw.inputs,defaults,supplied};
 }catch{return null;}
}

/** A successful result admits only ONE new action at this instant.
 * Cancellation committed before the FINAL D1 read necessarily denies.
 * In-flight actions already admitted before cancellation retain their receipts.
 */
export async function decideSessionAdmission(
 env:Env,input:{attempt_id:unknown;oidc_jwt?:unknown},
 overrides:Partial<AdmissionServices>={},
):Promise<SessionAdmission>{
 const deps={...services,...overrides};
 if(!env.DB||!env.WORKFLOW_GITHUB_DISPATCH_TOKEN||
    typeof input?.attempt_id!=='string'||!UUID.test(input.attempt_id)||
    (input.oidc_jwt!==undefined&&
      (typeof input.oidc_jwt!=='string'||input.oidc_jwt.length>8192)))return DENY;
 const attemptId=input.attempt_id;
 try{
  const row=await read(env.DB,attemptId);
  if(!row||row.session_state!=='ready'||row.state!=='claimed'||
     row.owner_run_id!==row.candidate_run_id||
     row.owner_run_attempt!==row.candidate_run_attempt||
     !row.candidate_run_id||!row.candidate_run_attempt)return DENY;
  const approved=reviewedAction(row,deps.approval);
  if(!approved)return DENY;
  if(input.oidc_jwt!==undefined&&
     !await deps.oidc(env,attemptId,input.oidc_jwt))return DENY;
  const physical=await deps.physical(env,attemptId);
  if(physical.state!=='running')return DENY;
  const started=await deps.jobStart(approved.action,row.candidate_run_id,
    row.candidate_run_attempt,env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
  if(started===null)return DENY;
  const deadline=resolveSessionDeadline(approved.pinned,approved.defaults,
    approved.supplied,started);
  if(deadline===null||deadline<=Date.now())return DENY;
  // Physical and admission reads are intentionally NOT cross-storage atomic;
  // this final D1 read is the logical cancellation admission fence.
  const current=await read(env.DB,attemptId);
  if(!current||current.state!=='claimed'||current.session_state!=='ready'||
     current.candidate_run_id!==row.candidate_run_id||
     current.candidate_run_attempt!==row.candidate_run_attempt||
     current.owner_run_id!==row.owner_run_id||
     current.owner_run_attempt!==row.owner_run_attempt||
     current.plan!==row.plan||current.run_inputs!==row.run_inputs)return DENY;
  return {allowed:true,attempt_id:attemptId,
    github_run_id:row.candidate_run_id,github_run_attempt:row.candidate_run_attempt,
    expires_at:deadline,workflow_name:approved.action.workflowPath.endsWith('/windows.yml')
      ? 'windows':'ubuntu'};
 }catch{return DENY;}
}
