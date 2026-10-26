import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { buildMcpServer } from './tools.ts';
import { WorkflowOrchestrator } from './runner.ts';
import {admitScheduledCron} from './scheduled.ts';
import {handleWorkflowWebhook} from './webhook.ts';
import {handleWaitEvent} from './wait-event-ingress.ts';
import {handleGithubEvent} from './github-event.ts';
import { handleGithubActionClaimRequest } from './github-action-ingress.ts';
import { handleSignedSessionDataReport } from './session-runtime-data.ts';
import type { Env } from './store.ts';
export { WorkflowOrchestrator };
const error=(status:number,code:string)=>Response.json({error:code},{status,headers:{'cache-control':'no-store',...(status===401?{'www-authenticate':'Bearer'}:{})}});
export default {
 async scheduled(controller:ScheduledController,env:Env):Promise<void>{
  if(!env.DB||!env.WORKFLOW)throw Error('workflow_bindings_missing');
  const result=await admitScheduledCron(env,controller.scheduledTime);
  if(result.capacity_skipped||result.failed)
    console.warn('workflow_cron_tick',JSON.stringify(result));
 },
 async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname.startsWith('/triggers/webhook/'))return handleWorkflowWebhook(request,env);
  if(url.pathname.startsWith('/events/'))return handleWaitEvent(request,env);
  if(url.pathname.startsWith('/triggers/github/'))return handleGithubEvent(request,env);
  if(url.pathname==='/github/action/session-data')
    return handleSignedSessionDataReport(request,env);
  // Only approved GitHub Actions use the signed Action claim/result routes.
  // Retired fixed-executor callbacks fall through to 404.
  if(url.pathname==='/github/action/claim'||url.pathname==='/github/action/ready'||
     url.pathname==='/github/action/result')
    return handleGithubActionClaimRequest(request,env);
  if(url.pathname==='/health'&&request.method==='GET')return Response.json({ok:true,service:'workflow-mcp-worker',scope:'workflow'}, {headers:{'cache-control':'no-store'}});
  if(url.pathname!=='/mcp')return new Response('Not found',{status:404});
  const auth=await authenticatePortalRequest(request,{expectedToken:env.MCP_ACCESS_TOKEN,allowedOrigins:[]});
  if(!auth.ok)return error(auth.reason==='misconfigured'?503:auth.reason==='invalid_origin'?403:401,auth.reason==='misconfigured'?'auth_misconfigured':auth.reason==='invalid_origin'?'invalid_origin':'unauthorized');
  if(!env.DB||!env.WORKFLOW)return error(503,'workflow_bindings_missing');
  return createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'}).fetch(auth.request);
 }
};
