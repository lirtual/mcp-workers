import { createMcpHandler } from '@modelcontextprotocol/server';
import { WorkerEntrypoint } from 'cloudflare:workers';
import {decideSessionAdmission,type SessionAdmission} from './session-device-authority.ts';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { buildMcpServer } from './tools.ts';
import { WorkflowOrchestrator } from './runner.ts';
import {admitScheduledCron} from './scheduled.ts';
import {collectNativeTerminalProofs} from './instance-observation.ts';
import {expireDropClaimReceipts} from './drop-claim-receipt.ts';
import {handleWorkflowWebhook} from './webhook.ts';
import {handleWaitEvent} from './wait-event-ingress.ts';
import {handleGithubEvent} from './github-event.ts';
import { handleGithubActionClaimRequest } from './github-action-ingress.ts';
import {handleGithubActionPublicConfig} from './github-action-public-config.ts';
import type { Env } from './store.ts';
export { WorkflowOrchestrator };
const error=(status:number,code:string)=>Response.json({error:code},{status,headers:{'cache-control':'no-store',...(status===401?{'www-authenticate':'Bearer'}:{})}});
export default {
 async scheduled(controller:ScheduledController,env:Env):Promise<void>{
  if(!env.DB||!env.WORKFLOW)throw Error('workflow_bindings_missing');
  // Reuse the existing minute tick; no extra scheduler or sensitive logging.
  try{await expireDropClaimReceipts(env.DB);}
  catch{console.warn('drop_claim_cleanup_unavailable');}
  const result=await admitScheduledCron(env,controller.scheduledTime);
  if(result.capacity_skipped||result.failed)
    console.warn('workflow_cron_tick',JSON.stringify(result));
  // Admission is authoritative and runs first. A failed evidence read or
  // persistence must never suppress the normal minute-tick behavior.
  try{
    const proof=await collectNativeTerminalProofs(env,controller.scheduledTime);
    if(proof.unavailable||proof.conflicts)
      console.warn('workflow_terminal_proof_tick',JSON.stringify(proof));
  }catch{console.warn('workflow_terminal_proof_collection_unavailable');}
 },
 async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname.startsWith('/triggers/webhook/'))return handleWorkflowWebhook(request,env);
  if(url.pathname.startsWith('/events/'))return handleWaitEvent(request,env);
  if(url.pathname.startsWith('/triggers/github/'))return handleGithubEvent(request,env);
  // Non-secret audience is discovered at this fixed origin before GitHub requests OIDC.
  if(url.pathname==='/github/action/config')return handleGithubActionPublicConfig(request,env);
  // Only approved GitHub Actions use the signed Action claim/result routes.
  // Retired fixed-executor callbacks fall through to 404.
  if(url.pathname==='/github/action/claim'||url.pathname==='/github/action/ready'||
     url.pathname==='/github/action/result')
    return handleGithubActionClaimRequest(request,env);
  if(url.pathname==='/health'&&request.method==='GET')return Response.json({ok:true,service:'workflow-mcp-worker',scope:'workflow',execution_terminal_proof_schema:23}, {headers:{'cache-control':'no-store'}});
  if(url.pathname!=='/mcp')return new Response('Not found',{status:404});
  const auth=await authenticatePortalRequest(request,{expectedToken:env.MCP_ACCESS_TOKEN,allowedOrigins:[]});
  if(!auth.ok)return error(auth.reason==='misconfigured'?503:auth.reason==='invalid_origin'?403:401,auth.reason==='misconfigured'?'auth_misconfigured':auth.reason==='invalid_origin'?'invalid_origin':'unauthorized');
  if(!env.DB||!env.WORKFLOW)return error(503,'workflow_bindings_missing');
  return createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'}).fetch(auth.request);
 }
};

/** Private named RPC only; not a public fetch route or extra MCP tool. */
export class SessionAuthorization extends WorkerEntrypoint<Env> {
 async authorizeSessionAttempt(input:{attempt_id:unknown;oidc_jwt?:unknown}):Promise<SessionAdmission>{
  return decideSessionAdmission(this.env,input);
 }
}
