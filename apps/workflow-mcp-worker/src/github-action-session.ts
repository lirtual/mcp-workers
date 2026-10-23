import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import type {Plan} from './plan.ts';

type Db=Pick<D1Database,'prepare'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export type SessionReservation='reserved'|'existing'|'full'|'denied';
export type SessionRelease='released'|'already_released'|'held';

/**
 * Reserve one of four durable physical Session slots in a single SQL write.
 * Reservation never follows a callback, an ACK, or parent Workflow success.
 * It must happen before the corresponding physical Session dispatch.
 */
export async function reservePublishedSessionSlot(
 db:Db,runId:string,stepId:string,
):Promise<SessionReservation>{
 if(!UUID.test(runId)||!STEP.test(stepId))return 'denied';
 const source=await db.prepare(`SELECT r.outcome,v.plan
   FROM runs r JOIN workflow_versions v ON v.id=r.version_id WHERE r.id=?`)
  .bind(runId).first<{outcome:string;plan:string}>();
 if(!source||!['queued','running'].includes(source.outcome))return 'denied';
 let plan:Plan;
 try{plan=JSON.parse(source.plan) as Plan;}
 catch{return 'denied';}
 if(plan.github_execution_approved!==true||!Array.isArray(plan.steps))return 'denied';
 const step=plan.steps.find(x=>x.id===stepId);
 if(!step||step.uses!=='github.run'||step.with.capability!=='github.action')return 'denied';
 const raw=step.with.action as (ReviewedGitHubAction & {ref?:unknown;inputs?:unknown})|undefined;
 if(!raw||raw.type!=='session')return 'denied';
 const reviewed:ReviewedGitHubAction={
  repository:raw.repository,repositoryId:raw.repositoryId,workflowId:raw.workflowId,
  workflowPath:raw.workflowPath,commitSha:raw.commitSha,
  type:raw.type,contractDigest:raw.contractDigest,
 };
 if(!isPublishedGitHubActionApproved(plan.github_action_approvals,reviewed))return 'denied';
 const created=await db.prepare(`INSERT OR IGNORE INTO session_executions
   (run_id,step_id,slot,state,created_at,updated_at)
   SELECT ?,?,free.slot,'queued',?,? FROM (
     SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
   ) AS free
   WHERE NOT EXISTS (
      SELECT 1 FROM session_executions AS active
      WHERE active.slot=free.slot AND active.state!='terminated'
   )
   AND EXISTS (SELECT 1 FROM runs WHERE id=? AND outcome IN ('queued','running'))
   ORDER BY free.slot LIMIT 1`)
  .bind(runId,stepId,Date.now(),Date.now(),runId).run();
 if(created.meta.changes===1)return 'reserved';
 const prior=await db.prepare(`SELECT state FROM session_executions
   WHERE run_id=? AND step_id=?`)
  .bind(runId,stepId).first<{state:string}>();
 // Duplicate admission must never reserve a second slot; the original
 // reservation remains authoritative even when a transport reply is lost.
 if(prior)return prior.state==='terminated'?'denied':'existing';
 return 'full';
}

/**
 * Reclaim quota only after durable physical terminal evidence was already
 * verified and persisted by the exact Action Attempt reconciliation path.
 * A successful parent Workflow step, Ready or GitHub cancel ACK is insufficient.
 */
export async function releaseVerifiedSessionSlot(
 db:Db,runId:string,stepId:string,
):Promise<SessionRelease>{
 if(!UUID.test(runId)||!STEP.test(stepId))return 'held';
 const changed=await db.prepare(`UPDATE session_executions SET state='terminated',
   updated_at=? WHERE run_id=? AND step_id=? AND state!='terminated'
   AND EXISTS (
     SELECT 1 FROM step_attempts AS a
     WHERE a.run_id=session_executions.run_id
       AND a.step_id=session_executions.step_id
       AND a.capability_id='github.action'
       AND a.state IN ('succeeded','failed','cancelled')
       AND a.candidate_run_id IS NOT NULL AND a.candidate_run_attempt IS NOT NULL
       AND (
         (a.owner_run_id=a.candidate_run_id
           AND a.owner_run_attempt=a.candidate_run_attempt)
         OR (a.owner_run_id IS NULL AND a.owner_run_attempt IS NULL
           AND a.state IN ('failed','cancelled'))
       )
   )`).bind(Date.now(),runId,stepId).run();
 if(changed.meta.changes===1)return 'released';
 const prior=await db.prepare(`SELECT state FROM session_executions
   WHERE run_id=? AND step_id=?`).bind(runId,stepId)
  .first<{state:string}>();
 return prior?.state==='terminated'?'already_released':'held';
}
