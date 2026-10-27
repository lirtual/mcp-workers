import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import worker from '../src/index.ts';
import type { Env } from '../src/openlist.ts';

const endpoint = 'https://mcp.example.test/mcp';
function settings(fetcher: (request: Request) => Promise<Response>): Env {
  return { MCP_ACCESS_TOKEN: 'portal-fixture', OPENLIST_API_TOKEN: 'upstream-fixture',
    OPENLIST_ALLOWED_ROOTS: '["/Koofr/safe"]', OPENLIST: { fetch: fetcher } };
}
const rpc = (token?: string, origin?: string) => new Request(endpoint, {
  method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(origin ? { origin } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
async function clientFor(env: Env) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set('authorization', 'Bearer portal-fixture');
      return worker.fetch(new Request(request, { headers }), env);
    },
  });
  const client = new Client({ name: 'openlist-acceptance', version: '0.1.0' });
  await client.connect(transport);
  return client;
}
test('public health, 401 auth, Origin denial, and bad upstream configuration', async () => {
  let calls = 0;
  const env = settings(async () => { calls++; return Response.json({ code: 200, data: null }); });
  assert.equal((await worker.fetch(new Request('https://mcp.example.test/health'), env)).status, 200);
  assert.equal((await worker.fetch(rpc(), env)).status, 401);
  assert.equal((await worker.fetch(rpc('wrong'), env)).status, 401);
  assert.equal((await worker.fetch(rpc('portal-fixture', 'https://evil.test'), env)).status, 403);
  assert.equal((await worker.fetch(rpc('portal-fixture'), { ...env, OPENLIST: undefined })).status, 503);
  assert.equal(calls, 0);
});
test('actual tools/list publishes only safe accepted surface, with correct annotations', async () => {
  const env = settings(async () => Response.json({ code: 200, data: {} }));
  const client = await clientFor(env);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), [
      'openlist_capabilities','openlist_list_files','openlist_get_file',
      'openlist_search_files','openlist_read_text','openlist_share_get',
      'openlist_download_link','openlist_share_disable',
      'openlist_upload_small','openlist_rename','openlist_copy',
      'openlist_move','openlist_create_folder',
    ]);
    assert.equal(tools.find(t => t.name === 'openlist_create_folder')?.annotations?.readOnlyHint, false);
    assert.equal(tools.find(t => t.name === 'openlist_get_file')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'openlist_share_get')?.annotations?.readOnlyHint, true);
    const capabilities = await client.callTool({ name: 'openlist_capabilities', arguments: {} });
    assert.match(JSON.stringify(capabilities), /disabled_pending_acceptance/);
    const inventory = JSON.parse((capabilities.content[0] as {text:string}).text).observed_state;
    assert.deepEqual(inventory.active_tools, tools.map(t => t.name));
    assert.equal(inventory.disabled_pending_acceptance.includes('openlist_share_get'), false);
    assert.equal(inventory.disabled_pending_acceptance.includes('openlist_share_create'), true);
    assert.equal(inventory.disabled_pending_acceptance.includes('openlist_share_disable'), false);
    assert.equal(inventory.disabled_pending_acceptance.includes('openlist_download_link'), false);
    for(const name of ['openlist_upload_small','openlist_rename','openlist_copy','openlist_move'])
      assert.equal(inventory.disabled_pending_acceptance.includes(name), false);
    assert.equal(tools.find(t => t.name === 'openlist_share_disable')?.annotations?.destructiveHint, true);
    assert.equal(inventory.disabled_pending_acceptance.length, 5);
    assert.doesNotMatch(JSON.stringify(capabilities), /upstream-fixture|portal-fixture/);
  } finally { await client.close(); }
});
test('retired share creation is unavailable through MCP', async () => {
  let calls = 0;
  const client = await clientFor(settings(async () => {
    calls++;
    return Response.json({code:200,data:null});
  }));
  try {
    await assert.rejects(() => client.callTool({
      name:'openlist_share_create', arguments:{},
    }), /not found/);
    assert.equal(calls, 0);
  } finally { await client.close(); }
});

test('share_get accepts an explicit ID, reads only that record, and strips secrets', async () => {
  const requests: string[] = [];
  const client = await clientFor(settings(async req => {
    const route = new URL(req.url);
    requests.push(route.pathname);
    assert.equal(req.method, 'GET');
    assert.equal(route.origin, 'https://openlist.internal');
    assert.equal(route.pathname, '/api/share/get');
    assert.equal(route.searchParams.get('id'), 'share_Ab-09');
    assert.equal(req.headers.get('authorization'), 'upstream-fixture');
    return Response.json({ code: 200, data: {
      id: 'share_Ab-09', files: ['/Koofr/safe/readme.md'],
      disabled: false, expires: '2026-12-31T00:00:00Z', max_accessed: 4,
      pwd: 'private-password', creator: 'private-creator',
      raw_url: 'https://private.example/signature', remark: 'private-remark',
    } });
  }));
  try {
    const response = await client.callTool({
      name: 'openlist_share_get', arguments: { id: 'share_Ab-09' },
    });
    assert.notEqual(response.isError, true);
    const data = JSON.parse((response.content[0] as {text:string}).text);
    assert.equal(data.operation, 'openlist_share_get');
    assert.equal(data.status, 'succeeded');
    assert.equal(data.target, 'share_Ab-09');
    assert.deepEqual(data.observed_state, {
      id: 'share_Ab-09', files: ['/Koofr/safe/readme.md'],
      disabled: false, expires: '2026-12-31T00:00:00Z', max_accessed: 4,
    });
    assert.deepEqual(requests, ['/api/share/get']);
    assert.doesNotMatch(JSON.stringify(response),
      /private-password|private-creator|private-remark|private\.example|upstream-fixture|portal-fixture/);
  } finally { await client.close(); }
});

test('share_get refuses out-of-scope share records without exposing their contents', async () => {
  let calls = 0;
  const client = await clientFor(settings(async req => {
    calls++;
    assert.equal(new URL(req.url).pathname, '/api/share/get');
    return Response.json({ code: 200, data: {
      id: 'outside-share', files: ['/Koofr/other/private.txt'],
      disabled: false, pwd: 'secret-share-password',
    } });
  }));
  try {
    const response = await client.callTool({
      name: 'openlist_share_get', arguments: { id: 'outside-share' },
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response), /OUT_OF_SCOPE/);
    assert.doesNotMatch(JSON.stringify(response), /private\.txt|secret-share-password/);
    assert.equal(calls, 1);
  } finally { await client.close(); }
});

test('tool call on a forbidden path is denied with no upstream fetch', async () => {
  let calls = 0;
  const client = await clientFor(settings(async () => { calls++; return Response.json({ code: 200, data: {} }); }));
  try {
    const value = await client.callTool({
      name: 'openlist_get_file', arguments: { path: '/Koofr/other/private.txt' },
    });
    assert.equal(value.isError, true);
    assert.match(JSON.stringify(value), /OUT_OF_SCOPE/);
    assert.equal(calls, 0);
  } finally { await client.close(); }
});
test('text read refuses unsigned redirect or non-text download', async () => {
  let calls = 0;
  const client = await clientFor(settings(async req => {
    calls++;
    if (new URL(req.url).pathname === '/api/fs/get') {
      assert.equal(req.headers.get('authorization'), 'upstream-fixture');
      return Response.json({ code: 200, data: { name: 'readme.txt', size: 10, is_dir: false, sign: 'synthetic-signature' } });
    }
    assert.equal(req.headers.get('authorization'), null);
    assert.equal(new URL(req.url).searchParams.get('sign'), 'synthetic-signature');
    assert.equal(req.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://unsafe.example/private' } });
  }));
  try {
    const result = await client.callTool({ name: 'openlist_read_text', arguments: { path: '/Koofr/safe/readme.txt' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /NOT_SUPPORTED/);
    assert.equal(calls, 2);
  } finally { await client.close(); }
});

test('scoped share disable uses one existing OpenList write and verifies it by exact ID', async () => {
  let disabled = false;
  const routes: string[] = [];
  const client = await clientFor(settings(async request => {
    const url = new URL(request.url);
    routes.push(request.method + ' ' + url.pathname);
    assert.equal(url.origin, 'https://openlist.internal');
    assert.equal(url.searchParams.get('id'), 'share_1');
    assert.equal(request.headers.get('authorization'), 'upstream-fixture');
    if (request.method === 'GET' && url.pathname === '/api/share/get')
      return Response.json({code:200,data:{id:'share_1',files:['/Koofr/safe/f.txt'],
        disabled,pwd:'supersecret',creator:'private-creator'}});
    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/share/disable');
    disabled = true;
    return Response.json({code:200,data:null});
  }));
  try {
    const response = await client.callTool({name:'openlist_share_disable',arguments:{id:'share_1'}});
    assert.notEqual(response.isError, true);
    const body=JSON.parse((response.content[0] as {text:string}).text);
    assert.equal(body.status,'succeeded');
    assert.equal(body.observed_state.disabled,true);
    assert.deepEqual(routes,['GET /api/share/get','POST /api/share/disable','GET /api/share/get']);
    assert.doesNotMatch(JSON.stringify(response),/supersecret|private-creator|upstream-fixture/);
    const again=await client.callTool({name:'openlist_share_disable',arguments:{id:'share_1'}});
    assert.notEqual(again.isError,true);
    assert.equal(JSON.parse((again.content[0] as {text:string}).text).code,'ALREADY_DISABLED');
    assert.equal(routes.length,4);
  } finally {await client.close();}
});

test('share disable refuses out-of-scope share without dispatch and returns unknown after lost write response', async () => {
  let writes=0;
  const client=await clientFor(settings(async req => {
    const url=new URL(req.url);
    if(req.method==='POST') {writes++;throw new Error('timeout after dispatch');}
    return Response.json({code:200,data:{id:url.searchParams.get('id'),
      files:[url.searchParams.get('id')==='outside'?'/Koofr/other/f.txt':'/Koofr/safe/f.txt'],
      disabled:false,pwd:'private-value'}});
  }));
  try {
    const denied=await client.callTool({name:'openlist_share_disable',arguments:{id:'outside'}});
    assert.equal(denied.isError,true);
    assert.match(JSON.stringify(denied),/OUT_OF_SCOPE/);
    assert.equal(writes,0);
    const unknown=await client.callTool({name:'openlist_share_disable',arguments:{id:'inside'}});
    assert.equal(unknown.isError,true);
    assert.equal(JSON.parse((unknown.content[0] as {text:string}).text).status,'unknown');
    assert.equal(writes,1);
    assert.doesNotMatch(JSON.stringify(unknown),/private-value|timeout after dispatch/);
  } finally {await client.close();}
});

test('native signed download link is served only for explicit in-scope file via MCP', async () => {
  const sign='0.'+'a'.repeat(64);
  let calls=0;
  const client=await clientFor(settings(async request => {
    calls++;
    assert.equal(new URL(request.url).pathname,'/api/fs/get');
    return Response.json({code:200,data:{name:'test.txt',is_dir:false,
      sign,raw_url:'https://evil.example/private?leak=1',pwd:'private'}});
  }));
  try {
    const result=await client.callTool({name:'openlist_download_link',
      arguments:{path:'/Koofr/safe/test.txt'}});
    assert.notEqual(result.isError,true);
    const body=JSON.parse((result.content[0] as {text:string}).text).observed_state;
    assert.equal(body.url,'https://openlist.lirtual.dpdns.org/api/p/Koofr/safe/test.txt?sign='+encodeURIComponent(sign));
    assert.equal(body.permanent,true);
    assert.equal(body.expires_at,null);
    assert.doesNotMatch(JSON.stringify(result),/evil.example|leak|private/);
    const denied=await client.callTool({name:'openlist_download_link',
      arguments:{path:'/Koofr/other/test.txt'}});
    assert.equal(denied.isError,true);
    assert.match(JSON.stringify(denied),/OUT_OF_SCOPE/);
    assert.equal(calls,1);
  } finally {await client.close();}
});

test('native MCP rename exposes overwrite semantics and gates cross-root writes', async () => {
  let mutated=false,writes=0;
  const client=await clientFor(settings(async request=>{
    const url=new URL(request.url);
    const payload=await request.json() as Record<string,unknown>;
    if(url.pathname==='/api/fs/rename'){
      writes++;
      assert.deepEqual(payload,{path:'/Koofr/safe/file.txt',name:'updated.txt'});
      mutated=true;
      return Response.json({code:200,data:null});
    }
    assert.equal(url.pathname,'/api/fs/get');
    const pathname=payload.path as string;
    if(mutated && pathname==='/Koofr/safe/file.txt')
      return Response.json({code:404,data:null});
    assert.equal(pathname,mutated?'/Koofr/safe/updated.txt':'/Koofr/safe/file.txt');
    return Response.json({code:200,data:{name:mutated?'updated.txt':'file.txt',path:pathname,is_dir:false}});
  }));
  try {
    const result=await client.callTool({name:'openlist_rename',arguments:{
      path:'/Koofr/safe/file.txt',new_name:'updated.txt'}});
    assert.notEqual(result.isError,true);
    assert.equal(JSON.parse((result.content[0] as {text:string}).text)
      .observed_state.native_may_overwrite,true);
    assert.equal(writes,1);
    const denied=await client.callTool({name:'openlist_copy',arguments:{
      path:'/Koofr/safe/file.txt',destination_dir:'/Koofr/other'}});
    assert.equal(denied.isError,true);
    assert.match(JSON.stringify(denied),/OUT_OF_SCOPE/);
    assert.equal(writes,1);
  } finally {await client.close();}
});

test('MCP native small upload respects scope and emits actual raw bytes with native warning', async () => {
  let writes=0;
  const client=await clientFor(settings(async request=>{
    const url=new URL(request.url);
    if(request.method==='PUT'){
      writes++;
      assert.equal(url.pathname,'/api/fs/put');
      assert.equal(request.headers.get('file-path'),encodeURIComponent('/Koofr/safe/sample.txt'));
      assert.equal(await request.text(),'hello');
      return Response.json({code:200,data:null});
    }
    assert.equal(url.pathname,'/api/fs/get');
    return Response.json({code:200,data:{
      name:'sample.txt',path:'/Koofr/safe/sample.txt',is_dir:false,size:5}});
  }));
  try {
    const denied=await client.callTool({name:'openlist_upload_small',
      arguments:{path:'/Koofr/outside/sample.txt',content:'never'}});
    assert.equal(denied.isError,true);
    assert.match(JSON.stringify(denied),/OUT_OF_SCOPE/);
    assert.equal(writes,0);
    const result=await client.callTool({name:'openlist_upload_small',
      arguments:{path:'/Koofr/safe/sample.txt',content:'hello'}});
    assert.notEqual(result.isError,true);
    const json=JSON.parse((result.content[0] as {text:string}).text);
    assert.equal(json.status,'succeeded');
    assert.equal(json.observed_state.native_may_overwrite,true);
    assert.equal(writes,1);
  }finally {await client.close();}
});
test('all dangerous unregistered share/delete tools cannot be called through MCP',async()=>{
  // API adapters exist in source, but no tool entrypoint bypasses client approval.
  let calls=0;
  const client=await clientFor(settings(async()=>{calls++;return Response.json({code:200,data:null})}));
  try {
    for(const name of ['openlist_share_create','openlist_share_update',
      'openlist_share_enable','openlist_share_revoke','openlist_delete']) {
      await assert.rejects(()=>client.callTool({name,arguments:{id:'abc',path:'/Koofr/safe/x'}}),
        /not found/);
    }
    assert.equal(calls,0);
  }finally {await client.close();}
});
