import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import worker from '../src/index.ts';
import type { Env } from '../src/http.ts';

const env:Env={MCP_ACCESS_TOKEN:'synthetic-portal-token'};
const endpoint='https://worker.example.org/mcp';
const fixture='https://api.example.org';

function rpc(headers:Record<string,string>={},body={jsonrpc:'2.0',id:1,method:'tools/list',params:{}}){
 return new Request(endpoint,{method:'POST',headers:{
  'content-type':'application/json',accept:'application/json, text/event-stream',...headers
 },body:JSON.stringify(body)});
}
async function clientFor(settings:Env,outbound:typeof fetch) {
 const original=globalThis.fetch;globalThis.fetch=outbound;
 const transport=new StreamableHTTPClientTransport(new URL(endpoint),{
  fetch:async (input,init)=>{
   const req=input instanceof Request?input:new Request(input,init);
   const headers=new Headers(req.headers);headers.set('authorization','Bearer synthetic-portal-token');
   return worker.fetch(new Request(req,{headers}),settings);
  },
 });
 const client=new Client({name:'http-mcp-acceptance',version:'1.0.0'});
 try{await client.connect(transport);}
 catch(e){globalThis.fetch=original;throw e;}
 return {client,close:async()=>{await client.close();globalThis.fetch=original;}};
}
const mock=(fn:(url:URL,init:RequestInit)=>Response|Promise<Response>):typeof fetch =>
 (async (input,init)=>fn(new URL(String(input)),init??{})) as typeof fetch;
async function call(args:Record<string,unknown>,respond:typeof fetch,settings:Env=env) {
 const session=await clientFor(settings,respond);
 try{return await session.client.callTool({name:'http_request',arguments:args});}
 finally{await session.close();}
}
function data(value:any):any {return value.structuredContent;}

test('health is public, ingress denies anonymous, forged Origin and broken configuration',async()=>{
 assert.equal((await worker.fetch(new Request('https://worker.example.org/health'),env)).status,200);
 assert.equal((await worker.fetch(new Request('https://worker.example.org/unknown'),env)).status,404);
 assert.equal((await worker.fetch(rpc(),env)).status,401);
 assert.equal((await worker.fetch(rpc({authorization:'Bearer nope'}),env)).status,401);
 assert.equal((await worker.fetch(rpc({authorization:'Bearer synthetic-portal-token',origin:'https://evil.example.org'}),env)).status,403);
 assert.equal((await worker.fetch(rpc({authorization:'Bearer synthetic-portal-token'}),{})).status,503);
 assert.equal((await worker.fetch(rpc({authorization:'Bearer synthetic-portal-token'}),{
  ...env,HTTP_CREDENTIALS_JSON:'{invalid'
 })).status,503);
});
test('actual worker entrypoint lists exactly one tool with non-read-only annotations',async()=>{
 const session=await clientFor(env,mock(()=>Response.json({ok:true})));
 try{
  const {tools}=await session.client.listTools();
  assert.deepEqual(tools.map(t=>t.name),['http_request']);
  assert.equal(tools[0]?.annotations?.readOnlyHint,false);
 }finally{await session.close();}
});
test('GET HTTP 401 remains a result, ingress bearer never forwarded and query hidden',async()=>{
 const result=await call({url:fixture+'/v1?token=sensitive'},mock((u,opts)=>{
  assert.equal(u.search,'?token=sensitive');
  assert.equal(new Headers(opts.headers).get('authorization'),null);
  return new Response('denied',{status:401,headers:{'content-type':'text/plain'}});
 }));
 assert.equal(result.isError,undefined);
 assert.equal(data(result).status,401);
 assert.equal(data(result).body,'denied');
 assert.equal(data(result).final_url,fixture+'/v1');
});
test('seven methods; JSON null, form and text; forbidden bodies and headers',async()=>{
 for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']){
  const result=await call({url:fixture,method},mock((_u,init)=>{
   assert.equal(init.method,method);
   return new Response(null,{status:204});
  }));
  assert.equal(data(result).status,204,method);
 }
 const bodies=[
  [{json:null},'null','application/json'],
  [{form:{a:'a b'}},'a=a+b','application/x-www-form-urlencoded'],
  [{text:'hello'},'hello','text/plain'],
 ] as const;
 for(const [extra,expected,mime] of bodies){
  const result=await call({url:fixture,method:'POST',...extra},mock((_u,init)=>{
   assert.equal(init.body,expected);assert.match(new Headers(init.headers).get('content-type')??'',new RegExp(mime));
   return Response.json({ok:true});
  }));
  assert.equal(data(result).encoding,'json');
  assert.deepEqual(data(result).json,{ok:true});
 }
 for(const extra of [{json:0,text:'bad'},{headers:{Host:'private'}},
   {url:'http://127.0.0.1'}, {url:'http://localhost'}, {url:'https://a.local'},
   {url:'https://user:password@api.example.org'}, {headers:{Connection:'close'}}]){
  const result=await call({url:fixture,method:'GET',...extra},mock(()=>{throw Error('must not fetch');}));
  assert.equal(result.isError,true);
 }
});
test('manual redirects, cross-origin stop, same-origin follow, loops, and no body replay',async()=>{
 let count=0;
 const direct=await call({url:fixture+'/old'},mock(()=>new Response(null,{
  status:302,headers:{location:'/new?access_token=sensitive'}
 })));
 assert.equal(data(direct).status,302);
 assert.equal(data(direct).headers.location,fixture+'/new');
 const followed=await call({url:fixture+'/old',redirect:'same-origin'},mock((u)=>{
  count++;
  return u.pathname==='/old'?new Response(null,{status:302,headers:{location:'/new'}}):
   Response.json({ok:true});
 }));
 assert.equal(data(followed).redirect_count,1);assert.equal(count,2);
 const cross=await call({url:fixture+'/old',redirect:'same-origin'},mock(()=>new Response(null,{
  status:302,headers:{location:'https://another.example.org/path'}
 })));
 assert.equal(data(cross).status,302);assert.equal(data(cross).redirect_count,0);
 const loop=await call({url:fixture+'/loop',redirect:'same-origin'},mock(()=>new Response(null,{
  status:302,headers:{location:'/loop'}
 })));
 assert.match(JSON.stringify(loop),/redirect_loop/);
 const write=await call({url:fixture+'/old',method:'POST',text:'write',redirect:'same-origin'},
  mock(()=>new Response(null,{status:307,headers:{location:'/new'}})));
 assert.equal(data(write).status,307);
});
test('managed HTTPS origin/path scope, conflicts, HTTP auth and redaction',async()=>{
 const secret='synthetic-secret-never-log';
 const settings:Env={...env,HTTP_CREDENTIALS_JSON:JSON.stringify([
  {origin:fixture,pathPrefix:'/v1',headers:{'X-API-Key':secret}}
 ])};
 const seen:string[]=[];
 const found=await call({url:fixture+'/v1/first',redirect:'same-origin'},mock((u,init)=>{
  seen.push(new Headers(init.headers).get('x-api-key')??'');
  if(u.pathname==='/v1/first')return new Response(null,{status:302,headers:{location:'/public'}});
  return new Response('secret '+secret,{headers:{'content-type':'text/plain','set-cookie':secret}});
 }),settings);
 assert.deepEqual(seen,[secret,'']);
 assert.doesNotMatch(JSON.stringify(found),new RegExp(secret));
 assert.equal(data(found).headers['set-cookie'],'[REDACTED]');
 const conflict=await call({url:fixture+'/v1',headers:{'x-api-key':'caller'}},
   mock(()=>{throw Error('must not fetch');}),settings);
 assert.match(JSON.stringify(conflict),/credential_conflict/);
 const clear=await call({url:'http://api.example.org',headers:{authorization:'Bearer token'}},
   mock(()=>{throw Error('must not fetch');}));
 assert.match(JSON.stringify(clear),/insecure_credentials/);
 const empty=await call({url:fixture},mock(()=>Response.json({ok:true})),
   {...env,HTTP_CREDENTIALS_JSON:'[]'});
 assert.equal(data(empty).ok,true);
});
test('bounded text/binary response, no retry and write timeout is indeterminate',async()=>{
 const oversized=await call({url:fixture,max_response_bytes:3},mock(()=>new Response('hello',{
  headers:{'content-type':'text/plain'}
 })));
 assert.equal(data(oversized).body,'hel');
 assert.equal(data(oversized).truncated,true);
 const binary=await call({url:fixture},mock(()=>new Response(new Uint8Array([0,1,255]),{
  headers:{'content-type':'application/octet-stream'}
 })));
 assert.equal(data(binary).body,'AAH/');
 let calls=0;
 const lost=await call({url:fixture,method:'POST',text:'hello'},mock(()=>{calls++;throw Error('offline');}));
 assert.match(JSON.stringify(lost),/indeterminate/);assert.equal(calls,1);
});

test('credential reflections in URL path and response headers are filtered and public port rules apply',async()=>{
 const key='synthetic-private-path';
 const settings:Env={...env,HTTP_CREDENTIALS_JSON:JSON.stringify([{
   origin:fixture,pathPrefix:'/',headers:{'X-API-Key':key},
 }])};
 const result=await call({url:fixture+'/'+key},mock(()=>new Response('ok',{
   status:302,headers:{location:'/another/'+key+'?secret=hidden','content-type':'text/plain',
     'x-debug-credential':key},
 })),settings);
 assert.doesNotMatch(JSON.stringify(result),new RegExp(key));
 assert.equal(data(result).headers.location,fixture+'/another/[REDACTED]');
 assert.equal(data(result).final_url,fixture+'/[REDACTED]');
 const invalid=await call({url:'https://api.example.org:0/'},
   mock(()=>{throw Error('fetch must not happen');}));
 assert.match(JSON.stringify(invalid),/unsafe_target/);
 const customPort=await call({url:'https://api.example.org:8443/'},
   mock((u)=>{assert.equal(u.port,'8443');return Response.json({ok:true});}));
 assert.equal(data(customPort).status,200);
});

test('credential scope forbids ambiguous encoded path and redirect to another HTTPS port',async()=>{
 const fake='synthetic-key';
 const settings:Env={...env,HTTP_CREDENTIALS_JSON:JSON.stringify([
   {origin:fixture,pathPrefix:'/v1',headers:{Authorization:fake}},
 ])};
 const blocked=await call({url:fixture+'/v1/%252e%252e/admin'},mock(()=>{
   throw Error('No fetch permitted for double-encoded path');
 }),settings);
 assert.match(JSON.stringify(blocked),/unsafe_credential_path/);
 const uncredentialed=await call({url:fixture+'/v1/%252e%252e/admin'},
   mock(()=>Response.json({ok:true})));
 assert.equal(data(uncredentialed).status,200);
 let seen=0;
 const crossPort=await call({url:fixture+'/v1/start',redirect:'same-origin'},
   mock((u,init)=>{
     seen++;
     assert.equal(new Headers(init.headers).get('authorization'),fake);
     return new Response(null,{status:302,headers:{
       location:'https://api.example.org:8443/v1/finish',
     }});
   }),settings);
 assert.equal(data(crossPort).redirect_count,0);
 assert.equal(seen,1);
});
test('writes never retry on a signal timeout; errors and responses disclose no headers or bodies to logs',async()=>{
 let attempts=0;
 const secret='synthetic-private-bearer';
 const logs:string[]=[];
 const old=console.log;
 console.log=(...items)=>logs.push(items.join(' '));
 try {
   const result=await call({url:fixture,method:'PATCH',headers:{authorization:secret},text:'request-private-body'},
     mock(async (_url,init)=>{
       attempts++;
       await new Promise<void>(resolve=>{
         if(init.signal?.aborted)resolve();
         else init.signal?.addEventListener('abort',()=>resolve(),{once:true});
       });
       throw Error('transport interrupted');
     }));
   assert.match(JSON.stringify(result),/indeterminate/);
   assert.equal(attempts,1);
   assert.doesNotMatch(logs.join(' '),/synthetic-private-bearer|request-private-body/);
 } finally {console.log=old;}
});
test('reject oversized upload and expose HTTP 500 as a normal result',async()=>{
 const tooLarge=await call({url:fixture,method:'POST',text:'x'.repeat(1048577)},
   mock(()=>{throw Error('Should not transmit oversized body');}));
 assert.match(JSON.stringify(tooLarge),/request_too_large/);
 const upstream=await call({url:fixture},mock(()=>new Response('maintenance',{
   status:500,headers:{'content-type':'text/plain','www-authenticate':'private'},
 })));
 assert.equal(data(upstream).status,500);
 assert.equal(upstream.isError,undefined);
 assert.equal(data(upstream).headers['www-authenticate'],'[REDACTED]');
});
