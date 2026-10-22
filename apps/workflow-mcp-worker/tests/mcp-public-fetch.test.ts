import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { publicMcpEndpoint, scopedPublicMcpFetch, TRUSTED_PORTAL_ENDPOINT, PRODUCTION_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';

const TARGET = 'https://mcp.example.org/mcp?tenant=one';

test('owner-selected MCP Portal endpoint is the test Portal', () => {
  assert.equal(TRUSTED_PORTAL_ENDPOINT,'https://test-mcp.lirtual.dpdns.org/mcp');
});

test('production Portal identity requires an exact explicit URL and cannot be sent to test Portal or other hosts', async () => {
  assert.equal(PRODUCTION_PORTAL_ENDPOINT,'https://mcp.lirtual.dpdns.org/mcp');
  const credentials={clientId:'production-fixture-id',clientSecret:'production-fixture-secret'};
  let reached=0;
  const send=(async(request:Request):Promise<Response>=>{
    reached++;
    assert.equal(request.url,PRODUCTION_PORTAL_ENDPOINT);
    assert.equal(request.headers.get('cf-access-client-id'),credentials.clientId);
    assert.equal(request.headers.get('cf-access-client-secret'),credentials.clientSecret);
    assert.equal(request.redirect,'manual');
    return new Response(null,{status:202});
  }) as typeof fetch;
  const scoped=scopedPublicMcpFetch(PRODUCTION_PORTAL_ENDPOINT,send,credentials,PRODUCTION_PORTAL_ENDPOINT);
  assert.equal((await scoped(PRODUCTION_PORTAL_ENDPOINT,{method:'POST'})).status,202);
  assert.equal(reached,1);
  assert.throws(
    ()=>scopedPublicMcpFetch(TRUSTED_PORTAL_ENDPOINT,send,credentials,PRODUCTION_PORTAL_ENDPOINT),
    /portal_auth_wrong_target/,
  );
  assert.throws(
    ()=>scopedPublicMcpFetch(PRODUCTION_PORTAL_ENDPOINT,send,credentials,'https://other.example.org/mcp'),
    /portal_auth_wrong_target/,
  );
  assert.equal(reached,1);
});

test('candidate MCP transport rejects non-public-shaped or unsafe target URLs', () => {
  for (const target of [
    'http://mcp.example.org/mcp', 'https://localhost/mcp',
    'https://127.0.0.1/mcp', 'https://169.254.169.254/mcp',
    'https://[::1]/mcp', 'https://mcp.local/mcp', 'https://mcp.internal/mcp',
    'https://user:password@mcp.example.org/mcp', 'https://mcp.example.org:8443/mcp',
    'https://mcp.example.org/mcp#fragment', 'https://mcp.example.org./mcp',
  ]) assert.throws(() => publicMcpEndpoint(target), /mcp_target_invalid/);
  assert.equal(publicMcpEndpoint(TARGET).href, TARGET);
});

test('candidate MCP transport rejects unapproved origin, path, and query before network', async () => {
  let sent = 0;
  const boundary = scopedPublicMcpFetch(TARGET, (async () => {
    sent++;
    return new Response('ok');
  }) as typeof fetch);
  for (const target of [
    'https://other.example.org/mcp?tenant=one',
    'https://mcp.example.org/other?tenant=one',
    'https://mcp.example.org/mcp?tenant=two',
    'https://mcp.example.org/mcp',
  ]) await assert.rejects(boundary(target), /mcp_target_not_authorized/);
  assert.equal(sent, 0);
});

test('candidate MCP transport neutralizes follow redirects and never contacts a second origin', async () => {
  const seen: { url: string; redirect: string }[] = [];
  const boundary = scopedPublicMcpFetch(TARGET, (async (req: Request) => {
    seen.push({ url:req.url, redirect:req.redirect });
    return new Response(null, { status:302, headers:{ location:'https://attacker.example.org/collect' } });
  }) as typeof fetch);
  await assert.rejects(
    boundary(TARGET, { redirect:'follow', headers:{authorization:'Bearer local-test-only'} }),
    /mcp_redirect_denied/,
  );
  assert.deepEqual(seen,[{url:TARGET,redirect:'manual'}]);
});

test('actual MCP SDK initialize/list/call/get/delete stay on the approved endpoint', async () => {
  const seen: {url:string;method:string;redirect:string}[]=[];
  const fakeFetch = async (request: Request): Promise<Response> => {
    seen.push({url:request.url,method:request.method,redirect:request.redirect});
    if (request.method==='GET') return new Response(null,{status:405});
    if (request.method==='DELETE') return new Response(null,{status:202});
    const message=await request.json() as {id?:number;method:string;params?:{arguments?:{value?:string}}};
    if(message.method==='initialize') return Response.json({
      jsonrpc:'2.0',id:message.id,
      result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}},
    },{headers:{'mcp-session-id':'test-session'}});
    if(message.method==='notifications/initialized') return new Response(null,{status:202});
    if(message.method==='tools/list') return Response.json({jsonrpc:'2.0',id:message.id,result:{tools:[{name:'echo',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]}});
    if(message.method==='tools/call') return Response.json({jsonrpc:'2.0',id:message.id,result:{isError:false,content:[{type:'text',text:message.params?.arguments?.value??''}]}});
    throw new Error('unexpected_message');
  };
  const client = new Client({ name:'candidate-mcp-check',version:'0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(TARGET),{
    fetch:scopedPublicMcpFetch(TARGET,fakeFetch as typeof fetch),
    requestInit:{redirect:'follow'},
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0].name,'echo');
    const result=await client.callTool({name:'echo',arguments:{value:'hello'}});
    assert.equal(result.content[0].type,'text');
    await transport.terminateSession();
  } finally {
    await client.close();
  }
  assert.ok(seen.some(x=>x.method==='GET'));
  assert.ok(seen.some(x=>x.method==='DELETE'));
  assert.ok(seen.some(x=>x.method==='POST'));
  assert.ok(seen.every(x=>x.url===TARGET && x.redirect==='manual'));
});


test('service token only reaches the pinned Portal, never other approved MCP targets', async () => {
  const token={clientId:'test-access-id',clientSecret:'test-access-secret'};
  let sent=0;
  const fakeFetch=async(req:Request):Promise<Response>=>{
    sent++;
    assert.equal(req.url,TRUSTED_PORTAL_ENDPOINT);
    assert.equal(req.redirect,'manual');
    assert.equal(req.headers.get('cf-access-client-id'),token.clientId);
    assert.equal(req.headers.get('cf-access-client-secret'),token.clientSecret);
    return new Response(null,{status:202});
  };
  assert.throws(
    ()=>scopedPublicMcpFetch(TARGET,fakeFetch as typeof fetch,token),
    /portal_auth_wrong_target/,
  );
  assert.throws(
    ()=>scopedPublicMcpFetch(TRUSTED_PORTAL_ENDPOINT,fakeFetch as typeof fetch,{...token,clientSecret:''}),
    /portal_auth_not_configured/,
  );
  const boundary=scopedPublicMcpFetch(TRUSTED_PORTAL_ENDPOINT,fakeFetch as typeof fetch,token);
  for(const method of ['POST','GET','DELETE']){
    const response=await boundary(TRUSTED_PORTAL_ENDPOINT,{method});
    assert.equal(response.status,202);
  }
  assert.equal(sent,3);
  await assert.rejects(boundary('https://attacker.example.org/mcp'),/mcp_target_not_authorized/);
  await assert.rejects(boundary(TRUSTED_PORTAL_ENDPOINT,{
    headers:{'CF-Access-Client-Secret':'attacker-override'},
  }),/portal_auth_header_override_denied/);
  assert.equal(sent,3);
});

test('service token cannot follow a Portal redirect to any other endpoint', async () => {
  const seen:string[]=[];
  const boundary=scopedPublicMcpFetch(TRUSTED_PORTAL_ENDPOINT,(async(req:Request)=>{
    seen.push(req.url);
    assert.equal(req.redirect,'manual');
    return new Response(null,{status:307,headers:{location:'https://malicious.example.org/mcp'}});
  }) as typeof fetch,{clientId:'test-id',clientSecret:'test-secret'});
  await assert.rejects(boundary(TRUSTED_PORTAL_ENDPOINT,{redirect:'follow'}),/mcp_redirect_denied/);
  assert.deepEqual(seen,[TRUSTED_PORTAL_ENDPOINT]);
});
