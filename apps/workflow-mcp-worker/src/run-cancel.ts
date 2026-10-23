import type { AttemptDatabase } from './github-claim.ts';
import { cancelRegisteredGithubRun, observeRegisteredGithubRun, type GithubExecutionObservation } from './github-dispatch.ts';
import { observeInstance } from './instance-observation.ts';

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
  outcome:string;
  error_code:string|null;
  cancel_requested_at:number|null;
  start_state:string;
  instance_id:string;
};
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
    outcome IN ('queued','running') OR
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

async function observeRows(env:CancelRuntime, rows:AttemptCancelRow[], outbound:Outbound){
  const token=env.WORKFLOW_EXECUTOR_GITHUB_TOKEN;
  const repository=env.GITHUB_EXECUTOR_REPOSITORY;
  const readings:GithubExecutionObservation[]=[];
  for(const attempt of rows){
    if(!token||attempt.repository!==repository||attempt.candidate_run_id==null){
      readings.push({kind:'unknown'});
      continue;
    }
    readings.push(await observeRegisteredGithubRun(attempt.repository, attempt.candidate_run_id, token, outbound));
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
  const run=await db.prepare(`SELECT id,outcome,error_code,cancel_requested_at,start_state,instance_id
    FROM runs WHERE id=?`).bind(runId).first<RunCancelRow>();
  if(!run?.cancel_requested_at) return null;
  if(run.outcome==='succeeded'||run.outcome==='failed') return 'completed';
  if(run.outcome==='cancelled') return 'cancelled';
  if(run.outcome==='indeterminate'&&run.error_code!=null&&!REFINABLE_ERRORS.has(run.error_code))
    return 'indeterminate';
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
    const readings=await observeRows(env, finished, outbound);
    if(readings.some(item=>item.kind==='cancelled'||item.kind==='unknown')){
      // A receipt and a conflicting or unreadable GitHub observation cannot
      // be collapsed into cancelled or succeeded.
      await persist(db, runId, 'indeterminate', 'cancel_unconfirmed');
      return finish(db, runId, 'indeterminate');
    }
    await persistReceipt(db, runId, finished);
    return finish(db, runId, 'completed');
  }
  const readings=await observeRows(env, live, outbound);
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
