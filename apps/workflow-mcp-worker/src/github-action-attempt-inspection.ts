import { inspectGitHubActionRun } from './github-action-run-inspection.ts';
import { isPublishedGitHubActionApproved, type ReviewedGitHubAction } from './github-action-review.ts';
import {publishedGitHubActionStep,type Plan} from './plan.ts';
import type { PhysicalRunState } from './github-action-run-state.ts';
import {actionForAttempt} from './github-action-main.ts';
import {decidePhysicalGitHubTerminal} from './github-action-terminal-decision.ts';

type Db=Pick<D1Database,'prepare'>;
export type PersistedGitHubAttemptIdentity={attempt_id:string;run_id:string;step_id:string;state:string;capability_id:string;owner_run_id:number|null;owner_run_attempt:number|null;repository:string;repository_id:string;workflow_ref:string;ref:string;resolved_sha:string|null;candidate_run_id:number|null;candidate_run_attempt:number|null};
type Row=PersistedGitHubAttemptIdentity&{plan:string;run_outcome:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Read-only cross-check of a durable registered Attempt and its pinned Published
 * Plan. It never changes Attempt state, releases quota, or declares Task success.
 */
export async function inspectPersistedGitHubActionAttempt(
 db:Db,attemptId:string,token:string,
 inspect:typeof inspectGitHubActionRun=inspectGitHubActionRun,
):Promise<PhysicalRunState>{
 if(!UUID.test(attemptId))return {state:'unknown'};
 const row=await db.prepare(`SELECT a.attempt_id,a.run_id,a.step_id,a.state,a.capability_id,
 a.owner_run_id,a.owner_run_attempt,
 a.repository,a.repository_id,a.workflow_ref,a.ref,a.resolved_sha,
 a.candidate_run_id,a.candidate_run_attempt,v.plan,r.outcome AS run_outcome
 FROM step_attempts a JOIN runs r ON r.id=a.run_id
 JOIN workflow_versions v ON v.id=r.version_id
 WHERE a.attempt_id=?`).bind(attemptId).first<Row>();
 if(!row || row.capability_id!=='github.action' ||
    !['confirmed','claimed','succeeded','failed','cancelled'].includes(row.state) ||
    !row.candidate_run_id || !row.candidate_run_attempt ||
    // Another owner request may have already reconciled the exact physical
    // terminal. Native polling must still be able to verify it and finish.
    (['claimed','succeeded'].includes(row.state) &&
      (row.owner_run_id!==row.candidate_run_id ||
       row.owner_run_attempt!==row.candidate_run_attempt)))return {state:'unknown'};
 // Session physical jobs outlive their parent Workflow after Ready.
 // Only a separately reserved, nonterminated Session may be inspected after
 // the parent reaches a business terminal. Task has no such exception.
 if(!['queued','running'].includes(row.run_outcome)){
  const live=await db.prepare(`SELECT state FROM session_executions
    WHERE run_id=? AND step_id=?`).bind(row.run_id,row.step_id)
   .first<{state:string}>();
  if(!live||live.state==='terminated')return {state:'unknown'};
 }
 let plan:Plan;
 try{plan=JSON.parse(row.plan) as Plan;}catch{return {state:'unknown'};}
 const runtime=resolvePersistedGitHubAction(plan,row);
 if(!runtime)return {state:'unknown'};
 return inspect(runtime,row.candidate_run_id,row.candidate_run_attempt,token,row.ref);
}


// Shared immutable identity resolution. The existing runtime inspector still
// owns its live-parent admission boundary; terminal proof is read-only.
export function resolvePersistedGitHubAction(plan:Plan,row:PersistedGitHubAttemptIdentity):ReviewedGitHubAction|null{
 if(plan.github_execution_approved!==true)return null;
 const step=publishedGitHubActionStep(plan,row.step_id);
 if(!step || step.uses!=='github.run' || step.with.capability!=='github.action')
   return null;
 const raw=step.with.action as (ReviewedGitHubAction & {inputs?:unknown;ref?:string})|undefined;
 if(!raw)return null;
 const identity:ReviewedGitHubAction={
  repository:raw.repository,repositoryId:raw.repositoryId,workflowId:raw.workflowId,
  workflowPath:raw.workflowPath,commitSha:raw.commitSha,type:raw.type,
  contractDigest:raw.contractDigest,
 };
 if(!isPublishedGitHubActionApproved(plan.github_action_approvals,identity) ||
    row.repository!==identity.repository ||
    row.repository_id!==String(identity.repositoryId) ||
    row.workflow_ref!==identity.repository+'/'+identity.workflowPath+'@'+row.ref ||
    row.ref!==raw.ref ||
    !row.ref.startsWith('refs/'))return null;
 const runtime=actionForAttempt(identity,row.ref,plan.name,row.resolved_sha);
 return runtime;
}

export type GitHubTaskTerminalFact={
 attempt_id:string;repository_id:string;run_id:number;run_attempt:number;
 workflow_ref:string;head_sha:string;conclusion:'success'|'failure'|'cancelled'|'timed_out';
 observed_at:number;
};

/** Collect a physical fact only. No business result, Attempt, callback or
 * capacity changes. The caller has independently established native closure
 * and absence of a physical Session reservation for this Task. */
export async function observeGitHubTaskTerminalFact(
 plan:Plan,row:PersistedGitHubAttemptIdentity,token:string,
 inspect:typeof inspectGitHubActionRun=inspectGitHubActionRun,
 observedAt=Date.now(),
):Promise<GitHubTaskTerminalFact|null>{
 if(!UUID.test(row.attempt_id)||row.capability_id!=='github.action'||
    !['confirmed','claimed'].includes(row.state)||!Number.isSafeInteger(row.candidate_run_id)||
    !Number.isSafeInteger(row.candidate_run_attempt)||row.candidate_run_id!<=0||
    row.candidate_run_attempt!<=0||!Number.isSafeInteger(observedAt)||observedAt<=0)return null;
 const owned=row.owner_run_id===row.candidate_run_id&&row.owner_run_attempt===row.candidate_run_attempt;
 if(row.state==='claimed'?!owned:row.owner_run_id!==null||row.owner_run_attempt!==null)return null;
 const action=resolvePersistedGitHubAction(plan,row);
 if(!action||action.type!=='task')return null;
 const state=await inspect(action,row.candidate_run_id!,row.candidate_run_attempt!,token,row.ref);
 const decision=decidePhysicalGitHubTerminal(state);
 if(decision.kind!=='terminal'||(decision.outcome==='succeeded'&&!owned)||
    !['success','failure','cancelled','timed_out'].includes(decision.conclusion))return null;
 return {attempt_id:row.attempt_id,repository_id:row.repository_id,
  run_id:row.candidate_run_id!,run_attempt:row.candidate_run_attempt!,workflow_ref:row.workflow_ref,
  head_sha:action.commitSha,conclusion:decision.conclusion as GitHubTaskTerminalFact['conclusion'],observed_at:observedAt};
}
