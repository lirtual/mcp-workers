import { persistGithubHeadSha, type AttemptDatabase } from './github-claim.ts';
import { cancelRegisteredGithubRun, observeRegisteredGithubRun, type GithubExecutionObservation } from './github-dispatch.ts';
import { observeInstance } from './instance-observation.ts';
import { LIMITS } from './capabilities.ts';
import { COMPENSATION_ROW } from './saga.ts';

/** Let a live runner finish published cancel compensation before terminate(). */
export const CANCEL_SAGA_GRACE_MS=10*60_000;

export type RunCancellation='requested'|'cancelled'|'completed'|'indeterminate';
type CancelEffect='acknowledged'|'unknown'|null;
type AttemptCancelRow={
  attempt_id:string;
  state:string;
  candidate_run_id:number|null;
  repository:string;
  cancel_effect:CancelEffect;
  receipt_outcome:string|null;
  result_json:string|null;
};
type RunCancelRow={
  id:string;
  version_id:string;
  outcome:string;
  error_code:string|null;
  cancel_requested_at:number|null;
  start_state:string;
  instance_id:string;
};
type SagaCancelWait='proceed'|'defer'|'unconfirmed';
export type CancelRuntime={
  WORKFLOW:{
    get(id:string):Promise<{status():Promise<{status:string}>;terminate?:()=>Promise<void>}>;
  };
  WORKFLOW_EXECUTOR_GITHUB_TOKEN?:string;
  GITHUB_EXECUTOR_REPOSITORY?:string;
};
type Outbound=(request:Request)=>Promise<Response>;
const REFINABLE_ERRORS=new Set([
  'github_callback_unconfirmed','execution_interrupted','orchestration_terminated',
  'cancel_unconfirmed','outcome_unconfirmed',
]);

/** Request cancel for awaited children only. Detached children are not selected. */
export async function requestAwaitedChildCancellation(db:AttemptDatabase, runId:string, depth=0):Promise<void>{
  if(depth>=LIMITS.maxChildDepth)return;
  const children=await db.prepare(`SELECT id FROM runs
    WHERE parent_run_id=? AND child_mode='await' AND cancel_requested_at IS NULL
      AND outcome IN ('queued','running','waiting')`).bind(runId).all<{id:string}>();
  const stamp=Date.now();
  for(const child of children.results){
    await db.prepare('UPDATE runs SET cancel_requested_at=?, updated_at=? WHERE id=? AND cancel_requested_at IS NULL')
      .bind(stamp,stamp,child.id).run();
    await requestAwaitedChildCancellation(db,child.id,depth+1);
  }
}

/** Runner and reconciliation share this fact. It does not call GitHub. */
export async function isCancelRequested(db:AttemptDatabase, runId:string):Promise<boolean>{
  const row=await db.prepare('SELECT cancel_requested_at FROM runs WHERE id=?')
    .bind(runId).first<{cancel_requested_at:number|null}>();
  return row?.cancel_requested_at!=null;
}

export class CancelObserved extends Error {
  constructor(){super('cancel_observed');this.name='CancelObserved';}
}

const ATTEMPT_SQL=`SELECT a.attempt_id,a.state,a.candidate_run_id,a.repository,a.cancel_effect,
  c.outcome AS receipt_outcome,c.result_json
  FROM step_attempts a
  LEFT JOIN callback_receipts c ON c.attempt_id=a.attempt_id
  WHERE a.run_id=?`;

async function attempts(db:AttemptDatabase, runId:string):Promise<AttemptCancelRow[]>{
  const rows=await db.prepare(ATTEMPT_SQL).bind(runId).all<AttemptCancelRow>();
  return rows.results;
}

async function finish(db:AttemptDatabase, runId:string, proposed:RunCancellation):Promise<RunCancellation>{
  const latest=await db.prepare('SELECT outcome FROM runs WHERE id=?')
    .bind(runId).first<{outcome:string}>();
  if(latest?.outcome==='succeeded'||latest?.outcome==='failed') return 'completed';
  if(latest?.outcome==='cancelled') return 'cancelled';
  if(proposed==='cancelled') return 'indeterminate';
  return proposed;
}

async function persist(
  db:AttemptDatabase, runId:string, outcome:string, errorCode:string|null, resultJson?:string,
):Promise<void>{
  const where=`WHERE id=? AND (
    outcome IN ('queued','running','waiting') OR
    (outcome='indeterminate' AND error_code IN ('github_callback_unconfirmed','execution_interrupted','orchestration_terminated','cancel_unconfirmed','outcome_unconfirmed'))
  )`;
  if(resultJson===undefined){
    await db.prepare(`UPDATE runs SET outcome=?, error_code=?, updated_at=? ${where}`)
      .bind(outcome, errorCode, Date.now(), runId).run();
  }else{
    await db.prepare(`UPDATE runs SET outcome=?, error_code=?, result=?, updated_at=? ${where}`)
      .bind(outcome, errorCode, resultJson, Date.now(), runId).run();
  }
}

async function issueCancels(db:AttemptDatabase, env:CancelRuntime, rows:AttemptCancelRow[], outbound:Outbound){
  const token=env.WORKFLOW_EXECUTOR_GITHUB_TOKEN;
  const repository=env.GITHUB_EXECUTOR_REPOSITORY;
  if(!token||!repository) return;
  for(const attempt of rows){
    if(attempt.receipt_outcome) continue;
    if(attempt.state!=='confirmed'&&attempt.state!=='claimed') continue;
    if(attempt.candidate_run_id==null||attempt.cancel_effect!=null) continue;
    if(attempt.repository!==repository) continue;
    const claimed=await db.prepare(`UPDATE step_attempts SET cancel_effect='unknown', updated_at=?
      WHERE attempt_id=? AND cancel_effect IS NULL AND state IN ('confirmed','claimed')
      AND candidate_run_id=? AND repository=?`).bind(
      Date.now(), attempt.attempt_id, attempt.candidate_run_id, repository,
    ).run();
    if(claimed.meta.changes!==1) continue;
    const accepted=await cancelRegisteredGithubRun(repository, attempt.candidate_run_id, token, outbound);
    if(!accepted) continue;
    await db.prepare(`UPDATE step_attempts SET cancel_effect='acknowledged', updated_at=?
      WHERE attempt_id=? AND cancel_effect='unknown'`).bind(Date.now(), attempt.attempt_id).run();
  }
}

async function sagaCancelWait(db:AttemptDatabase, env:CancelRuntime, run:RunCancelRow):Promise<SagaCancelWait>{
  const version=await db.prepare('SELECT plan FROM workflow_versions WHERE id=?')
    .bind(run.version_id).first<{plan:string}>();
  if(!version) return 'unconfirmed';
  let triggers:unknown;
  try{triggers=(JSON.parse(version.plan) as {saga?:{on?:unknown}}).saga?.on;}
  catch{return 'unconfirmed';}
  if(!Array.isArray(triggers)||!triggers.includes('cancel')) return 'proceed';
  const report=await db.prepare('SELECT 1 AS done FROM run_steps WHERE run_id=? AND step_id=?')
    .bind(run.id, COMPENSATION_ROW).first<{done:number}>();
  if(report) return 'proceed';
  const requestedAt=run.cancel_requested_at??0;
  if(Date.now()-requestedAt>=CANCEL_SAGA_GRACE_MS) return 'unconfirmed';
  if(run.start_state!=='started') return 'defer';
  const observed=await observeInstance(env.WORKFLOW, run.instance_id);
  const dead=observed.kind==='missing'||(observed.kind==='found'&&
    (observed.status==='terminated'||observed.status==='complete'||observed.status==='errored'));
  return dead?'unconfirmed':'defer';
}

async function bestEffortTerminate(env:CancelRuntime, instanceId:string){
  const before=await observeInstance(env.WORKFLOW, instanceId);
  if(before.kind!=='found'||before.status==='terminated'||before.status==='complete'||before.status==='errored')
    return;
  try{
    const instance=await env.WORKFLOW.get(instanceId);
    if(instance.terminate) await instance.terminate();
  }catch{/* Termination is best-effort. The next observation decides the state. */}
}

function aggregate(readings:GithubExecutionObservation[], effects:CancelEffect[]):RunCancellation{
  if(readings.some(item=>item.kind==='unknown')) return 'indeterminate';
  if(readings.some(item=>item.kind==='open'))
    return effects.every(effect=>effect==='acknowledged')?'requested':'indeterminate';
  const kinds=new Set(readings.map(item=>item.kind));
  if(kinds.size===1&&kinds.has('cancelled')) return 'cancelled';
  if(kinds.size===1&&kinds.has('completed')) return 'completed';
  return 'indeterminate';
}

async function observeRows(db:AttemptDatabase, env:CancelRuntime, rows:AttemptCancelRow[], outbound:Outbound){
  const token=env.WORKFLOW_EXECUTOR_GITHUB_TOKEN;
  const repository=env.GITHUB_EXECUTOR_REPOSITORY;
  const readings:GithubExecutionObservation[]=[];
  for(const attempt of rows){
    if(!token||attempt.repository!==repository||attempt.candidate_run_id==null){
      readings.push({kind:'unknown'});
      continue;
    }
    const observed=await observeRegisteredGithubRun(attempt.repository, attempt.candidate_run_id, token, outbound);
    if('headSha' in observed&&observed.headSha)
      await persistGithubHeadSha(db, attempt.attempt_id, observed.headSha);
    readings.push(observed);
  }
  return readings;
}

async function persistReceipt(db:AttemptDatabase, runId:string, rows:AttemptCancelRow[]){
  const outcomes=new Set(rows.map(row=>row.receipt_outcome));
  if(outcomes.size!==1) return;
  if(outcomes.has('succeeded')){
    await persist(db, runId, 'succeeded', null, rows.length===1?rows[0].result_json??undefined:undefined);
    return;
  }
  if(outcomes.has('failed')) await persist(db, runId, 'failed', 'github_job_failed');
}

/**
 * Record the owner's cancel request outcome. A GitHub 202 stays requested
 * until the run and its jobs are terminal. An already sent or ambiguous
 * cancel is not sent again, and force-cancel is never used.
 */
export async function reconcileRunCancellation(
  db:AttemptDatabase, env:CancelRuntime, runId:string, outbound:Outbound=fetch,
):Promise<RunCancellation|null>{
  return reconcileCancelledRun(db,env,runId,outbound,0);
}

async function reconcileCancelledRun(
  db:AttemptDatabase, env:CancelRuntime, runId:string, outbound:Outbound, depth:number,
):Promise<RunCancellation|null>{
  const run=await db.prepare(`SELECT id,version_id,outcome,error_code,cancel_requested_at,start_state,instance_id
    FROM runs WHERE id=?`).bind(runId).first<RunCancelRow>();
  if(!run?.cancel_requested_at) return null;
  if(depth<LIMITS.maxChildDepth){
    await requestAwaitedChildCancellation(db,runId);
    const children=await db.prepare(`SELECT id FROM runs
      WHERE parent_run_id=? AND child_mode='await' AND cancel_requested_at IS NOT NULL
        AND outcome IN ('queued','running','waiting')`).bind(runId).all<{id:string}>();
    for(const child of children.results)
      await reconcileCancelledRun(db,env,child.id,outbound,depth+1);
  }
  if(run.outcome==='succeeded'||run.outcome==='failed') return 'completed';
  if(run.outcome==='cancelled') return 'cancelled';
  if(run.outcome==='indeterminate'&&run.error_code!=null&&!REFINABLE_ERRORS.has(run.error_code))
    return 'indeterminate';
  const sagaWait=await sagaCancelWait(db, env, run);
  if(sagaWait==='defer'){
    await issueCancels(db, env, await attempts(db, runId), outbound);
    return finish(db, runId, 'requested');
  }
  if(sagaWait==='unconfirmed'){
    if(run.start_state==='started') await bestEffortTerminate(env, run.instance_id);
    await issueCancels(db, env, await attempts(db, runId), outbound);
    await persist(db, runId, 'indeterminate', 'cancel_unconfirmed');
    return finish(db, runId, 'indeterminate');
  }
  if(run.start_state==='started') await bestEffortTerminate(env, run.instance_id);
  await issueCancels(db, env, await attempts(db, runId), outbound);
  const fresh=await attempts(db, runId);
  if(fresh.some(row=>row.state==='dispatch_unknown')){
    if(run.outcome==='queued'||run.outcome==='running')
      await persist(db, runId, 'indeterminate',
        run.error_code==='github_dispatch_unknown'?'github_dispatch_unknown':'cancel_unconfirmed');
    return finish(db, runId, 'indeterminate');
  }
  if(fresh.some(row=>row.state==='created')&&fresh.every(row=>row.candidate_run_id==null))
    return finish(db, runId, 'requested');
  const watched=fresh.filter(row=>row.candidate_run_id!=null&&
    ['confirmed','claimed','succeeded','failed','cancelled'].includes(row.state));
  if(!watched.length){
    const observed=run.start_state==='started'
      ?await observeInstance(env.WORKFLOW, run.instance_id)
      :{kind:'missing' as const};
    if(observed.kind==='unavailable'||(observed.kind==='found'&&
       (observed.status==='complete'||observed.status==='errored')))
      return finish(db, runId, 'indeterminate');
    if(observed.kind==='missing'||(observed.kind==='found'&&observed.status==='terminated')){
      await persist(db, runId, 'cancelled', null);
      return finish(db, runId, 'cancelled');
    }
    return finish(db, runId, 'requested');
  }
  const live=watched.filter(row=>row.receipt_outcome!=='succeeded'&&row.receipt_outcome!=='failed');
  const finished=watched.filter(row=>row.receipt_outcome==='succeeded'||row.receipt_outcome==='failed');
  if(!live.length){
    const readings=await observeRows(db, env, finished, outbound);
    if(readings.some(item=>item.kind==='cancelled'||item.kind==='unknown')){
      // A receipt and a conflicting or unreadable GitHub observation cannot
      // be collapsed into cancelled or succeeded.
      await persist(db, runId, 'indeterminate', 'cancel_unconfirmed');
      return finish(db, runId, 'indeterminate');
    }
    await persistReceipt(db, runId, finished);
    return finish(db, runId, 'completed');
  }
  const readings=await observeRows(db, env, live, outbound);
  const label=aggregate(readings, live.map(row=>row.cancel_effect));
  if(label==='cancelled'&&finished.length) return finish(db, runId, 'indeterminate');
  if(label==='cancelled'){
    await persist(db, runId, 'cancelled', null);
    return finish(db, runId, 'cancelled');
  }
  if(label==='completed'){
    if(finished.length) return finish(db, runId, 'indeterminate');
    await persist(db, runId, 'indeterminate', 'github_callback_unconfirmed');
    return finish(db, runId, 'completed');
  }
  return finish(db, runId, label);
}
