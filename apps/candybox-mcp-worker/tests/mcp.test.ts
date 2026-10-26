import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import worker from '../src/index.ts';
import { buildMcpServer, registerUnreleasedWriteContracts } from '../src/tools.ts';
import { CandyError, shortenUrl, shareText, uploadFile, createDuckAddress, duckCapability,
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
test('EnvShare encrypts before network; key is absent from POST and is only URL fragment',async()=>{
  const text='a private text that must not reach the store';
  let captured: any;
  const result=await shareText({text},mock((url,init)=>{
    assert.equal(url,'https://envshare.app/api/share');
    captured=JSON.parse(String(init.body));
    assert.ok(!String(init.body).includes(text));
    assert.ok(!Object.keys(captured).some(k=>/key|plaintext/.test(k)));
    return Response.json({id:'share_12345'});
  }));
  assert.ok(result.share_url.startsWith('https://envshare.app/s/share_12345#'));
  assert.ok(result.share_url.split('#')[1].length>15);
  assert.equal(result.ttl_seconds,86400);
  assert.equal(result.max_reads,1);
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
    return new Response('https://litter.catbox.moe/abc.txt');
  });
  const uploaded=await uploadFile({file:{file_id:'file_123',
    download_url:'https://trusted-files.example.com/file',
    file_name:'demo.txt',mime_type:'text/plain'}},send,['trusted-files.example.com']);
  assert.equal(uploaded.size_bytes,5);
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
    return Response.json({address:'private123@duck.com',address_owner:'private@example.com',token:'synthetic-dummy-bearer'});
  });
  const result=await createDuckAddress(tokenEnv,sendDuck);
  assert.deepEqual(result,{status:'confirmed',address:'private123@duck.com'});
  assert.equal(count,1);
  let probeCalls=0;
  assert.equal(await duckCapability(tokenEnv,mock((url,init)=>{
    probeCalls++;assert.equal(url,'https://quack.duckduckgo.com/api/email/dashboard');
    assert.equal(init.method,'GET');
    return Response.json({status:'ok',owner:'private@example.com'});
  })), 'ready');
  assert.equal(probeCalls,1);
});
