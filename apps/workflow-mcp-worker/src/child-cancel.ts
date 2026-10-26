import type {Env} from './store.ts';

/** This is a one-shot *request*, not proof of external child side-effect rollback.
 * D1 intent is unique per parent Step and written BEFORE calling terminate().
 * Replays must inspect native state but must never call terminate() again.
 */
export async function cancelAwaitedChild(
 env:Env,parentRunId:string,stepId:string,
):Promise<'not_found'|'already_terminal'|'requested_unverified'|'terminal_confirmed'>{
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
 if(child.outcome==='cancelled')return 'terminal_confirmed';
 if(!['queued','running'].includes(child.outcome))return 'already_terminal';
 if(child.start_state!=='started'||child.instance_id!==child.id)return 'not_found';
 // Only read the native instance before the durable request fence. This read
 // has no side effect, so generic transport failures can be safely retried.
 let instance:Awaited<ReturnType<Env['WORKFLOW']['get']>>;
 let before:string;
 try{
   instance=await env.WORKFLOW.get(child.id);
   before=(await instance.status()).status;
 }catch{return 'requested_unverified';}
 if(before==='terminated'){
   await db.prepare(`UPDATE runs SET outcome='cancelled',updated_at=?
     WHERE id=? AND start_state='started' AND outcome IN ('queued','running')
     AND EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=?)`)
     .bind(Date.now(),child.id,child.id).run();
   const saved=await db.prepare('SELECT outcome FROM runs WHERE id=?')
     .bind(child.id).first<{outcome:string}>();
   return saved?.outcome==='cancelled'?'terminal_confirmed':'requested_unverified';
 }
 if(['complete','errored'].includes(before))return 'already_terminal';
 if(!instance.terminate)return 'requested_unverified';
 const inserted=await db.prepare(`INSERT OR IGNORE INTO child_cancellations
   (parent_run_id,parent_step_id,child_run_id,requested_at)
   SELECT c.parent_run_id,c.parent_step_id,c.id,?
   FROM runs c WHERE c.id=? AND c.parent_run_id=? AND c.parent_step_id=?
   AND c.start_state='started' AND c.outcome IN ('queued','running')`)
   .bind(Date.now(),child.id,parentRunId,stepId).run();
 if(inserted.meta.changes===1){
   try{await instance.terminate();}catch{
     // Response loss does not permit a second termination request.
   }
 }
 try{
   const after=(await instance.status()).status;
   if(after==='terminated'){
     await db.prepare(`UPDATE runs SET outcome='cancelled',updated_at=?
       WHERE id=? AND outcome IN ('queued','running')
       AND EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=?)`)
       .bind(Date.now(),child.id,child.id).run();
     return 'terminal_confirmed';
   }
 }catch{}
 return 'requested_unverified';
}
