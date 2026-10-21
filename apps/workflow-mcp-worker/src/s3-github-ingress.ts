import { verifyAndClaimGithubAttempt } from './s3-github-claim.ts';
import { recordGithubCallback,notifyStoredGithubReceipt } from './s3-github-callback.ts';
import type { Env } from './store.ts';
import { selectedS3Executor } from './s3-github-dispatch.ts';
import type { ExecutorIdentity } from './s3-github-claim.ts';

// This path is not MCP Portal authentication; it accepts only GitHub-issued,
// cryptographically verified OIDC for one configured repository + workflow.
// S3 remains entirely OFF unless explicitly enabled in this deployment.
const answer=(code:number,result:string)=>Response.json({result},{
  status:code,headers:{'cache-control':'no-store'},
});
type RequestBody={attemptId?:unknown;callbackId?:unknown;outcome?:unknown;result?:unknown};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RegisteredS3Row={
  repository:string;repository_id:string;workflow_ref:string;ref:string;
  state:string;run_outcome:string;
};
/**
 * Pin a callback to the identity captured at the *original* dispatch, not
 * the current Worker release's branch. A deployment may update the current
 * dispatch ref while a previously approved GitHub job is still running.
 * No callback parameter can set or broaden this D1 identity.
 *
 * Repository ID, registered workflow family and audience remain controlled
 * by the environment. Audience rotation requires a drain of active jobs.
 */
export async function resolveRegisteredS3Identity(
  env:Env,attemptId:string,
):Promise<ExecutorIdentity|null>{
  if(!uuid.test(attemptId)||env.S3_ENABLED!=='true'||
     !env.S3_GITHUB_REPOSITORY||!env.S3_GITHUB_REPOSITORY_ID||
     !env.S3_GITHUB_AUDIENCE||!env.DB)return null;
  const executor=selectedS3Executor(env);
  const row=await env.DB.prepare(`SELECT a.repository,a.repository_id,
    a.workflow_ref,a.ref,a.state,r.outcome AS run_outcome
    FROM step_attempts a JOIN runs r ON r.id=a.run_id
    WHERE a.attempt_id=?`).bind(attemptId).first<RegisteredS3Row>();
  if(!row||!['confirmed','claimed'].includes(row.state)||
     !['queued','running'].includes(row.run_outcome)||
     row.repository!==env.S3_GITHUB_REPOSITORY||
     row.repository_id!==env.S3_GITHUB_REPOSITORY_ID||
     !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(row.ref)||
     row.ref.includes('..')||row.ref.includes('//')||
     row.workflow_ref!==row.repository+
       '/.github/workflows/'+executor.workflow+'@'+row.ref)return null;
  return {repository:row.repository,repositoryId:row.repository_id,
    workflowRef:row.workflow_ref,ref:row.ref,
    audience:env.S3_GITHUB_AUDIENCE};
}

export async function handleGithubCallbackRequest(request:Request,env:Env):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path!=='/s3/claim'&&path!=='/s3/callback')
    return answer(404,'not_found');
  if(env.S3_ENABLED!=='true')return answer(404,'not_found');
  if(request.method!=='POST')return answer(405,'method_not_allowed');
  if(!env.DB||!env.WORKFLOW||!env.S3_GITHUB_REPOSITORY||
     !env.S3_GITHUB_REPOSITORY_ID||!env.S3_GITHUB_REF||
     !env.S3_GITHUB_AUDIENCE)return answer(503,'s3_not_configured');
  const bearer=request.headers.get('authorization')||'';
  if(!bearer.startsWith('Bearer ')||bearer.length>8300)
    return answer(401,'unauthorized');
  if((Number(request.headers.get('content-length'))||0)>8192)
    return answer(413,'too_large');
  let body:RequestBody;
  try{
    const text=await request.text();
    if(text.length>8192)return answer(413,'too_large');
    const raw=JSON.parse(text);
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return answer(400,'invalid_request');
    body=raw as RequestBody;
  }catch{return answer(400,'invalid_request');}
  if(typeof body.attemptId!=='string'||!uuid.test(body.attemptId))
    return answer(400,'invalid_attempt');
  const jwt=bearer.slice(7);
  let pinned:ExecutorIdentity|null;
  try{pinned=await resolveRegisteredS3Identity(env,body.attemptId);}
  catch{return answer(503,'s3_executor_misconfigured');}
  if(!pinned)return answer(403,'claim_denied');
  try{
    if(path==='/s3/claim'){
      if(Object.keys(body).length!==1)return answer(400,'invalid_request');
      const claimed=await verifyAndClaimGithubAttempt(env.DB,body.attemptId,jwt,pinned);
      return claimed?answer(200,'claimed'):answer(403,'claim_denied');
    }
    if(typeof body.callbackId!=='string'||!uuid.test(body.callbackId)||
       (body.outcome!=='succeeded'&&body.outcome!=='failed')||
       Object.keys(body).sort().join(',')!=='attemptId,callbackId,outcome,result')
      return answer(400,'invalid_request');
    const saved=await recordGithubCallback(env.DB,{
      attemptId:body.attemptId,callbackId:body.callbackId,
      outcome:body.outcome,result:body.result,
    },jwt,pinned);
    if(!saved)return answer(403,'callback_denied');
    const row=await env.DB.prepare(
      'SELECT r.instance_id,a.step_id FROM step_attempts a JOIN runs r ON r.id=a.run_id WHERE a.attempt_id=?'
    ).bind(body.attemptId).first<{instance_id:string;step_id:string}>();
    if(!row)return answer(503,'unavailable');
    try{
      await notifyStoredGithubReceipt(env.DB,body.attemptId!,async payload=>{
        const instance=await env.WORKFLOW.get(row.instance_id);
        if(!instance.sendEvent)throw Error('s3_workflow_signal_unavailable');
        await instance.sendEvent({type:'s3-receipt-'+row.step_id,payload});
      });
      return answer(200,'stored');
    }catch{
      // Persistence already succeeded. The same callback can be retried by
      // the signed job or a future bounded reconciliation pass.
      return answer(202,'stored_pending');
    }
  }catch{
    // Error details, JWT claims, database and GitHub credentials are private.
    return answer(503,'unavailable');
  }
}
