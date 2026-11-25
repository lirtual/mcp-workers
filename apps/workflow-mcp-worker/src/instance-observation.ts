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
export type NativeTerminalFact={instance_id:string;status:NativeTerminalStatus;observed_at:number};
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

// Reuse the minute trigger once per hour. At the observed personal workload
// (8 Runs/day) 12 lookups/hour cover fresh work well before the minimum
// documented native retention of 3 days. New evidence must not be starved
// by older unavailable instances. No full historical native inventory.
export const NATIVE_PROOF_HOURLY_LIMIT=12;
const NATIVE_PROOF_RECENT_MS=3*24*60*60_000;
export async function collectNativeTerminalProofs(
 env:{DB:Pick<D1Database,'prepare'>;WORKFLOW:WorkflowLookup},scheduledTime:number,now=Date.now(),
):Promise<{checked:number;recorded:number;unavailable:number;conflicts:number}>{
 const stats={checked:0,recorded:0,unavailable:0,conflicts:0};
 if(!Number.isSafeInteger(scheduledTime)||scheduledTime<0||
    Math.floor(scheduledTime/60000)%60!==0)return stats;
 const {results}=await env.DB.prepare(`SELECT id,instance_id,version_id FROM runs
  WHERE start_state='started' AND execution_terminal_proof IS NULL AND updated_at>=?
  ORDER BY updated_at DESC,id ASC LIMIT ?`)
  .bind(now-NATIVE_PROOF_RECENT_MS,NATIVE_PROOF_HOURLY_LIMIT).all<RunIdentity>();
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
 return stats;
}
