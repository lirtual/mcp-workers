import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
function buildReadonlyServer(){
 const server=new McpServer({name:'s1-readonly-fixture',version:'0.1.0'},{capabilities:{tools:{}}});
 server.registerTool('echo',{description:'Repeat a bounded value without changing external state.',
   inputSchema:z.object({value:z.string().max(4096),delay_ms:z.number().int().min(0).max(15000).optional()}).strict(),
   annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}
 },async({value,delay_ms})=>{if(delay_ms)await new Promise(resolve=>setTimeout(resolve,delay_ms));return {content:[{type:'text',text:value}]};});
 return server;
}
export default {
 async fetch(request:Request):Promise<Response>{
  if(new URL(request.url).pathname!=='/mcp')return new Response('Not found',{status:404});
  return createMcpHandler(()=>buildReadonlyServer(),{legacy:'stateless'}).fetch(request);
 }
};
