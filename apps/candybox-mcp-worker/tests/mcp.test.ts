import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import worker from '../src/index.ts';
import { buildMcpServer, registerUnreleasedWriteContracts } from '../src/tools.ts';
import { CandyError, shortenUrl, shareText, uploadFile, createDuckAddress, duckCapability, fromBase58, base58,
  type Env, type Sender } from '../src/operations.ts';

const env: Env = { MCP_ACCESS_TOKEN: 'candybox-fixture-token' };
const endpoint = 'https://worker.test/mcp';
function rpc(authorization?: string) {
  return new Request(endpoint, { method: 'POST', headers: {
    'content-type': 'application/json', 'accept': 'application/json, text/event-stream',
    ...(authorization ? { authorization } : {}),
  }, body: JSON.stringify({ jsonrpc:'2.0',id:1,method:'tools/list',params:{} }) });
}
const mock = (f: (url: string, init: RequestInit) => Promise<Response> | Response): Sender =>
  (async (input, init) => f(String(input), init ?? {})) as Sender;

async function clientFor(settings: Env, send: Sender, contracts = false) {
  const handler = createMcpHandler(() => {
    const server = buildMcpServer(settings, send);
    if (contracts) registerUnreleasedWriteContracts(server, settings, send, ['trusted-files.example.com']);
    return server;
  }, { legacy: 'stateless' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: async (input, init) => handler.fetch(input instanceof Request ? input : new Request(input, init)),
  });
  const client = new Client({ name: 'candybox-contract-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}
test('real Worker ingress fail closed; only read-only capability is discoverable', async () => {
  assert.equal((await worker.fetch(new Request('https://worker.test/health'), env)).status, 200);
  assert.equal((await worker.fetch(rpc(), env)).status, 401);
  assert.equal((await worker.fetch(rpc('Bearer bad'), env)).status, 401);
  assert.equal((await worker.fetch(rpc('Bearer candybox-fixture-token'), {} as Env)).status, 503);
  assert.equal((await worker.fetch(rpc('Bearer candybox-fixture-token'), env)).status, 200);
  const session = await clientFor(env, mock(() => { throw Error('no network'); }));
  try {
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map(t => t.name), ['candybox_capabilities']);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    const res = await session.client.callTool({ name:'candybox_capabilities', arguments:{} });
    assert.equal(res.structuredContent?.writes_available, false);
    assert.equal(res.structuredContent?.duck_address, 'not_configured');
  } finally { await session.close(); }
});
test('unreleased contract has four exact write tools, annotations, strict file metadata', async () => {
  const session = await clientFor(env, mock(() => { throw Error('no network'); }), true);
  try {
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map(x => x.name).sort(), [
      'candybox_capabilities','candybox_create_duck_address','candybox_share_text',
      'candybox_shorten_url','candybox_upload_file',
    ]);
    for (const tool of tools.filter(x => x.name !== 'candybox_capabilities')) {
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.idempotentHint, false);
      assert.ok(tool.outputSchema);
    }
    const file = tools.find(x=>x.name==='candybox_upload_file')!;
    assert.deepEqual(file._meta?.['openai/fileParams'], ['file']);
    const obj = file.inputSchema.properties?.file as any;
    assert.deepEqual(obj.required, ['download_url','file_id']);
    assert.deepEqual(Object.keys(obj.properties).sort(),
      ['download_url','file_id','file_name','mime_type']);
    assert.equal(obj.additionalProperties, false);
    const invalid = await session.client.callTool({name:'candybox_shorten_url',
      arguments:{url:'https://example.com/',force:true}});
    assert.ok(invalid.isError);
  } finally { await session.close(); }
});
test('Dub sends exact query, is anonymous, private stats default, never fetches target', async () => {
  let n = 0;
  const url = 'https://mp.weixin.qq.com/s?x=secret%2Bvalue&y=%E6%B5%8B%E8%AF%95';
  const send = mock((target, init) => {
    n++; assert.equal(target, 'https://dub.co/api/links');
    assert.equal(new Headers(init.headers).get('dub-anonymous-link-creation'),'1');
    const b = JSON.parse(String(init.body));
    assert.equal(b.url, url);
    assert.equal(b.domain, 'dub.sh');
    assert.equal(b.publicStats, false);
    return Response.json({ shortLink: 'https://dub.sh/abc123' });
  });
  const res = await shortenUrl({ url }, send);
  assert.equal(n, 1);
  assert.equal(res.short_link, 'https://dub.sh/abc123');
  assert.equal(res.public_stats, false);
  for (const unsafe of ['https://user:password@example.com/', 'https://example.com/path#fragment',
    'javascript:alert(1)', 'ftp://example.com']) {
    await assert.rejects(shortenUrl({url: unsafe}, mock(()=>{throw Error('no');})),
      (e:any) => e instanceof CandyError && e.code==='invalid_input');
  }
});
test('Dub rejects 429 and does not retry uncertain network failure', async () => {
  let attempts=0;
  await assert.rejects(shortenUrl({url:'https://example.com'}, mock(()=>{
    attempts++;return new Response('',{status:429});
  })), (e:any)=>e.code==='rate_limited');
  await assert.rejects(shortenUrl({url:'https://example.com'},mock(()=>{
    attempts++;throw Error('connection reset');
  })), (e:any)=>e.code==='indeterminate');
  assert.equal(attempts,2);
});
test('chronark EnvShare v2 wire contract round-trips using independent Node AES-GCM',async()=>{
  const text='a private text that must not reach the store 测试';
  const id='1111111111111111'; // 16 known zero bytes, as in the upstream composite-key format.
  let captured: any;
  const result=await shareText({text},mock((url,init)=>{
    assert.equal(url,'https://envshare.dev/api/v1/store');
    captured=JSON.parse(String(init.body));
    assert.deepEqual(Object.keys(captured).sort(),['encrypted','iv','reads','ttl']);
    assert.ok(!String(init.body).includes(text));
    assert.equal(captured.ttl,86400);
    assert.equal(captured.reads,1);
    return Response.json({id});
  }));
  assert.ok(result.share_url.startsWith('https://envshare.dev/unseal#'));
  const composite = fromBase58(result.share_url.split('#')[1]);
  assert.equal(composite.length,33);
  assert.equal(composite[0],2);
  assert.deepEqual(composite.slice(1,17),new Uint8Array(16));
  const key=composite.slice(17,33);
  const iv=fromBase58(captured.iv);
  const encrypted=fromBase58(captured.encrypted);
  assert.equal(iv.length,16);
  // Independent AES-GCM implementation, not a call back into CandyBox decrypt.
  const cipher=createDecipheriv('aes-128-gcm',key,iv);
  cipher.setAuthTag(Buffer.from(encrypted.slice(-16)));
  const decrypted=Buffer.concat([cipher.update(encrypted.slice(0,-16)),cipher.final()]);
  assert.equal(decrypted.toString('utf8'),text);
  const wrongKey=new Uint8Array(key);
  wrongKey[0]^=1;
  const wrong=createDecipheriv('aes-128-gcm',wrongKey,iv);
  wrong.setAuthTag(Buffer.from(encrypted.slice(-16)));
  assert.throws(()=>Buffer.concat([wrong.update(encrypted.slice(0,-16)),wrong.final()]));
  assert.equal(base58(new TextEncoder().encode('hello world')),'StV1DL6CwTryKyV');
  assert.equal(new TextDecoder().decode(fromBase58('StV1DL6CwTryKyV')),'hello world');
  await assert.rejects(shareText({text:'X'.repeat(16385)},mock(()=>{throw Error('no');})),
    (e:any)=>e.code==='size_exceeded');
});

test('Litterbox refuses arbitrary download links and streams over 10 MiB are rejected',async()=>{
  await assert.rejects(uploadFile({file:{
    file_id:'file_fake',download_url:'https://evil.example.com/secrets'}},mock(()=>{
    throw Error('should not fetch');
  }),['trusted-files.example.com']), (e:any)=>e.code==='unsafe_file_source');
  let uploads=0;
  const big=mock((url)=>{
    if(url.includes('trusted-files.example.com'))
      return new Response(new Uint8Array(10*1024*1024+1),{
        headers:{'content-length':'2'}});
    uploads++;return new Response('should not happen');
  });
  await assert.rejects(uploadFile({file:{
    file_id:'file_123', download_url:'https://trusted-files.example.com/asset'}},
    big,['trusted-files.example.com']), (e:any)=>e.code==='size_exceeded');
  assert.equal(uploads,0);
});
test('Litterbox one bounded file, default 24h; DDG no token and generation privacy',async()=>{
  let uploads=0;
  const send=mock((url,init)=>{
    if(url.startsWith('https://trusted-files.example.com/'))return new Response('hello');
    uploads++;assert.equal(url,'https://litterbox.catbox.moe/resources/internals/api.php');
    assert.ok(init.body instanceof FormData);
    assert.equal((init.body as FormData).get('time'),'24h');
    assert.equal((init.body as FormData).get('reqtype'),'fileupload');
    return new Response('https://litterbox.catbox.moe/abc123/filename.txt');
  });
  const uploaded=await uploadFile({file:{file_id:'file_123',
    download_url:'https://trusted-files.example.com/file',
    file_name:'demo.txt',mime_type:'text/plain'}},send,['trusted-files.example.com']);
  assert.equal(uploaded.size_bytes,5);
  assert.equal(uploaded.file_url, 'https://litterbox.catbox.moe/abc123/filename.txt');
  assert.equal(uploads,1);
  assert.equal(uploaded.expires_in,'24h');
  assert.equal(await duckCapability(env, mock(()=>{throw Error('not requested')})), 'not_configured');
  await assert.rejects(createDuckAddress(env,mock(()=>{throw Error('not requested')})),
    (e:any)=>e.code==='not_configured');
  let count=0;
  const tokenEnv={...env,CANDYBOX_DDG_TOKEN:'synthetic-dummy-bearer'};
  const sendDuck=mock((url,init)=>{
    count++;
    assert.equal(url,'https://quack.duckduckgo.com/api/email/addresses');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-dummy-bearer');
    assert.equal(init.body,undefined);
    assert.equal(new Headers(init.headers).has('content-type'),false);
    return Response.json({address:'private123',address_owner:'private@example.com',token:'synthetic-dummy-bearer'});
  });
  const result=await createDuckAddress(tokenEnv,sendDuck);
  assert.deepEqual(result,{status:'confirmed',address:'private123@duck.com'});
  assert.equal(count,1);
  let probeCalls=0;
  assert.equal(await duckCapability(tokenEnv,mock((url,init)=>{
    probeCalls++;assert.equal(url,'https://quack.duckduckgo.com/api/email/dashboard');
    assert.equal(init.method,'GET');
    return Response.json({access_token:'opaque-valid-dashboard-token',owner:'private@example.com'});
  })), 'ready');
  assert.equal(probeCalls,1);
});

test('Dub public stats opt-in, uncertain 2xx and provider 401 are distinct',async()=>{
  const opted=await shortenUrl({url:'https://example.com/?campaign=private',public_stats:true},mock((_url,init)=>{
    assert.equal(JSON.parse(String(init.body)).publicStats,true);
    return Response.json({shortLink:'https://dub.sh/safe12'});
  }));
  assert.equal(opted.public_stats,true);
  let count=0;
  await assert.rejects(shortenUrl({url:'https://example.com'},mock(()=>{
    count++;return Response.json({unexpected:'created-but-no-link'});
  })),(e:any)=>e.code==='indeterminate');
  assert.equal(count,1);
  await assert.rejects(shortenUrl({url:'https://example.com'},mock(()=>
    new Response(null,{status:401}))), (e:any)=>e.code==='auth_failed');
});
test('EnvShare invalid post-create ID is indeterminate, never retryable',async()=>{
  let calls=0;
  await assert.rejects(shareText({text:'non-sensitive-fixture'},mock(()=>{
    calls++;return Response.json({id:'not-a-valid-base58-id!!'});
  })),(e:any)=>e.code==='indeterminate');
  assert.equal(calls,1);
});
test('file origin validation and redirects fail before Litterbox dispatch',async()=>{
  for(const url of ['http://trusted-files.example.com/file','https://127.0.0.1/secret',
    'https://trusted-files.example.com:8443/file','https://attacker@trusted-files.example.com/file']) {
    await assert.rejects(uploadFile({file:{file_id:'file_1',download_url:url}},
      mock(()=>{throw Error('must not fetch');}),['trusted-files.example.com']),
      (e:any)=>e.code==='unsafe_file_source');
  }
  let requests=0;
  await assert.rejects(uploadFile({file:{file_id:'file_1',
    download_url:'https://trusted-files.example.com/file'}},
    mock(()=>{requests++;return new Response(null,{status:302,headers:{location:'https://attacker.example.com'}});}),
    ['trusted-files.example.com']),(e:any)=>e.code==='unsafe_file_source');
  assert.equal(requests,1);
});

test('DDG dashboard only reports ready on a recognizable authenticated token payload',async()=>{
  const tokenEnv={...env,CANDYBOX_DDG_TOKEN:'synthetic-dummy-bearer'};
  for (const body of [{ error: 'invalid token' }, { message: 'unauthorized' },
    { status: 'ok' }, { access_token: '' }, { access_token: 123 }]) {
    const state=await duckCapability(tokenEnv,mock((_url,_init)=>Response.json(body)));
    assert.equal(state,'configured_unverified','Unrecognized dashboard JSON cannot establish ready');
  }
  assert.equal(await duckCapability(tokenEnv,mock(()=>
    new Response(JSON.stringify({message:'Unauthorized'}),{status:401}))), 'auth_failed');
  assert.equal(await duckCapability(tokenEnv,mock(()=>
    new Response('upstream error',{status:503}))), 'upstream_unavailable');
});
