import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { buildMcpServer } from './tools.ts';
import { WorkflowOrchestrator } from './runner.ts';
import { handleGithubCallbackRequest } from './github-ingress.ts';
import { handleGithubActionClaimRequest } from './github-action-ingress.ts';
import type { Env } from './store.ts';
export { WorkflowOrchestrator };
const error=(status:number,code:string)=>Response.json({error:code},{status,headers:{'cache-control':'no-store',...(status===401?{'www-authenticate':'Bearer'}:{})}});
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  // Only GitHub-issued OIDC may use these GitHub routes; no MCP Portal token
  // is involved. Unknown paths return 404; claim/callback requests require signed GitHub identity.
  if(url.pathname==='/github/action/claim'||url.pathname==='/github/action/ready'||
     url.pathname==='/github/action/result')
    return handleGithubActionClaimRequest(request,env);
  if(url.pathname==='/github/claim'||url.pathname==='/github/callback')
    return handleGithubCallbackRequest(request,env);
  if(url.pathname==='/health'&&request.method==='GET')return Response.json({ok:true,service:'workflow-mcp-worker',scope:'workflow'}, {headers:{'cache-control':'no-store'}});
  if(url.pathname!=='/mcp')return new Response('Not found',{status:404});
  const auth=await authenticatePortalRequest(request,{expectedToken:env.MCP_ACCESS_TOKEN,allowedOrigins:[]});
  if(!auth.ok)return error(auth.reason==='misconfigured'?503:auth.reason==='invalid_origin'?403:401,auth.reason==='misconfigured'?'auth_misconfigured':auth.reason==='invalid_origin'?'invalid_origin':'unauthorized');
  if(!env.DB||!env.WORKFLOW)return error(503,'workflow_bindings_missing');
  return createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'}).fetch(auth.request);
 }
};
