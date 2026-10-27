import {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {bindingStatus,sendOnce} from './state.ts';
import type {Env, IlinkSession} from './types.ts';
import {WeixinError} from './types.ts';
// Reviewed iLink compatibility seam, isolated in the same Worker bundle.
// @ts-ignore PoC protocol is intentionally JavaScript; its runtime is tested.
import {createIlinkClient} from '../poc/protocol.mjs';
import type {Dispatcher,SendStatus} from './state.ts';
const read={readOnlyHint:true,idempotentHint:true,openWorldHint:true};
const write={readOnlyHint:false,idempotentHint:false,openWorldHint:true};
function text(value:unknown,isError=false){
  return {isError,content:[{type:'text' as const,text:JSON.stringify(value)}]};
}
async function safe(fn:()=>Promise<unknown>){
  try{return text(await fn());}
  catch(err){return text({error:err instanceof WeixinError?err.code:'upstream_unavailable'},true);}
}
async function sendToWeixin(session:IlinkSession,body:string,requestId:string):Promise<SendStatus>{
  try{
    const api=createIlinkClient();
    const reply=await api.sendText({botToken:session.botToken,recipientId:session.ownerId,
      contextToken:session.contextToken,requestId,text:body});
    return reply.status==='accepted'?'accepted':'unknown';
  }catch(err){
    return (err as {code?:string})?.code==='UPSTREAM_REJECTED'?'rejected':'unknown';
  }
}
export function buildMcpServer(env:Env,dispatch:Dispatcher=sendToWeixin):McpServer{
  const server=new McpServer({name:'weixin-mcp-worker',version:'0.1.0'},
    {capabilities:{tools:{}},instructions:
      'Send only to the single owner-verified Weixin ClawBot. User-supplied request_id must remain stable. '+
      'Never retry an unknown outcome with a new request_id automatically. accepted is upstream acknowledgement, not delivery.'});
  server.registerTool('weixin_status',{
    description:'Read sanitized current binding state and last known context/sync times. Never reads message bodies or sends a message.',
    inputSchema:z.object({}).strict(),annotations:read
  },async()=>safe(()=>bindingStatus(env)));
  server.registerTool('weixin_send_message',{
    description:'Send one bounded text to the currently owner-verified Weixin ClawBot. Explicit external write. Requires a fresh caller-generated UUID request_id. Duplicate IDs are fenced; unknown outcome must not be retried with a new ID automatically. Status accepted does NOT mean delivered.',
    inputSchema:z.object({text:z.string().min(1).max(4096),
      request_id:z.string().uuid()}).strict(),annotations:write,
  },async({text:body,request_id})=>safe(()=>sendOnce(env,body,request_id,dispatch)));
  return server;
}
