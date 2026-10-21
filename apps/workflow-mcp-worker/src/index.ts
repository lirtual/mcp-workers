import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { buildMcpServer } from './tools.ts';
import { WorkflowRunner } from './runner.ts';
import { handleGithubCallbackRequest } from './s3-github-ingress.ts';
import type { Env } from './store.ts';
export { WorkflowRunner };
const error=(status:number,code:string)=>Response.json({error:code},{status,headers:{'cache-control':'no-store',...(status===401?{'www-authenticate':'Bearer'}:{})}});
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  // Only GitHub-issued OIDC may use these two S3 routes; no MCP Portal token
  // is involved. Disabled S3 returns 404 before parsing credentials.
  if(url.pathname==='/s3/claim'||url.pathname==='/s3/callback')
    return handleGithubCallbackRequest(request,env);
  if(url.pathname==='/health'&&request.method==='GET')return Response.json({ok:true,service:'workflow-mcp-worker',scope:'s1'}, {headers:{'cache-control':'no-store'}});
  if(url.pathname!=='/mcp')return new Response('Not found',{status:404});
  const auth=await authenticatePortalRequest(request,{expectedToken:env.MCP_ACCESS_TOKEN,allowedOrigins:[]});
  if(!auth.ok)return error(auth.reason==='misconfigured'?503:auth.reason==='invalid_origin'?403:401,auth.reason==='misconfigured'?'auth_misconfigured':auth.reason==='invalid_origin'?'invalid_origin':'unauthorized');
  if(!env.DB||!env.WORKFLOW||!env.READONLY_TARGET)return error(503,'s1_bindings_missing');
  return createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'}).fetch(auth.request);
 }
};
