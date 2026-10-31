import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {requestGitHubActionCancellation} from './github-action-cancel.ts';

// Reserved internal Step IDs cannot be authored by the Definition compiler.
export const sagaReceiptId=(id:string)=>'__saga_'+id;
export type SagaReceipt='succeeded'|'requested'|'indeterminate'|'uncleared';

// A native rollback handler only requests cancellation of an exactly pinned
// temporary GitHub Session. A 202 ACK NEVER establishes physical termination.
// Existing GitHub Attempt/Session reconciliation remains the sole terminal proof.
export async function compensateSession(
 env:Env,plan:Plan,runId:string,step:Step,
 cancel:typeof requestGitHubActionCancellation=requestGitHubActionCancellation,
):Promise<SagaReceipt>{
 const receiptId=sagaReceiptId(step.id), time=Date.now();
 const action=step.with.action as Record<string,unknown>|undefined;
 const grant=plan.github_action_approvals?.some(g=>
   g.repository===action?.repository&&g.repositoryId===action.repositoryId&&
   g.workflowId===action.workflowId&&g.workflowPath===action.workflowPath&&
   g.commitSha===action.commitSha&&g.type===action.type&&
   g.contractDigest===action.contractDigest);
 const inputs=action?.inputs as Record<string,unknown>|undefined;
 const authorized=plan.github_execution_approved===true&&plan.saga_compensation_approved===true&&
    step.compensate?.kind==='github.session.cancel'&&grant===true&&
    action?.type==='session'&&inputs?.session_mode==='temporary'&&
    action.repository==='lirtual/session-actions'&&
    ['.github/workflows/ubuntu.yml','.github/workflows/windows.yml'].includes(String(action.workflowPath))&&
    !!env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
 const db=env.DB;
 // One D1 admission before the one allowed external cancel POST. A lost
 // callback or timeout cannot issue a second request on replay.
 // Denied compensation is also durable evidence: report a partial Saga
 // rather than leaving a completed, still-live Session as merely unconfirmed.
 // The same one-shot key prevents granting access later from replaying it.
 const reserved=await db.prepare(`INSERT INTO run_steps(run_id,step_id,status,updated_at)
   SELECT ?,?,?,? FROM run_steps f
   WHERE f.run_id=? AND f.step_id=? AND f.status='succeeded'
     AND EXISTS(SELECT 1 FROM session_executions s WHERE
       s.run_id=? AND s.step_id=? AND s.state!='terminated')
   ON CONFLICT(run_id,step_id) DO NOTHING`)
   .bind(runId,receiptId,authorized?'running':'uncleared',time,runId,step.id,runId,step.id).run();
 if(!authorized || !env.WORKFLOW_GITHUB_DISPATCH_TOKEN)return 'uncleared';
 if(reserved.meta.changes!==1){
   const prior=await db.prepare('SELECT status FROM run_steps WHERE run_id=? AND step_id=?')
     .bind(runId,receiptId).first<{status:SagaReceipt|'running'}>();
   if(prior)return prior.status==='running'?'indeterminate':prior.status;
   const terminal=await db.prepare("SELECT 1 AS present FROM session_executions WHERE run_id=? AND step_id=? AND state='terminated'")
     .bind(runId,step.id).first<{present:number}>();
   return terminal?'succeeded':'uncleared';
 }
 let result:SagaReceipt='indeterminate';
 try{
   const answer=await cancel(db,runId,step.id,env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
   result=answer==='terminal_confirmed'?'succeeded':
     ['cancel_requested','already_requested'].includes(answer)?'requested':
     ['cancel_unknown','physical_unconfirmed'].includes(answer)?'indeterminate':'uncleared';
 }catch{
   // Unknown result may have committed. Do not retry the POST.
   result='indeterminate';
 }
 try{
   await db.prepare('UPDATE run_steps SET status=?,updated_at=? WHERE run_id=? AND step_id=? AND status=\'running\'')
     .bind(result,Date.now(),runId,receiptId).run();
 }catch{/* An in-flight receipt is observably unknown, not safe to replay. */}
 return result;
}


// Native termination may report RollbackMissing while committing the D1
// cancellation. Send the same approved, one-shot cancellation through our
// existing receipt fence as a fallback; native and fallback cannot double
// dispatch because both reserve the same (Run, __saga_Step) key.
export async function compensateCancelledSessions(
 env:Env,plan:Plan,runId:string,
 compensate:typeof compensateSession=compensateSession,
):Promise<void>{
 if(!plan.saga?.on.includes('cancel')||!plan.saga_compensation_approved)return;
 for(const step of [...plan.steps].reverse()){
   if(!step.compensate)continue;
   try{await compensate(env,plan,runId,step);}
   catch{/* Unknown outbound state is never replayed. Other Steps continue. */}
 }
}
