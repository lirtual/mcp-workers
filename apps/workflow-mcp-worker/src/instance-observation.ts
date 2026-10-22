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
