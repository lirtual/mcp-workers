import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMcpServer} from '../src/tools.ts';
import worker from '../src/index.ts';

const host='weixin-mcp.example.org';
const target='https://'+host+'/mcp';
const env={
  MCP_HOST:host, MCP_ACCESS_TOKEN:'test-portal-token',
  WEIXIN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),
  DB:{prepare:()=>({first:async()=>null})},
} as any;
function rpc(method:string,params:unknown=undefined,extraHeaders:Record<string,string>={}){
  return new Request(target,{method:'POST',
    headers:{authorization:'Bearer test-portal-token',accept:'application/json, text/event-stream',
      'content-type':'application/json',...extraHeaders},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params===undefined?{}:{params})}),
  });
}
async function result(request:Request){
  const response=await worker.fetch(request,env);
  assert.equal(response.status,200);
  const content=await response.text();
  const data=content.match(/^data: (.+)$/m)?.[1];
  assert.ok(data,'valid MCP event stream');
  return JSON.parse(data);
}
test('exactly two public tools, sender cannot choose recipients or arbitrary URLs',()=>{
  const registry=(buildMcpServer(env) as any)._registeredTools;
  assert.deepEqual(Object.keys(registry),['weixin_status','weixin_send_message']);
  const send=registry.weixin_send_message;
  assert.equal(send.annotations.readOnlyHint,false);
  assert.equal(send.annotations.idempotentHint,false);
  assert.deepEqual(Object.keys(send.inputSchema.shape),['text','request_id']);
  assert.equal(send.inputSchema.safeParse({text:'hello',request_id:'abc'}).success,false);
  assert.equal(send.inputSchema.safeParse({text:'hello',request_id:'4d28a1a9-b5c0-4b1f-82dc-f14c89409ba0',to_user_id:'attacker'}).success,false);
  assert.equal(registry.weixin_status.annotations.readOnlyHint,true);
});
test('host, path, origin and bearer validation occur before touching storage',async()=>{
  for(const url of ['https://unreviewed.example/mcp','http://'+host+'/mcp',
    'https://'+host+'/setup','https://'+host+'/mcp?x=1']){
    assert.equal((await worker.fetch(new Request(url),env)).status,404,url);
  }
  assert.equal((await worker.fetch(new Request(target),env)).status,401);
  const noToken={...env,MCP_ACCESS_TOKEN:''};
  assert.equal((await worker.fetch(new Request(target),noToken)).status,503);
  assert.equal((await worker.fetch(rpc('tools/list',{}, {origin:'https://malicious.example'}),env)).status,403);
  assert.equal((await worker.fetch(rpc('tools/list'),{...env,DB:undefined})).status,503);
});
test('authenticated MCP tools/list exposes exact schema; status read has no secrets',async()=>{
  const tools=(await result(rpc('tools/list'))).result.tools;
  assert.deepEqual(tools.map((x:any)=>x.name),['weixin_status','weixin_send_message']);
  assert.deepEqual(tools.find((x:any)=>x.name==='weixin_send_message').inputSchema.required.sort(),
    ['request_id','text']);
  assert.deepEqual(Object.keys(tools.find((x:any)=>x.name==='weixin_send_message').inputSchema.properties).sort(),
    ['request_id','text']);
  const response=(await result(rpc('tools/call',{name:'weixin_status',arguments:{}}))).result;
  const out=JSON.parse(response.content[0].text);
  assert.equal(out.binding_state,'unbound');
  assert.equal(out.last_verified_context_at,null);
  assert(!JSON.stringify(out).includes('test-portal-token'));
});
test('unbound send fails closed with no iLink call or destination override',async()=>{
  const response=(await result(rpc('tools/call',{name:'weixin_send_message',arguments:{
    text:'hello',request_id:'4d28a1a9-b5c0-4b1f-82dc-f14c89409ba0'}}))).result;
  assert.equal(response.isError,true);
  assert.equal(JSON.parse(response.content[0].text).error,'binding_not_ready');
});
