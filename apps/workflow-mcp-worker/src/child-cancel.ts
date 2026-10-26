import type {Env} from './store.ts';

/** A durable cancellation intent, not proof of rollback of external effects.
 * Reservation may be cancelled before a native create claim. Once creation
 * is claimed, a distinct one-shot D1 fence controls native terminate().
 */
export async function cancelAwaitedChild(
 env:Pick<Env,'DB'|'WORKFLOW'>,parentRunId:string,stepId:string,
):Promise<'not_found'|'already_terminal'|'requested_unverified'|'terminal_confirmed'|'cancelled_before_start'>{
 const db=env.DB;
 const child=await db.prepare(`SELECT c.id,c.instance_id,c.start_state,c.outcome,
   v.plan AS parent_plan
   FROM runs c JOIN runs p ON p.id=c.parent_run_id
   JOIN workflow_versions v ON v.id=p.version_id
   WHERE c.parent_run_id=? AND c.parent_step_id=?`)
   .bind(parentRunId,stepId)
   .first<{id:string;instance_id:string;start_state:string;outcome:string;parent_plan:string}>();
 if(!child)return 'not_found';
 let published:any;
 try{published=JSON.parse(child.parent_plan);}catch{return 'not_found';}
 if(!Array.isArray(published.steps)||!published.steps.some((s:any)=>
   s.id===stepId&&s.uses==='flow.child'))return 'not_found';
 if(child.outcome==='cancelled')
   return child.start_state==='cancelled_before_start'?'cancelled_before_start':'terminal_confirmed';
 if(!['queued','running'].includes(child.outcome))return 'already_terminal';
 if(child.instance_id!==child.id)return 'not_found';

 // Before the atomic native-dispatch fence, cancellation wins without an
 // external request. 'creating' is only a local reservation claim; it does
 // not grant permission to invoke Cloudflare until 'dispatching' is set.
 if(child.start_state==='reserved'||child.start_state==='creating'){
   const stopped=await db.prepare(`UPDATE runs
     SET outcome='cancelled',start_state='cancelled_before_start',
       error_code='cancelled_before_start',updated_at=?
     WHERE id=? AND parent_run_id=? AND parent_step_id=?
       AND start_state IN ('reserved','creating') AND outcome='queued'`)
     .bind(Date.now(),child.id,parentRunId,stepId).run();
   if(stopped.meta.changes===1)return 'cancelled_before_start';
 }

 // Creation was already claimed (or is being reconciled). Record intent
 // BEFORE inspecting native state. A transient 404 is not proof that a
 // preceding native create will never complete.
 await db.prepare(`INSERT OR IGNORE INTO child_cancellations
   (parent_run_id,parent_step_id,child_run_id,requested_at)
   SELECT c.parent_run_id,c.parent_step_id,c.id,?
   FROM runs c WHERE c.id=? AND c.parent_run_id=? AND c.parent_step_id=?
     AND c.start_state IN ('dispatching','start_unknown','started')
     AND c.outcome IN ('queued','running')`)
   .bind(Date.now(),child.id,parentRunId,stepId).run();
 const intent=await db.prepare(`SELECT termination_attempted_at
   FROM child_cancellations WHERE child_run_id=?`)
   .bind(child.id).first<{termination_attempted_at:number|null}>();
 if(!intent){
   const current=await db.prepare('SELECT outcome,start_state FROM runs WHERE id=?')
     .bind(child.id).first<{outcome:string;start_state:string}>();
   if(current?.outcome==='cancelled'&&current.start_state==='cancelled_before_start')
     return 'cancelled_before_start';
   return current&& !['queued','running'].includes(current.outcome)
     ?'already_terminal':'requested_unverified';
 }

 let instance:Awaited<ReturnType<Env['WORKFLOW']['get']>>;
 let before:string;
 try{
   instance=await env.WORKFLOW.get(child.id);
   before=(await instance.status()).status;
 }catch{return 'requested_unverified';}
 if(before==='terminated'){
   await db.prepare(`UPDATE runs SET outcome='cancelled',start_state='cancelled',updated_at=?
     WHERE id=? AND outcome IN ('queued','running')
     AND EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=?)`)
     .bind(Date.now(),child.id,child.id).run();
   const saved=await db.prepare('SELECT outcome FROM runs WHERE id=?')
     .bind(child.id).first<{outcome:string}>();
   return saved?.outcome==='cancelled'?'terminal_confirmed':'requested_unverified';
 }
 if(['complete','errored'].includes(before))return 'already_terminal';
 if(!instance.terminate)return 'requested_unverified';

 // The cancellation intent can be retried for observation, but only ONE
 // contender gets permission to POST terminate, including after lost ACK.
 const claim=await db.prepare(`UPDATE child_cancellations
   SET termination_attempted_at=?
   WHERE child_run_id=? AND termination_attempted_at IS NULL`)
   .bind(Date.now(),child.id).run();
 if(claim.meta.changes===1){
   try{await instance.terminate();}catch{
     // Do not repeat an uncertain external side effect.
   }
 }
 try{
   const after=(await instance.status()).status;
   if(after==='terminated'){
     await db.prepare(`UPDATE runs SET outcome='cancelled',start_state='cancelled',updated_at=?
       WHERE id=? AND outcome IN ('queued','running')
       AND EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=?)`)
       .bind(Date.now(),child.id,child.id).run();
     return 'terminal_confirmed';
   }
 }catch{}
 return 'requested_unverified';
}
