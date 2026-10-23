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
 const state=await inspect(db,attemptId,token);
 if(state.state!=='completed')return 'held';
 // Obtain physical IDs from the same durable row, then CAS must recheck
 // both IDs, state and ownership atomically against concurrent updates.
 const row=await db.prepare(`SELECT candidate_run_id,candidate_run_attempt
   FROM step_attempts WHERE attempt_id=? AND capability_id='github.action'`)
  .bind(attemptId).first<{candidate_run_id:number|null;candidate_run_attempt:number|null}>();
 if(!row?.candidate_run_id||!row.candidate_run_attempt)return 'conflict';
 return settlePhysicalGitHubActionAttempt(db,attemptId,row.candidate_run_id,row.candidate_run_attempt,state);
}
