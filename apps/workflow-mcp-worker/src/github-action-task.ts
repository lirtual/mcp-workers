import type {WorkflowStep} from 'cloudflare:workers';
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
 if(!env.WORKFLOW_EXECUTOR_GITHUB_TOKEN||!env.GITHUB_ACTION_OIDC_AUDIENCE)
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
 const db=env.DB,token=env.WORKFLOW_EXECUTOR_GITHUB_TOKEN;
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
   if(settled.state==='succeeded')return {status:'succeeded',output:null};
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
