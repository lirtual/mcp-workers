import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';
import {reconcilePersistedGitHubActionAttempt} from './github-action-attempt-reconcile.ts';
import {releaseVerifiedSessionSlot} from './github-action-session.ts';

type Db=Pick<D1Database,'prepare'>;
type Http=(request:Request)=>Promise<Response>;
type Inspector=typeof inspectPersistedGitHubActionAttempt;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const FORCE_CANCEL_DELAY_MS=120_000;
export type ActionCancellationResult=
  'cancel_requested'|'cancel_unknown'|'already_requested'|
  'force_requested'|'force_unknown'|'already_force_requested'|
  'normal_required'|'too_early'|'physical_unconfirmed'|
  'terminal_confirmed'|'not_found';

/**
 * Cancel only the immutable, D1-registered physical GitHub Action selected
 * by a caller-scoped Workflow Run/Step. A 202 ACK is not physical termination.
 * Two-phase intent: persist the one-shot POST *before* contacting GitHub;
 * after transport ambiguity do not automatically replay POST.
 *
 * Force cancellation is an explicit second request, no sooner than two
 * minutes after normal cancellation, only if the verified physical Run is
 * still executing. Force cancellation may skip cleanup: it is not automatic.
 */
export async function requestGitHubActionCancellation(
 db:Db,runId:string,stepId:string,token:string,
 force=false,http:Http=fetch,
 inspect:Inspector=inspectPersistedGitHubActionAttempt,
 now:()=>number=Date.now,
):Promise<ActionCancellationResult>{
 if(!UUID.test(runId)||!STEP.test(stepId)||!token?.trim())return 'not_found';
 const row=await db.prepare(`SELECT a.attempt_id,a.state,a.repository,
  a.candidate_run_id,a.candidate_run_attempt,
  s.state AS session_state,c.cancel_requested_at,c.force_requested_at
  FROM step_attempts a
  LEFT JOIN session_executions s ON s.run_id=a.run_id AND s.step_id=a.step_id
  LEFT JOIN github_action_cancellations c ON c.attempt_id=a.attempt_id
  WHERE a.run_id=? AND a.step_id=? AND a.capability_id='github.action'`)
  .bind(runId,stepId).first<{
    attempt_id:string;state:string;repository:string;
    candidate_run_id:number|null;candidate_run_attempt:number|null;
    session_state:string|null;cancel_requested_at:number|null;force_requested_at:number|null;
  }>();
 if(!row)return 'not_found';
 // D1 terminal states are written only after verified physical settlement.
 // Repeated cancellation after settlement should remain idempotent.
 if(row.session_state==='terminated'||
    ['succeeded','failed','cancelled'].includes(row.state))
   return 'terminal_confirmed';
 if(!['confirmed','claimed'].includes(row.state)||
    !Number.isSafeInteger(row.candidate_run_id)||!row.candidate_run_id||
    !Number.isSafeInteger(row.candidate_run_attempt)||!row.candidate_run_attempt)
   return 'not_found';

 const evidence=await inspect(db,row.attempt_id,token);
 if(evidence.state==='completed'){
  const saved=await reconcilePersistedGitHubActionAttempt(db,row.attempt_id,token,inspect);
  if(saved==='updated'||saved==='already_settled'){
   if(row.session_state!==null)
    await releaseVerifiedSessionSlot(db,runId,stepId);
   return 'terminal_confirmed';
  }
  return 'physical_unconfirmed';
 }
 if(evidence.state!=='running'&&evidence.state!=='queued')return 'physical_unconfirmed';
 if(force&&evidence.state!=='running')return 'physical_unconfirmed';

 const time=now();
 if(force){
  if(row.cancel_requested_at===null)return 'normal_required';
  if(time-row.cancel_requested_at<FORCE_CANCEL_DELAY_MS)return 'too_early';
  if(row.force_requested_at!==null)return 'already_force_requested';
  const written=await db.prepare(`UPDATE github_action_cancellations
    SET force_requested_at=?,force_ack='unknown'
    WHERE attempt_id=? AND force_requested_at IS NULL
      AND cancel_requested_at<=?
      AND EXISTS(SELECT 1 FROM step_attempts a
        WHERE a.attempt_id=github_action_cancellations.attempt_id
          AND a.capability_id='github.action' AND a.state IN ('confirmed','claimed')
          AND a.candidate_run_id=? AND a.candidate_run_attempt=?)`)
   .bind(time,row.attempt_id,time-FORCE_CANCEL_DELAY_MS,
     row.candidate_run_id,row.candidate_run_attempt).run();
  if(written.meta.changes!==1)return 'already_force_requested';
 }else{
  if(row.cancel_requested_at!==null)return 'already_requested';
  const written=await db.prepare(`INSERT OR IGNORE INTO github_action_cancellations
    (attempt_id,run_id,step_id,cancel_requested_at,cancel_ack)
    SELECT a.attempt_id,a.run_id,a.step_id,?,'unknown'
    FROM step_attempts a WHERE a.attempt_id=? AND a.run_id=? AND a.step_id=?
      AND a.capability_id='github.action' AND a.state IN ('confirmed','claimed')
      AND a.candidate_run_id=? AND a.candidate_run_attempt=?`)
   .bind(time,row.attempt_id,runId,stepId,
     row.candidate_run_id,row.candidate_run_attempt).run();
  if(written.meta.changes!==1)return 'already_requested';
  // Stop accepting new Ready immediately, but retain the physical slot.
  // The physical job may remain live after GitHub acknowledges cancellation.
  try{
   await db.prepare(`UPDATE session_executions SET state='stopping',updated_at=?
     WHERE run_id=? AND step_id=? AND state!='terminated'`)
    .bind(time,runId,stepId).run();
  }catch{
   // The durable cancellation intent is already committed and now fences
   // signed Ready atomically. Do NOT abandon the only allowed GitHub POST
   // just because this advisory lifecycle-state write is temporarily down.
   // Later status/watch reconciliation may finish setting the state.
  }
 }

 let accepted=false;
 if(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repository)){
  const url='https://api.github.com/repos/'+row.repository+
   '/actions/runs/'+row.candidate_run_id+(force?'/force-cancel':'/cancel');
  try{
   const response=await http(new Request(url,{method:'POST',redirect:'manual',headers:{
    accept:'application/vnd.github+json',authorization:'Bearer '+token,
    'x-github-api-version':'2026-03-10',
    'user-agent':'workflow-mcp-action-cancel',
   }}));
   accepted=response.status===202;
  }catch{
   // A lost HTTP response is indistinguishable from accepted cancellation.
  }
 }
 if(accepted){
  try{
   if(force){
    await db.prepare(`UPDATE github_action_cancellations SET force_ack='accepted'
      WHERE attempt_id=? AND force_requested_at=?`).bind(row.attempt_id,time).run();
   }else{
    await db.prepare(`UPDATE github_action_cancellations SET cancel_ack='accepted'
      WHERE attempt_id=? AND cancel_requested_at=?`).bind(row.attempt_id,time).run();
   }
  }catch{
   // Durable request intent already fences duplicate POST.
  }
 }
 return force?(accepted?'force_requested':'force_unknown'):
   (accepted?'cancel_requested':'cancel_unknown');
}
