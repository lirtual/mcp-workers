import {auxiliaryBarkStepId,type Plan} from './plan.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';

/** Read-only recovery of an already-completed effect; never re-dispatch.
 * A completed Step without its exact physical/Provider reservation is insufficient.
 */
export async function verifiedAuxiliaryBusinessOutput(
 db:Pick<D1Database,'prepare'>,plan:Plan,runId:string,
):Promise<unknown|null>{
 if(!auxiliaryBarkStepId(plan))return null;
 const source=plan.steps[0]!;
 let output:string|null=null;
 if(source.uses==='action.run'){
  const grant=plan.cloudflare_action_approvals?.find(g=>
   g.executor==='cloudflare'&&g.provider===source.with.provider&&
   g.action===source.with.action&&g.contract_digest===source.with.contract_digest);
  if(!plan.cloudflare_execution_approved||!grant)return null;
  const row=await db.prepare(`SELECT s.output FROM run_steps s
    JOIN cloudflare_action_invocations i ON i.run_id=s.run_id AND i.step_id=s.step_id
    WHERE s.run_id=? AND s.step_id=? AND s.status='succeeded'
      AND i.contract_digest=?`)
   .bind(runId,source.id,grant.contract_digest)
   .first<{output:string|null}>();
  output=row?.output??null;
 }else if(source.uses==='github.run'){
  const raw=source.with.action as (ReviewedGitHubAction&{ref?:unknown})|undefined;
  if(!raw||!plan.github_execution_approved||!isPublishedGitHubActionApproved(
    plan.github_action_approvals,{repository:raw.repository,repositoryId:raw.repositoryId,
    workflowId:raw.workflowId,workflowPath:raw.workflowPath,commitSha:raw.commitSha,
    type:raw.type,contractDigest:raw.contractDigest}))return null;
  const row=await db.prepare(`SELECT s.output FROM run_steps s
    JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
    WHERE s.run_id=? AND s.step_id=? AND s.status='succeeded'
      AND a.capability_id='github.action' AND a.candidate_run_id>0
      AND a.candidate_run_attempt>0 AND a.owner_run_id=a.candidate_run_id
      AND a.owner_run_attempt=a.candidate_run_attempt`)
   .bind(runId,source.id).first<{output:string|null}>();
  output=row?.output??null;
 }
 if(!output)return null;
 try{
  const value=JSON.parse(output) as unknown;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const data=value as Record<string,unknown>;
  if(source.uses==='action.run'&&data.status!=='accepted')return null;
  if(source.uses==='github.run'&&(!data.session||typeof data.session!=='object'||
    (data.session as Record<string,unknown>).recorded_state!=='ready'))return null;
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>64*1024)return null;
  return value;
 }catch{return null;}
}

/** Restore business outcome after an auxiliary notification interrupted the native
 * instance. CAS never overwrites cancellation or an earlier terminal outcome.
 */
export async function settleVerifiedAuxiliaryBusiness(
 db:Pick<D1Database,'prepare'>,plan:Plan,runId:string,
):Promise<boolean>{
 const notification=auxiliaryBarkStepId(plan);
 if(!notification)return false;
 const result=await verifiedAuxiliaryBusinessOutput(db,plan,runId);
 if(result===null)return false;
 const updated=await db.prepare(`UPDATE runs SET outcome='succeeded',result=?,
   error_code=NULL,updated_at=? WHERE id=? AND outcome='running'`)
  .bind(JSON.stringify(result),Date.now(),runId).run();
 if(updated.meta.changes!==1){
  const prior=await db.prepare('SELECT outcome FROM runs WHERE id=?')
   .bind(runId).first<{outcome:string}>();
  return prior?.outcome==='succeeded';
 }
 // No second external send. Preserve any existing confirmed Bark receipt.
 await db.prepare(`INSERT INTO run_steps
   (run_id,step_id,status,output,error_code,updated_at)
   VALUES(?,?,'indeterminate',NULL,'bark_outcome_unconfirmed',?)
   ON CONFLICT(run_id,step_id) DO UPDATE SET status=excluded.status,
    error_code=excluded.error_code,updated_at=excluded.updated_at
   WHERE run_steps.status NOT IN ('succeeded','failed','skipped','indeterminate','cancelled')`)
  .bind(runId,notification,Date.now()).run();
 return true;
}
