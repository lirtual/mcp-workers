/**
 * DISPOSABLE GitHub OIDC -> D1 evidence Worker, NEVER production ingress.
 * Accepts only Bearer tokens verified by the GitHub module and exact D1 candidate.
 * No registration, untrusted grants, generic SQL, or result read endpoints.
 */
import {
  verifyAndClaimGithubAttempt,verifyGithubClaimedOwner,
  type ExecutorIdentity,
} from '../../src/github-claim.ts';
import { recordGithubCallback,notifyStoredGithubReceipt } from '../../src/github-callback.ts';
import { WorkflowEntrypoint,type WorkflowEvent,type WorkflowStep } from 'cloudflare:workers';

type E={DB:D1Database; EXPECTED_REPO:string; EXPECTED_REPOSITORY_ID:string;
  EXPECTED_WORKFLOW_REF:string; EXPECTED_REF:string; EXPECTED_AUDIENCE:string;
  WORKFLOW:Workflow<{attemptId:string}>};
type Stored={run_id:string;instance_id:string};
const targetRun=async(db:D1Database,attemptId:string)=>db.prepare(
  'SELECT a.run_id,r.instance_id FROM step_attempts a JOIN runs r ON r.id=a.run_id WHERE a.attempt_id=?'
).bind(attemptId).first<Stored>();

// This is an isolated acceptance-only Workflow class, not a new production
// scheduler or implementation of the entire GitHub Workflow DAG.
export class S3ReceiptWaiter extends WorkflowEntrypoint<E,{attemptId:string}> {
  async run(event:WorkflowEvent<{attemptId:string}>,step:WorkflowStep){
    const wake=await step.waitForEvent<{attemptId:string;callbackId:string}>(
      'wait for durable callback',{type:'github-receipt',timeout:'3 minutes'});
    if(wake.payload.attemptId!==event.payload.attemptId)
      throw Error('wake_attempt_mismatch');
    return step.do('check durable callback result',async()=>{
      const db=this.env.DB;
      const receipt=await db.prepare(
        'SELECT callback_id,outcome,result_json FROM callback_receipts WHERE attempt_id=?'
      ).bind(event.payload.attemptId).first<{
        callback_id:string;outcome:'succeeded'|'failed';result_json:string
      }>();
      if(!receipt||receipt.callback_id!==wake.payload.callbackId)
        throw Error('receipt_not_committed');
      const linked=await targetRun(db,event.payload.attemptId);
      if(!linked||linked.instance_id!==event.instanceId)
        throw Error('run_instance_not_authorized');
      const result=await db.prepare(`UPDATE runs SET outcome=?,result=?,updated_at=?
        WHERE id=? AND outcome IN ('queued','running')`).bind(
        receipt.outcome,receipt.result_json,Date.now(),linked.run_id,
      ).run();
      if(result.meta.changes!==1)throw Error('terminal_run_not_mutable');
      return {status:receipt.outcome};
    });
  }
}
const response=(code:number,message:string)=>Response.json({result:message},{status:code,headers:{'cache-control':'no-store'}});
export default {
  async fetch(request:Request,env:E):Promise<Response>{
    const url=new URL(request.url);
    if(request.method!=='POST'||!['/claim','/start','/callback'].includes(url.pathname))
      return response(404,'not_found');
    if((Number(request.headers.get('content-length'))||0)>8192)
      return response(413,'too_large');
    const authorization=request.headers.get('authorization')||'';
    if(!authorization.startsWith('Bearer ')||authorization.length>8300)
      return response(401,'unauthorized');
    const token=authorization.slice(7);
    const pinned:ExecutorIdentity={
      repository:env.EXPECTED_REPO,
      repositoryId:env.EXPECTED_REPOSITORY_ID,
      workflowRef:env.EXPECTED_WORKFLOW_REF,
      ref:env.EXPECTED_REF,
      audience:env.EXPECTED_AUDIENCE,
    };
    let body:unknown;
    try{
      const raw=await request.text();
      if(raw.length>8192)return response(413,'too_large');
      body=JSON.parse(raw);
    }catch{return response(400,'invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))
      return response(400,'invalid_payload');
    const record=body as Record<string,unknown>;
    try{
      if(url.pathname==='/claim'){
        if(typeof record.attemptId!=='string'||Object.keys(record).length!==1)
          return response(400,'invalid_payload');
        const claimed=await verifyAndClaimGithubAttempt(
          env.DB,record.attemptId,token,pinned);
        return claimed?response(200,'claimed'):response(403,'claim_denied');
      }
      if(url.pathname==='/start'){
        if(typeof record.attemptId!=='string'||Object.keys(record).length!==1)
          return response(400,'invalid_payload');
        if(!await verifyGithubClaimedOwner(env.DB,record.attemptId,token,pinned))
          return response(403,'start_denied');
        const linked=await targetRun(env.DB,record.attemptId);
        if(!linked)return response(403,'start_denied');
        await env.WORKFLOW.create({id:linked.instance_id,params:{attemptId:record.attemptId}});
        return response(202,'started');
      }
      if(typeof record.attemptId!=='string'||typeof record.callbackId!=='string'||
        (record.outcome!=='succeeded'&&record.outcome!=='failed')||
        Object.keys(record).sort().join(',')!=='attemptId,callbackId,outcome,result')
        return response(400,'invalid_payload');
      const ok=await recordGithubCallback(env.DB,{
        attemptId:record.attemptId,callbackId:record.callbackId,
        outcome:record.outcome,result:record.result,
      },token,pinned);
      if(!ok)return response(403,'callback_denied');
      const linked=await targetRun(env.DB,record.attemptId);
      if(!linked)return response(503,'unavailable');
      try{
        const delivered=await notifyStoredGithubReceipt(env.DB,record.attemptId,async event=>{
          const instance=await env.WORKFLOW.get(linked.instance_id);
          await instance.sendEvent({type:'github-receipt',payload:event});
        });
        return delivered?response(200,'stored_and_notified'):response(202,'stored_pending');
      }catch{
        // The immutable receipt is safely committed. The caller may
        // retry this notification without re-executing the heavy job.
        return response(202,'stored_pending');
      }
    }catch{
      // No token, signed claims, SQL, secrets or internal exception leaked.
      return response(503,'unavailable');
    }
  },
};
