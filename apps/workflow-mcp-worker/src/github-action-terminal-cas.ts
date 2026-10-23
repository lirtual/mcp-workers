import { decidePhysicalGitHubTerminal } from './github-action-terminal-decision.ts';
import type { PhysicalRunState } from './github-action-run-state.ts';

type Db=Pick<D1Database,'prepare'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type TerminalCasResult='updated'|'already_settled'|'conflict'|'held';

/**
 * Persist a confirmed physical termination at Attempt scope, NOT the parent
 * Workflow business result. The caller must obtain evidence from authenticated
 * readback of the same immutable published Action. No callbacks or dispatch
 * acknowledgements are terminal evidence.
 */
export async function settlePhysicalGitHubActionAttempt(
  db:Db,attemptId:string,physicalRunId:number,physicalAttempt:number,
  evidence:PhysicalRunState,
):Promise<TerminalCasResult>{
  const decision=decidePhysicalGitHubTerminal(evidence);
  if(decision.kind==='hold')return 'held';
  if(!UUID.test(attemptId)||!Number.isSafeInteger(physicalRunId)||physicalRunId<=0||
     !Number.isSafeInteger(physicalAttempt)||physicalAttempt<=0)return 'conflict';
  const changed=await db.prepare(`UPDATE step_attempts SET state=?,updated_at=?
    WHERE attempt_id=? AND capability_id='github.action' AND state='claimed'
    AND candidate_run_id=? AND candidate_run_attempt=?
    AND owner_run_id=? AND owner_run_attempt=?
    AND EXISTS(SELECT 1 FROM runs WHERE runs.id=step_attempts.run_id
      AND runs.outcome IN ('queued','running'))`)
    .bind(decision.outcome,Date.now(),attemptId,physicalRunId,physicalAttempt,physicalRunId,physicalAttempt).run();
  if(changed.meta.changes===1)return 'updated';
  // A GitHub job can fail before its first OIDC Claim step (missing Runner,
  // revoked GitHub permissions, invalid workflow setup). A VERIFIED physical
  // failure/cancellation is conclusive for the Task even without an owner.
  // Never grant success to an unclaimed Attempt: only a signed Claim may
  // authorize successful business execution.
  if(decision.outcome!=='succeeded'){
    const failed=await db.prepare(`UPDATE step_attempts SET state=?,updated_at=?
      WHERE attempt_id=? AND capability_id='github.action' AND state='confirmed'
      AND candidate_run_id=? AND candidate_run_attempt=?
      AND owner_run_id IS NULL AND owner_run_attempt IS NULL
      AND EXISTS(SELECT 1 FROM runs WHERE runs.id=step_attempts.run_id
        AND runs.outcome IN ('queued','running'))`)
      .bind(decision.outcome,Date.now(),attemptId,physicalRunId,physicalAttempt).run();
    if(failed.meta.changes===1)return 'updated';
  }
  const existing=await db.prepare(`SELECT state,candidate_run_id,candidate_run_attempt,
    owner_run_id,owner_run_attempt,capability_id FROM step_attempts WHERE attempt_id=?`)
    .bind(attemptId).first<{state:string;candidate_run_id:number|null;candidate_run_attempt:number|null;owner_run_id:number|null;owner_run_attempt:number|null;capability_id:string}>();
  return existing?.state===decision.outcome && existing.capability_id==='github.action' &&
    existing.candidate_run_id===physicalRunId && existing.candidate_run_attempt===physicalAttempt &&
    ((existing.owner_run_id===physicalRunId && existing.owner_run_attempt===physicalAttempt) ||
     (decision.outcome!=='succeeded' && existing.owner_run_id===null && existing.owner_run_attempt===null))
      ?'already_settled':'conflict';
}
