import { inspectPersistedGitHubActionAttempt } from './github-action-attempt-inspection.ts';
import { settlePhysicalGitHubActionAttempt, type TerminalCasResult } from './github-action-terminal-cas.ts';

type Db=Pick<D1Database,'prepare'>;
type Inspector=typeof inspectPersistedGitHubActionAttempt;

/**
 * A bounded one-shot reconciliation. Status must originate from the stored
 * candidate and exact published grant, never caller supplied GitHub metadata.
 * This does not mutate the parent Workflow or free Session capacity.
 */
export async function reconcilePersistedGitHubActionAttempt(
 db:Db,attemptId:string,token:string,
 inspect:Inspector=inspectPersistedGitHubActionAttempt,
):Promise<TerminalCasResult>{
 const candidate=async()=>db.prepare(`SELECT candidate_run_id,candidate_run_attempt
   FROM step_attempts WHERE attempt_id=? AND capability_id='github.action'`)
  .bind(attemptId).first<{candidate_run_id:number|null;candidate_run_attempt:number|null}>();
 const before=await candidate();
 if(!before?.candidate_run_id||!before.candidate_run_attempt)return 'conflict';
 const state=await inspect(db,attemptId,token);
 if(state.state!=='completed')return 'held';
 const after=await candidate();
 // The inspected candidate must be the one we will CAS. Never apply
 // evidence from a replaced candidate to a different physical GitHub Run.
 if(after?.candidate_run_id!==before.candidate_run_id||
    after?.candidate_run_attempt!==before.candidate_run_attempt)return 'conflict';
 return settlePhysicalGitHubActionAttempt(
   db,attemptId,before.candidate_run_id,before.candidate_run_attempt,state);
}
