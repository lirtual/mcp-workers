import type { ReviewedGitHubAction } from './github-action-review.ts';
import { dispatchReviewedGitHubAction } from './github-action-dispatch.ts';
import { recordGithubDispatchResult } from './github-claim.ts';
import type { DispatchOutcome } from './github-dispatch.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction as PublishedAction} from './github-action-review.ts';
import {publishedGitHubActionStep,type Plan} from './plan.ts';

type Db=Pick<D1Database,'prepare'>;
type Http=(request:Request)=>Promise<Response>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RequestData={
  runId:string;stepId:string;attemptId:string;dispatchId:string;
  action:ReviewedGitHubAction;ref:string;token:string;inputs:Record<string,string>;
};

/**
 * Internal orchestration only. Atomically registers a single logical attempt
 * before making the one outbound dispatch. Neither a duplicate nor an
 * uncertain outcome can automatically issue another POST.
 *
 * The caller must obtain action/ref/inputs from the approved published plan,
 * never from a new client request. Runtime execution remains disabled until
 * verified Action OIDC Claim and terminal recovery are integrated.
 */
export async function registerAndDispatchGitHubAction(
 db:Db,data:RequestData,http:Http=fetch,
):Promise<DispatchOutcome>{
 if(!UUID.test(data.attemptId)||!UUID.test(data.dispatchId)||
    !UUID.test(data.runId)||!/^[a-zA-Z0-9_-]{1,64}$/.test(data.stepId)||
    !Number.isSafeInteger(data.action.repositoryId)||data.action.repositoryId<=0||
    !/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,190}$/.test(data.ref)||
    data.ref.includes('..')||data.ref.includes('//')||
    !data.action.workflowPath.startsWith('.github/workflows/')||
    !/^[a-z0-9_-]+\.ya?ml$/.test(data.action.workflowPath.slice('.github/workflows/'.length)))
   throw Error('github_action_registration_invalid');
 // A private caller cannot create dispatch authority merely by supplying
 // an Action object. Bind this attempt to its already-published immutable
 // Workflow version, exact Step, and exact reviewed Action grant.
 const origin=await db.prepare(`SELECT r.outcome,v.plan
   FROM runs r JOIN workflow_versions v ON v.id=r.version_id
   WHERE r.id=?`).bind(data.runId).first<{outcome:string;plan:string}>();
 if(!origin||!['queued','running'].includes(origin.outcome))
  throw Error('github_action_publication_missing');
 let plan:Plan;
 try{plan=JSON.parse(origin.plan) as Plan;}
 catch{throw Error('github_action_publication_missing');}
 if(plan.github_execution_approved!==true||!Array.isArray(plan.steps))
  throw Error('github_action_publication_missing');
 const step=publishedGitHubActionStep(plan,data.stepId);
 if(!step||step.uses!=='github.run'||step.with?.capability!=='github.action')
  throw Error('github_action_publication_missing');
 const raw=step.with.action as (PublishedAction & {inputs?:unknown;ref?:string})|undefined;
 if(!raw)throw Error('github_action_publication_missing');
 const identity:PublishedAction={
  repository:raw.repository,repositoryId:raw.repositoryId,
  workflowId:raw.workflowId,workflowPath:raw.workflowPath,
  commitSha:raw.commitSha,type:raw.type,contractDigest:raw.contractDigest,
 };
 const pinned=raw.inputs;
 if(raw.ref!==data.ref || !pinned || typeof pinned!=='object'||Array.isArray(pinned))
  throw Error('github_action_publication_missing');
 // Inputs must exactly match the validated immutable Published Plan. A
 // malicious internal caller cannot substitute a different command/value.
 const expectedInputs=Object.fromEntries(Object.entries(pinned as Record<string,unknown>).map(([key,value])=>{
  if(typeof value!=='string'&&typeof value!=='boolean'&&
     (typeof value!=='number'||!Number.isFinite(value)))
   throw Error('github_action_publication_missing');
  return [key,String(value)];
 }));
 if(Object.keys(expectedInputs).length!==Object.keys(data.inputs).length||
    Object.entries(expectedInputs).some(([key,value])=>data.inputs[key]!==value))
  throw Error('github_action_publication_missing');
 if(!isPublishedGitHubActionApproved(plan.github_action_approvals,identity)||
    !isPublishedGitHubActionApproved([identity],data.action))
  throw Error('github_action_publication_missing');
 const saved=await db.prepare(`INSERT OR IGNORE INTO step_attempts
 (attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,
 repository_id,workflow_ref,ref,created_at,updated_at)
 SELECT ?,?,?, 'github.action',?,'created',?,?,?,?,?,?
 WHERE EXISTS(SELECT 1 FROM runs WHERE id=? AND outcome IN ('queued','running'))`)
  .bind(data.attemptId,data.runId,data.stepId,data.dispatchId,
   data.action.repository,String(data.action.repositoryId),
   data.action.repository+'/'+data.action.workflowPath+'@'+data.ref,
   data.ref,Date.now(),Date.now(),data.runId).run();
 if(saved.meta.changes!==1)throw Error('github_action_attempt_not_registered');
 let outcome:DispatchOutcome;
 try{
  outcome=await dispatchReviewedGitHubAction(data.action,data.ref,data.token,
   {attemptId:data.attemptId,dispatchId:data.dispatchId},data.inputs,http);
 }catch(error){
  // GitHub explicitly resolved this tag to a different SHA before any POST.
  // This is a definitive policy rejection, not an ambiguous dispatch ACK.
  // An unavailable ref lookup remains uncertain and is never retried.
  outcome=error instanceof Error&&error.message==='github_action_ref_mismatch'
   ?{status:'rejected',httpStatus:422,reason:'policy'}
   :{status:'dispatch_unknown'};
 }
 const persisted=await recordGithubDispatchResult(db,data.attemptId,outcome);
 if(!persisted)throw Error('github_action_dispatch_result_unconfirmed');
 return outcome;
}
