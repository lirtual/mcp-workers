import type { ReviewedGitHubAction } from './github-action-review.ts';
import { dispatchReviewedGitHubAction } from './github-action-dispatch.ts';
import { recordGithubDispatchResult } from './github-claim.ts';
import type { DispatchOutcome } from './github-dispatch.ts';

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
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(data.ref)||
    data.ref.includes('..')||data.ref.includes('//')||
    !data.action.workflowPath.startsWith('.github/workflows/')||
    !/^[a-z0-9_-]+\.ya?ml$/.test(data.action.workflowPath.slice('.github/workflows/'.length)))
   throw Error('github_action_registration_invalid');
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
 }catch{
  // Validation/readback failures before dispatch have a known absence of
  // outbound POST. Keeping unknown is conservative and prevents a replay.
  outcome={status:'dispatch_unknown'};
 }
 const persisted=await recordGithubDispatchResult(db,data.attemptId,outcome);
 if(!persisted)throw Error('github_action_dispatch_result_unconfirmed');
 return outcome;
}
