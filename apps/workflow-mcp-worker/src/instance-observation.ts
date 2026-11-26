import {observeGitHubTaskTerminalFact,type GitHubTaskTerminalFact,type PersistedGitHubAttemptIdentity} from './github-action-attempt-inspection.ts';
import type {Plan} from './plan.ts';
// Interpret Cloudflare Workflows lookups conservatively. Its Workers API does
// not formally document a stable exception type for missing instances.
// Only the exact observed marker is considered missing; anything else is unavailable.
export type InstanceObservation =
  | {kind:'found';status:string}
  | {kind:'missing'}
  | {kind:'unavailable'};
type WorkflowLookup = {get(id:string):Promise<{status():Promise<{status:string}>}>};
export async function observeInstance(binding:WorkflowLookup,id:string):Promise<InstanceObservation> {
  try{
    const instance=await binding.get(id);
    const details=await instance.status();
    if(!details || !details.status || details.status==='unknown')return {kind:'unavailable'};
    return {kind:'found',status:details.status};
  }catch(error){
    // Only exact vendor marker, never fuzzy substring or generic 404 messages.
    if(error instanceof Error && (error.message.trim()==='instance.not_found' || error.message.trim()==='(instance.not_found) Instance not found'))return {kind:'missing'};
    return {kind:'unavailable'};
  }
}
// A native terminal error is not proof of business failure or side-effect rollback.
// When D1 never recorded its own result, preserve an explicit uncertain outcome.
export function unresolvedNativeTerminalError(native:string,outcome:string):string|null {
  if(outcome!=='queued' && outcome!=='running')return null;
  if(native==='errored')return 'orchestration_errored';
  if(native==='terminated')return 'orchestration_terminated';
  return null;
}
export const OUTCOME_SETTLE_WINDOW_MS=10*60_000;
export function shouldExpireUnconfirmedOutcome(native:string,outcome:string,firstSeen:number|null,now:number):boolean {
  return native==='complete'
    && (outcome==='queued'||outcome==='running')
    && firstSeen!==null
    && now-firstSeen >= OUTCOME_SETTLE_WINDOW_MS;
}

export type NativeTerminalStatus='complete'|'errored'|'terminated';
export type NativeTerminalFact={instance_id:string;status:NativeTerminalStatus;observed_at:number;github_attempts?:GitHubTaskTerminalFact[]};
export type NativeTerminalRecordResult='not_terminal'|'recorded'|'already_recorded'|'conflict';
type RunIdentity={id:string;instance_id:string;version_id:string};
export function isNativeTerminalStatus(status:unknown):status is NativeTerminalStatus{
 return status==='complete'||status==='errored'||status==='terminated';
}
/** Persist an authenticated lookup for this exact registered instance only.
 * Independent of business settlement, including when related executions remain active.
 * A concurrent identical observation is harmless; never replace another fact. */
export async function recordNativeTerminalObservation(
 db:Pick<D1Database,'prepare'>,run:RunIdentity,observation:InstanceObservation,observedAt=Date.now(),
):Promise<NativeTerminalRecordResult>{
 if(observation.kind!=='found'||!isNativeTerminalStatus(observation.status))return 'not_terminal';
 if(!Number.isSafeInteger(observedAt)||observedAt<=0)return 'conflict';
 const fact:NativeTerminalFact={instance_id:run.instance_id,status:observation.status,observed_at:observedAt};
 const changed=await db.prepare(`UPDATE runs SET execution_terminal_proof=?
  WHERE id=? AND instance_id=? AND version_id=? AND start_state='started' AND execution_terminal_proof IS NULL`)
  .bind(JSON.stringify(fact),run.id,run.instance_id,run.version_id).run();
 if(changed.meta.changes===1)return 'recorded';
 const existing=await db.prepare(`SELECT execution_terminal_proof FROM runs
  WHERE id=? AND instance_id=? AND version_id=? AND start_state='started'`)
  .bind(run.id,run.instance_id,run.version_id).first<{execution_terminal_proof:string|null}>();
 try{
  const saved=JSON.parse(existing?.execution_terminal_proof??'null') as NativeTerminalFact|null;
  if(saved?.instance_id===fact.instance_id&&saved.status===fact.status&&
   Number.isSafeInteger(saved.observed_at)&&saved.observed_at>0)return 'already_recorded';
 }catch{/* Invalid persisted evidence is a conflict, not a permit. */}
 return 'conflict';
}

type TaskProofCandidate=PersistedGitHubAttemptIdentity&RunIdentity&{
 execution_terminal_proof:string;plan:string;
};

/** Extend only the missing facts in the same existing Run field. Never
 * replace native evidence or modify the Attempt's business/physical state.
 * Conflicting writes are retried only on a later independently read tick. */
export async function recordGitHubTaskTerminalFact(
 db:Pick<D1Database,'prepare'>,candidate:TaskProofCandidate,fact:GitHubTaskTerminalFact,
):Promise<NativeTerminalRecordResult>{
 let base:NativeTerminalFact;
 try{base=JSON.parse(candidate.execution_terminal_proof);}catch{return 'conflict';}
 if(base?.instance_id!==candidate.instance_id||!isNativeTerminalStatus(base.status)||
    !Number.isSafeInteger(base.observed_at)||base.observed_at<=0||
    (base.github_attempts!==undefined&&!Array.isArray(base.github_attempts))||
    fact.attempt_id!==candidate.attempt_id||fact.repository_id!==candidate.repository_id||
    fact.run_id!==candidate.candidate_run_id||fact.run_attempt!==candidate.candidate_run_attempt||
    fact.workflow_ref!==candidate.workflow_ref)return 'conflict';
 const previous=base.github_attempts??[];
 if(previous.some(p=>p.attempt_id===fact.attempt_id))return 'conflict';
 const next=JSON.stringify({...base,github_attempts:[...previous,fact].sort((a,b)=>a.attempt_id.localeCompare(b.attempt_id))});
 if(new TextEncoder().encode(next).byteLength>4096)return 'conflict';
 const updated=await db.prepare(`UPDATE runs SET execution_terminal_proof=?
   WHERE id=? AND instance_id=? AND version_id=? AND start_state='started'
   AND outcome IN ('succeeded','failed','cancelled','indeterminate')
   AND execution_terminal_proof=?
   AND EXISTS(SELECT 1 FROM step_attempts a WHERE a.attempt_id=? AND a.run_id=runs.id
     AND a.step_id=? AND a.capability_id='github.action' AND a.state=? AND a.repository=?
     AND a.repository_id=? AND a.workflow_ref=? AND a.ref=? AND a.resolved_sha IS ?
     AND a.candidate_run_id=? AND a.candidate_run_attempt=?
     AND a.owner_run_id IS ? AND a.owner_run_attempt IS ?
     AND NOT EXISTS(SELECT 1 FROM session_executions s WHERE s.run_id=a.run_id AND s.step_id=a.step_id))`)
  .bind(next,candidate.id,candidate.instance_id,candidate.version_id,candidate.execution_terminal_proof,
    candidate.attempt_id,candidate.step_id,candidate.state,candidate.repository,candidate.repository_id,
    candidate.workflow_ref,candidate.ref,candidate.resolved_sha,candidate.candidate_run_id,
    candidate.candidate_run_attempt,candidate.owner_run_id,candidate.owner_run_attempt).run();
 return updated.meta.changes===1?'recorded':'conflict';
}

// Reuse the minute trigger once per hour. At the observed personal workload
// (8 Runs/day) 12 lookups/hour cover fresh work well before the minimum
// documented native retention of 3 days. New evidence must not be starved
// by older unavailable instances. No full historical native inventory.
export const NATIVE_PROOF_HOURLY_LIMIT=12;
const NATIVE_PROOF_RECENT_MS=3*24*60*60_000;
export async function collectNativeTerminalProofs(
 env:{DB:Pick<D1Database,'prepare'>;WORKFLOW:WorkflowLookup;WORKFLOW_GITHUB_DISPATCH_TOKEN?:string},scheduledTime:number,now=Date.now(),
 inspectTask=observeGitHubTaskTerminalFact,
):Promise<{checked:number;recorded:number;unavailable:number;conflicts:number}>{
 const stats={checked:0,recorded:0,unavailable:0,conflicts:0};
 if(!Number.isSafeInteger(scheduledTime)||scheduledTime<0||
    Math.floor(scheduledTime/60000)%60!==0)return stats;
 // Reserve actual unresolved Task candidates before allocating the native
 // share. A Task API outage cannot consume the entire native budget, and
 // repeated native failures cannot starve these already-observed Tasks.
 const token=env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
 let tasks:TaskProofCandidate[]=[];
 if(token)try{
  ({results:tasks}=await env.DB.prepare(`SELECT r.id,r.instance_id,r.version_id,r.execution_terminal_proof,
   a.attempt_id,a.run_id,a.step_id,a.state,a.capability_id,a.repository,a.repository_id,a.workflow_ref,a.ref,
   a.resolved_sha,a.candidate_run_id,a.candidate_run_attempt,a.owner_run_id,a.owner_run_attempt,v.plan
   FROM runs r JOIN step_attempts a ON a.run_id=r.id
   JOIN workflow_versions v ON v.id=r.version_id AND v.workflow_id=r.workflow_id
   WHERE r.start_state='started' AND r.updated_at>=? AND r.execution_terminal_proof IS NOT NULL
   AND r.outcome IN ('succeeded','failed','cancelled','indeterminate')
   AND a.capability_id='github.action' AND a.state IN ('confirmed','claimed')
   AND a.candidate_run_id IS NOT NULL AND a.candidate_run_attempt IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM session_executions s WHERE s.run_id=a.run_id AND s.step_id=a.step_id)
   AND NOT EXISTS(SELECT 1 FROM json_each(r.execution_terminal_proof,'$.github_attempts') j
     WHERE json_extract(j.value,'$.attempt_id')=a.attempt_id)
   ORDER BY r.updated_at DESC,a.attempt_id ASC LIMIT ?`)
   .bind(now-NATIVE_PROOF_RECENT_MS,Math.floor(NATIVE_PROOF_HOURLY_LIMIT/2)).all<TaskProofCandidate>());
 }catch{stats.unavailable++;}

 const {results}=await env.DB.prepare(`SELECT id,instance_id,version_id FROM runs
  WHERE start_state='started' AND execution_terminal_proof IS NULL AND updated_at>=?
  ORDER BY updated_at DESC,id ASC LIMIT ?`)
  .bind(now-NATIVE_PROOF_RECENT_MS,NATIVE_PROOF_HOURLY_LIMIT-tasks.length).all<RunIdentity>();
 for(const run of results){
  stats.checked++;
  try{
   const observed=await observeInstance(env.WORKFLOW,run.instance_id);
   if(observed.kind!=='found'){stats.unavailable++;continue;}
   const recorded=await recordNativeTerminalObservation(env.DB,run,observed);
   if(recorded==='recorded')stats.recorded++;
   else if(recorded==='conflict')stats.conflicts++;
  }catch{stats.unavailable++;}
 }
 if(token){
  for(const task of tasks){
   stats.checked++;
   try{
    const native=JSON.parse(task.execution_terminal_proof) as NativeTerminalFact;
    if(native.instance_id!==task.instance_id||!isNativeTerminalStatus(native.status)||
       !Number.isSafeInteger(native.observed_at)||native.observed_at<=0){stats.conflicts++;continue;}
    const fact=await inspectTask(JSON.parse(task.plan) as Plan,task,token);
    if(!fact){stats.unavailable++;continue;}
    // Another fact may have been appended for this Run earlier in the tick.
    // Read the current exact proof, preserving its original native identity.
    const saved=await env.DB.prepare('SELECT execution_terminal_proof FROM runs WHERE id=? AND instance_id=? AND version_id=?')
      .bind(task.id,task.instance_id,task.version_id).first<{execution_terminal_proof:string|null}>();
    if(!saved?.execution_terminal_proof){stats.conflicts++;continue;}
    const observed=JSON.parse(saved.execution_terminal_proof) as NativeTerminalFact;
    if(observed.instance_id!==native.instance_id||observed.status!==native.status||observed.observed_at!==native.observed_at){
      stats.conflicts++;continue;
    }
    const recorded=await recordGitHubTaskTerminalFact(env.DB,{...task,execution_terminal_proof:saved.execution_terminal_proof},fact);
    if(recorded==='recorded')stats.recorded++;
    else if(recorded==='conflict')stats.conflicts++;
   }catch{stats.unavailable++;}
  }
 }
 return stats;
}
