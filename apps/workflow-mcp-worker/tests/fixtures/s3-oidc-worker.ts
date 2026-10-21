/**
 * DISPOSABLE GitHub OIDC -> D1 evidence Worker, NEVER production ingress.
 * Accepts only Bearer tokens verified by the S3 module and exact D1 candidate.
 * No registration, untrusted grants, generic SQL, or result read endpoints.
 */
import {
  verifyAndClaimGithubAttempt, type ExecutorIdentity,
} from '../../src/s3-github-claim.ts';
import { recordGithubCallback } from '../../src/s3-github-callback.ts';

type E={DB:D1Database; EXPECTED_REPO:string; EXPECTED_REPOSITORY_ID:string;
  EXPECTED_WORKFLOW_REF:string; EXPECTED_REF:string; EXPECTED_AUDIENCE:string};
const response=(code:number,message:string)=>Response.json({result:message},{status:code,headers:{'cache-control':'no-store'}});
export default {
  async fetch(request:Request,env:E):Promise<Response>{
    const url=new URL(request.url);
    if(request.method!=='POST'||!['/claim','/callback'].includes(url.pathname))
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
      if(typeof record.attemptId!=='string'||typeof record.callbackId!=='string'||
        (record.outcome!=='succeeded'&&record.outcome!=='failed')||
        Object.keys(record).sort().join(',')!=='attemptId,callbackId,outcome,result')
        return response(400,'invalid_payload');
      const ok=await recordGithubCallback(env.DB,{
        attemptId:record.attemptId,callbackId:record.callbackId,
        outcome:record.outcome,result:record.result,
      },token,pinned);
      return ok?response(200,'stored'):response(403,'callback_denied');
    }catch{
      // No token, signed claims, SQL, secrets or internal exception leaked.
      return response(503,'unavailable');
    }
  },
};
