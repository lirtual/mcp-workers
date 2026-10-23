import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

function buildNoteServer(){
  const server=new McpServer({name:'workflow-controlled-note',version:'0.1.0'},{capabilities:{tools:{}}});
  server.registerTool('note',{description:'Store one bounded note for an approved workflow grant.',
    inputSchema:z.object({value:z.string().max(200)}).strict(),
    annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},
  },async({value})=>{return {content:[{type:'text',text:'stored:'+value}]};});
  return server;
}
export default {
  async fetch(request:Request):Promise<Response>{
    if(new URL(request.url).pathname!=='/mcp')return new Response('Not found',{status:404});
    return createMcpHandler(()=>buildNoteServer(),{legacy:'stateless'}).fetch(request);
  },
};
