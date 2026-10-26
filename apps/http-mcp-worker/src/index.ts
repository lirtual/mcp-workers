import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticatePortalRequest } from '@mcp-workers/portal-auth';
import { HttpError, parseCredentials, type Env } from './http.ts';
import { buildMcpServer } from './tools.ts';

function failure(status:number,error:string):Response {
 return Response.json({error},{status,headers:{
  'cache-control':'no-store',...(status===401?{'www-authenticate':'Bearer'}:{})}});
}
export default {
 async fetch(request:Request,env:Env):Promise<Response> {
  const url=new URL(request.url);
  if(url.pathname==='/health'&&request.method==='GET')
    return Response.json({ok:true,service:'http-mcp-worker',version:'1.0.0'},
      {headers:{'cache-control':'no-store'}});
  if(url.pathname!=='/mcp')return new Response('Not found',{status:404});
  const auth=await authenticatePortalRequest(request,{expectedToken:env.MCP_ACCESS_TOKEN,allowedOrigins:[]});
  if(!auth.ok)return failure(auth.reason==='misconfigured'?503:auth.reason==='invalid_origin'?403:401,
    auth.reason==='misconfigured'?'auth_misconfigured':auth.reason==='invalid_origin'?'invalid_origin':'unauthorized');
  try{parseCredentials(env.HTTP_CREDENTIALS_JSON);}
  catch(e){return failure(503,e instanceof HttpError?'credentials_misconfigured':'configuration_error');}
  const handler=createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'});
  return handler.fetch(auth.request);
 }
};
