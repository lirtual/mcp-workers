import {createMcpHandler} from '@modelcontextprotocol/server';
import {authenticatePortalRequest} from '@mcp-workers/portal-auth';
import {buildMcpServer} from './tools.ts';
import {handleAdmin} from './admin.ts';
import type {Env} from './types.ts';
function error(status:number,code:string){
  return Response.json({error:code},{status,headers:{'cache-control':'no-store',
    ...(status===401?{'www-authenticate':'Bearer'}:{})}});
}
export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(env.ADMIN_HOST&&env.ADMIN_HOST===env.MCP_HOST)
      return error(503,'host_conflict');
    if(env.ADMIN_HOST&&url.hostname===env.ADMIN_HOST)
      return handleAdmin(request,env);
    // Portal Bearer MCP ingress is separate from Access owner management.
    if(!env.MCP_HOST||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(env.MCP_HOST)||
      url.protocol!=='https:'||url.hostname!==env.MCP_HOST||
      url.port||url.pathname!=='/mcp'||url.search) return error(404,'not_found');
    const auth=await authenticatePortalRequest(request,{
      expectedToken:env.MCP_ACCESS_TOKEN,allowedOrigins:[],
    });
    if(!auth.ok)return error(auth.reason==='misconfigured'?503:auth.reason==='invalid_origin'?403:401,
      auth.reason==='misconfigured'?'auth_misconfigured':auth.reason==='invalid_origin'?'invalid_origin':'unauthorized');
    if(!env.DB||!env.WEIXIN_ENCRYPTION_KEY) return error(503,'weixin_not_configured');
    return createMcpHandler(()=>buildMcpServer(env),{legacy:'stateless'}).fetch(auth.request);
  },
};
