import type {DispatchOutcome} from './github-dispatch.ts';

/** Shared, idempotent GitHub Actions dispatch ACK storage in the durable D1 Attempt. */
export type AttemptDatabase=Pick<D1Database,'prepare'>;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Store a dispatch ACK before the externally approved Action job can claim it. */
export async function recordGithubDispatchResult(
  db:AttemptDatabase,attemptId:string,result:DispatchOutcome,
):Promise<boolean>{
  if(!ID.test(attemptId))throw Error('github_attempt_invalid');
  if(result.status==='confirmed'&&(!Number.isSafeInteger(result.runId)||result.runId<=0||
      result.runAttempt!==1))throw Error('github_dispatch_candidate_invalid');
  const state=result.status==='confirmed'?'confirmed':
    result.status==='rejected'?'rejected':'dispatch_unknown';
  const updated=await db.prepare(`UPDATE step_attempts SET state=?,
    candidate_run_id=?,candidate_run_attempt=?,updated_at=?
    WHERE attempt_id=? AND state='created' AND owner_run_id IS NULL`).bind(
    state,result.status==='confirmed'?result.runId:null,
    result.status==='confirmed'?result.runAttempt:null,Date.now(),attemptId,
  ).run();
  return updated.meta.changes===1;
}
