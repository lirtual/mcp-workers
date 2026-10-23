import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

function buildNoteServer(){
  const server=new McpServer({name:'workflow-controlled-note',version:'0.1.0'},{capabilities:{tools:{}}});
  server.registerTool('note',{description:'Store one bounded note for an approved workflow grant.',
    inputSchema:z.object({value:z.string().max(200)}).strict(),
    annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:false,openWorldHint:false},
  },async({value})=>{
    if(value==='lose') throw new Error('note_dispatch_lost');
    return {content:[{type:'text',text:'stored:'+value}]};
  });
  server.registerTool('note_clear',{description:'Clear one bounded note when a published compensation grant names this tool.',
    inputSchema:z.object({value:z.string().max(200)}).strict(),
    annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:true,openWorldHint:false},
  },async({value})=>{
    if(value==='fail-clear') throw new Error('clear_lost');
    return {content:[{type:'text',text:'cleared:'+value}]};
  });
  return server;
}
export default {
  async fetch(request:Request):Promise<Response>{
    if(new URL(request.url).pathname!=='/mcp')return new Response('Not found',{status:404});
    return createMcpHandler(()=>buildNoteServer(),{legacy:'stateless'}).fetch(request);
  },
};
