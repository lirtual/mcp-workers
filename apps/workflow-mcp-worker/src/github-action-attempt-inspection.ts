import { inspectGitHubActionRun } from './github-action-run-inspection.ts';
import { isPublishedGitHubActionApproved, type ReviewedGitHubAction } from './github-action-review.ts';
import type { Plan } from './plan.ts';
import type { PhysicalRunState } from './github-action-run-state.ts';

type Db=Pick<D1Database,'prepare'>;
type Row={attempt_id:string;run_id:string;step_id:string;state:string;capability_id:string;owner_run_id:number|null;owner_run_attempt:number|null;repository:string;repository_id:string;workflow_ref:string;ref:string;candidate_run_id:number|null;candidate_run_attempt:number|null;plan:string;run_outcome:string};
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
 a.repository,a.repository_id,a.workflow_ref,a.ref,
 a.candidate_run_id,a.candidate_run_attempt,v.plan,r.outcome AS run_outcome
 FROM step_attempts a JOIN runs r ON r.id=a.run_id
 JOIN workflow_versions v ON v.id=r.version_id
 WHERE a.attempt_id=?`).bind(attemptId).first<Row>();
 if(!row || row.capability_id!=='github.action' ||
    !['confirmed','claimed'].includes(row.state) ||
    !['queued','running'].includes(row.run_outcome) ||
    !row.candidate_run_id || !row.candidate_run_attempt ||
    (row.state==='claimed' && (row.owner_run_id!==row.candidate_run_id ||
      row.owner_run_attempt!==row.candidate_run_attempt)))return {state:'unknown'};
 let plan:Plan;
 try{plan=JSON.parse(row.plan) as Plan;}catch{return {state:'unknown'};}
 if(plan.github_execution_approved!==true)return {state:'unknown'};
 const step=plan.steps.find(x=>x.id===row.step_id);
 if(!step || step.uses!=='github.run' || step.with.capability!=='github.action')
   return {state:'unknown'};
 const raw=step.with.action as (ReviewedGitHubAction & {inputs?:unknown})|undefined;
 if(!raw)return {state:'unknown'};
 const identity:ReviewedGitHubAction={
  repository:raw.repository,repositoryId:raw.repositoryId,workflowId:raw.workflowId,
  workflowPath:raw.workflowPath,commitSha:raw.commitSha,type:raw.type,
  contractDigest:raw.contractDigest,
 };
 if(!isPublishedGitHubActionApproved(plan.github_action_approvals,identity) ||
    row.repository!==identity.repository ||
    row.repository_id!==String(identity.repositoryId) ||
    row.workflow_ref!==identity.repository+'/'+identity.workflowPath+'@'+row.ref ||
    !row.ref.startsWith('refs/'))return {state:'unknown'};
 return inspect(identity,row.candidate_run_id,row.candidate_run_attempt,token);
}
