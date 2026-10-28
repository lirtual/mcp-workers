import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OpenListApi, OpenListError, createConfig, inScope, canonicalPath } from '../src/openlist.ts';

function env(upstream: (request: Request) => Promise<Response>, roots = '["/drive/safe"]') {
  return {
    MCP_ACCESS_TOKEN: 'ingress-not-for-upstream',
    OPENLIST_API_TOKEN: 'admin-token',
    OPENLIST_ALLOWED_ROOTS: roots,
    OPENLIST: { fetch: upstream },
  };
}
const ok = (data: unknown) => Response.json({ code: 200, message: 'success', data });

test('configured root is non-root and exact; fail closed', () => {
  assert.deepEqual(createConfig(env(async () => ok(null))).roots, ['/drive/safe']);
  for (const roots of ['[]', '["/"]', '["/drive/../safe"]', '["/drive/%2e%2e"]', '[123]']) {
    assert.throws(() => createConfig(env(async () => ok(null), roots)));
  }
  assert.equal(inScope('/drive/safe2', ['/drive/safe']), false);
  assert.equal(inScope('/drive/safe/x', ['/drive/safe']), true);
});

test('reject traversal, alias, decoding, and ambiguous paths before dispatch', () => {
  for (const path of ['/', 'drive/safe', '/drive/../safe', '/drive/./safe',
    '/drive//safe', '/drive/%2f/safe', '/drive/%252e/safe', '/@s/abc',
    '/drive\\safe', '/drive/safe\u0000', '/drive/safe?x=1', '/drive/safe#foo']) {
    assert.throws(() => canonicalPath(path), path);
  }
});

test('Service Binding request is fixed and never forwards caller auth or metadata links', async () => {
  let sent: Request | undefined;
  const api = new OpenListApi(createConfig(env(async request => {
    sent = request;
    return ok({ content: [{ name: 'note.txt', size: 42, is_dir: false, raw_url: 'https://secret.example/token' }], total: 1 });
  })));
  const value = await api.list('/drive/safe', 1, 10);
  assert.deepEqual(value, { entries: [{ name: 'note.txt', size: 42, is_dir: false }], total: 1, page: 1 });
  assert.equal(new URL(sent!.url).hostname, 'openlist.internal');
  assert.equal(new URL(sent!.url).pathname, '/api/fs/list');
  assert.equal(sent!.headers.get('authorization'), 'admin-token');
  assert.equal(sent!.headers.has('cookie'), false);
});

test('out-of-scope requests never invoke Service Binding', async () => {
  let calls = 0;
  const api = new OpenListApi(createConfig(env(async () => { ++calls; return ok(null); })));
  await assert.rejects(api.list('/drive/other', 1, 10), (e: unknown) => e instanceof OpenListError && e.code === 'OUT_OF_SCOPE');
  assert.equal(calls, 0);
});

test('non-success JSON code is not success; written 500 outcome unknown, without retry', async () => {
  let calls = 0;
  const api = new OpenListApi(createConfig(env(async request => {
    ++calls;
    if (new URL(request.url).pathname === '/api/fs/list')
      return ok({content:[],total:0});
    return Response.json({ code: 500, message: 'sensitive-provider-details', data: null }, { status: 500 });
  })));
  const result = await api.mkdir('/drive/safe/new-folder');
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'UPSTREAM_UNCERTAIN');
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('mkdir rejects the configured root and malformed child before dispatch', async () => {
  let calls = 0;
  const api = new OpenListApi(createConfig(env(async () => { ++calls; return ok(null); })));
  await assert.rejects(api.mkdir('/drive/safe'), (e: unknown) => e instanceof OpenListError && e.code === 'INVALID_PATH');
  await assert.rejects(api.mkdir('/drive/safe/../oops'));
  assert.equal(calls, 0);
});

test('search follows actual upstream parent + name schema and filters malicious ancestors', async () => {
  const api = new OpenListApi(createConfig(env(async request => {
    assert.equal(new URL(request.url).pathname, '/api/fs/search');
    assert.deepEqual(await request.json(), {
      parent: '/drive/safe', keywords: 'txt', scope: 0, page: 1, per_page: 10,
    });
    return ok({content: [
      { name: 'inside.txt', parent: '/drive/safe', size: 4, is_dir: false, raw_url:'https://secret.example/token' },
      { name: 'nested.txt', parent: '/drive/safe/docs', size: 5, is_dir: false },
      { name: 'secret.txt', parent: '/drive/another', raw_url: 'secret' },
      { name: 'neighbor.txt', parent: '/drive/safe2' },
      { name: '../bypass.txt', parent: '/drive/safe' },
      { name: 'forged.txt', parent: '/drive/safe', path: '/drive/elsewhere/forged.txt' },
      { name: 'missingparent.txt' },
    ], total: 7});
  })));
  const result = await api.search('/drive/safe', 'txt', 1, 10);
  assert.deepEqual(result, {
    entries: [
      { name: 'inside.txt', path: '/drive/safe/inside.txt', size: 4, is_dir: false },
      { name: 'nested.txt', path: '/drive/safe/docs/nested.txt', size: 5, is_dir: false },
    ],
    total: 7, page: 1, per_page: 10, has_more: false,
  });
});

test('search preserves requested pagination despite scope-filtered results', async () => {
  const api = new OpenListApi(createConfig(env(async request => {
    const args = await request.json() as {page:number;per_page:number};
    assert.equal(args.per_page, 2);
    return ok({content:[
      {name:'visible.txt',parent:'/drive/safe',size:3,raw_url:'https://secret.test/token'},
      {name:'excluded.txt',parent:'/drive/other'},
    ],total:5});
  })));
  const second = await api.search('/drive/safe', 'txt', 2, 2);
  assert.deepEqual(second, {
    entries: [{name:'visible.txt',path:'/drive/safe/visible.txt',size:3}],
    total: 5, page: 2, per_page: 2, has_more: true,
  });
  const third = await api.search('/drive/safe', 'txt', 3, 2);
  assert.equal(third.has_more, false);
  assert.equal(third.page, 3);
  assert.doesNotMatch(JSON.stringify(second), /secret\.test|excluded\.txt/);
});

test('upstream 501 and 400 are classified, while transport timeout after write remains unknown', async () => {
  const unsupported = new OpenListApi(createConfig(env(async () =>
    Response.json({ code: 501, message: 'not implemented', data: null }, { status: 501 }))));
  await assert.rejects(unsupported.list('/drive/safe', 1, 10),
    (e: unknown) => e instanceof OpenListError && e.code === 'NOT_SUPPORTED');
  const invalid = new OpenListApi(createConfig(env(async request =>
    new URL(request.url).pathname === '/api/fs/list' ? ok({content:[],total:0}) :
    Response.json({ code: 400, message: 'request invalid', data: null }, { status: 400 }))));
  assert.equal((await invalid.mkdir('/drive/safe/created')).status, 'failed');
  let count = 0;
  const lost = new OpenListApi(createConfig(env(async request => {
    count++;
    if (new URL(request.url).pathname === '/api/fs/list') return ok({content:[],total:0});
    throw Error('timeout upstream credentials-in-error');
  })));
  const result = await lost.mkdir('/drive/safe/created');
  assert.equal(result.status, 'unknown');
  assert.equal(count, 2);
  assert.doesNotMatch(JSON.stringify(result), /credentials-in-error/);
});

test('internal text reads retain native permanent signer without returning a public URL', async () => {
  let calls = 0;
  const api = new OpenListApi(createConfig(env(async request => {
    calls++;
    const url = new URL(request.url);
    if (url.pathname === '/api/fs/get') return ok({
      name: 'notes.md', size: 5, is_dir: false, sign: '0.'+'a'.repeat(64),
      raw_url: 'https://outside.example/sensitive',
    });
    assert.equal(url.pathname, '/d/drive/safe/notes.md');
    assert.equal(url.searchParams.get('sign'), '0.'+'a'.repeat(64));
    assert.equal(request.headers.get('authorization'), null);
    return new Response('hello', { headers: { 'content-type': 'text/markdown' } });
  })));
  assert.deepEqual(await api.readText('/drive/safe/notes.md'), { path: '/drive/safe/notes.md', text: 'hello' });
  assert.equal(calls, 2);
});

test('oversized internal text responses fail closed even when Content-Length is absent', async () => {
  const api = new OpenListApi(createConfig(env(async request => {
    if (new URL(request.url).pathname === '/api/fs/get')
      return ok({ name: 'notes.txt', size: 1, is_dir: false, sign: '' });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(262145)); controller.close(); },
    }), { headers: { 'content-type': 'text/plain' } });
  })));
  await assert.rejects(api.readText('/drive/safe/notes.txt'),
    (e: unknown) => e instanceof OpenListError && e.code === 'LIMIT_EXCEEDED');
});

test('mkdir verifies empty parent, single mutation, and observed directory', async () => {
  const dispatched: string[] = [];
  const api = new OpenListApi(createConfig(env(async request => {
    const route = new URL(request.url).pathname;
    dispatched.push(route);
    if (route === '/api/fs/list') {
      assert.equal((await request.json() as {path:string}).path, '/drive/safe');
      return ok({ content: [], total: 0 });
    }
    if (route === '/api/fs/mkdir') {
      assert.deepEqual(await request.json(), {path:'/drive/safe/new-folder'});
      return ok(null);
    }
    if (route === '/api/fs/get')
      return ok({name:'new-folder', is_dir:true, size:0});
    throw Error('wrong operation');
  })));
  const result = await api.mkdir('/drive/safe/new-folder');
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.observed_state,{is_dir:true});
  assert.deepEqual(dispatched,['/api/fs/list','/api/fs/mkdir','/api/fs/get']);
});
test('mkdir existing target or incomplete listing blocks mutation before dispatch', async () => {
  for (const listing of [
    {content:[{name:'new-folder',is_dir:true}],total:1},
    {content:[],total:101},
  ]) {
    let calls = 0;
    const api = new OpenListApi(createConfig(env(async request => {
      calls++;
      assert.equal(new URL(request.url).pathname, '/api/fs/list');
      return ok(listing);
    })));
    const result = await api.mkdir('/drive/safe/new-folder');
    assert.equal(result.status,'not_executed');
    assert.equal(calls,1);
  }
});
test('mkdir post-write failed readback is unknown and never retries', async () => {
  let calls = 0;
  const api = new OpenListApi(createConfig(env(async request => {
    calls++;
    const route = new URL(request.url).pathname;
    if (route === '/api/fs/list') return ok({content:[],total:0});
    if (route === '/api/fs/mkdir') return ok(null);
    return Response.json({code:500,message:'secret data',data:null},{status:500});
  })));
  const result = await api.mkdir('/drive/safe/new-folder');
  assert.equal(result.status,'unknown');
  assert.equal(calls,3);
  assert.doesNotMatch(JSON.stringify(result),/secret data/);
});

test('readText does not report a truncated upstream 200 body as a successful file read', async () => {
  const api = new OpenListApi(createConfig(env(async request => {
    if (new URL(request.url).pathname === '/api/fs/get') {
      return ok({name:'notes.txt',is_dir:false,size:11,sign:'abc'});
    }
    return new Response('short', {headers:{'content-type':'text/plain'}});
  })));
  await assert.rejects(api.readText('/drive/safe/notes.txt'),
    (e: unknown) => e instanceof OpenListError && e.code === 'UPSTREAM_UNAVAILABLE');
});

test('getFile rejects upstream metadata identifying a different file', async () => {
  for (const meta of [
    {name:'other.txt',size:4,is_dir:false},
    {name:'target.txt',path:'/drive/safe/elsewhere.txt',size:4,is_dir:false},
    {size:4,is_dir:false},
  ]) {
    const api = new OpenListApi(createConfig(env(async () => ok(meta))));
    await assert.rejects(api.get('/drive/safe/target.txt'),
      (e: unknown) => e instanceof OpenListError && e.code === 'UPSTREAM_UNAVAILABLE');
  }
});

test('list rejects an upstream child path that disagrees with its entry name', async () => {
  const api = new OpenListApi(createConfig(env(async () => ok({
    content: [
      {name:'good.txt',path:'/drive/safe/good.txt',size:3},
      {name:'liar.txt',path:'/drive/safe/other.txt',size:3},
      {name:'deep.txt',path:'/drive/safe/sub/deep.txt',size:3},
    ],total:3,
  }))));
  const result = await api.list('/drive/safe',1,10);
  assert.deepEqual(result.entries,[{name:'good.txt',path:'/drive/safe/good.txt',size:3}]);
});

test('readText never downloads when GET metadata name or path disagrees with target', async () => {
  for (const meta of [
    {name:'mismatch.txt',size:4,is_dir:false,sign:'sign'},
    {name:'target.txt',path:'/drive/safe/another.txt',size:4,is_dir:false,sign:'sign'},
  ]) {
    let calls = 0;
    const api = new OpenListApi(createConfig(env(async () => {
      ++calls;
      return ok(meta);
    })));
    await assert.rejects(api.readText('/drive/safe/target.txt'),
      (e: unknown) => e instanceof OpenListError && e.code === 'UPSTREAM_UNAVAILABLE');
    assert.equal(calls,1);
  }
});

test('gated getShare uses only explicit share ID and returns a strictly scoped safe projection', async () => {
  let sent: Request | undefined;
  const api = new OpenListApi(createConfig(env(async request => {
    sent = request;
    return ok({
      id:'share_Ab-09', files:['/drive/safe/readme.md','/drive/safe/docs/info.txt'],
      disabled:false, expires:'2026-12-31T00:00:00Z', max_accessed:10,
      pwd:'secret-password', creator:'admin@example.test', creator_role:2,
      new_id:'hidden-new-id', readme:'private notes', header:'private header',
      remark:'private remark', raw_url:'https://evil.test/key', accessed:2,
    });
  })));
  const response = await api.getShare('share_Ab-09');
  assert.deepEqual(response, {
    id:'share_Ab-09',
    files:['/drive/safe/readme.md','/drive/safe/docs/info.txt'],
    disabled:false, expires:'2026-12-31T00:00:00Z', max_accessed:10,
  });
  assert.equal(sent!.method,'GET');
  assert.equal(new URL(sent!.url).pathname,'/api/share/get');
  assert.equal(new URL(sent!.url).searchParams.get('id'),'share_Ab-09');
  assert.equal(sent!.headers.get('authorization'),'admin-token');
  assert.doesNotMatch(JSON.stringify(response), /secret-password|creator|private|raw_url|"accessed":/);
});

test('gated getShare rejects malformed IDs before upstream dispatch', async () => {
  let calls = 0;
  const api = new OpenListApi(createConfig(env(async () => {
    ++calls; return ok(null);
  })));
  for (const id of ['', '../test','a/b','a%2fb','?q=bad', 'a'.repeat(65), ' space', 'é']) {
    await assert.rejects(api.getShare(id),
      (e: unknown) => e instanceof OpenListError && e.code === 'INVALID_INPUT');
  }
  assert.equal(calls,0);
});

test('gated getShare rejects entire record if one shared file escapes scope or identity is wrong', async () => {
  for (const response of [
    {id:'share', files:['/drive/safe/ok','/drive/other/secret'],disabled:false},
    {id:'share', files:['/drive/safe/ok','/drive/safe/../secret'],disabled:false},
    {id:'share', files:['/drive/safe/ok','/drive/safe/%2fsecret'],disabled:false},
    {id:'share', files:['/drive/safe/ok','/@s/another'],disabled:false},
    {id:'share', files:[],disabled:false},
    {id:'share', files:['/drive/safe/ok'],disabled:'false'},
    {id:'another', files:['/drive/safe/ok'],disabled:false},
    {id:'share', files:['/drive/safe/ok'],disabled:false,pwd:'secret',expires:'A'.repeat(65)},
  ]) {
    const api = new OpenListApi(createConfig(env(async () => ok(response))));
    await assert.rejects(api.getShare('share'),
      (e: unknown) => e instanceof OpenListError &&
        ['OUT_OF_SCOPE','UPSTREAM_UNAVAILABLE'].includes(e.code));
  }
});

test('gated getShare distinguishes absent ID from upstream malformed responses', async () => {
  const absent = new OpenListApi(createConfig(env(async () =>
    Response.json({code:404,data:null,message:'not found'}))));
  await assert.rejects(absent.getShare('share'),
    (e: unknown) => e instanceof OpenListError && e.code === 'NOT_FOUND');
  const malformed = new OpenListApi(createConfig(env(async () => ok({id:'share',files:null}))));
  await assert.rejects(malformed.getShare('share'),
    (e: unknown) => e instanceof OpenListError && e.code === 'UPSTREAM_UNAVAILABLE');
});

test('share disable gates exact scoped ID and independently verifies state without disclosing secrets', async () => {
  const routes: string[] = [];
  let disabled = false;
  const api = new OpenListApi(createConfig(env(async request => {
    const url = new URL(request.url);
    routes.push(request.method + ' ' + url.pathname);
    assert.equal(url.searchParams.get('id'), 'share_1');
    assert.equal(request.headers.get('authorization'), 'admin-token');
    if (request.method === 'GET' && url.pathname === '/api/share/get')
      return ok({ id: 'share_1', files: ['/drive/safe/note.txt'],
        disabled, expires: null, max_accessed: 1, pwd: 'secret-value',
        creator: 'hidden-admin' });
    if (request.method === 'POST' && url.pathname === '/api/share/disable') {
      disabled = true;
      return ok(null);
    }
    throw Error('unexpected route');
  })));
  const result = await api.disableShare('share_1');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.code, 'OK');
  assert.deepEqual(result.observed_state, { disabled: true });
  assert.deepEqual(routes, ['GET /api/share/get', 'POST /api/share/disable',
    'GET /api/share/get']);
  assert.doesNotMatch(JSON.stringify(result), /secret-value|hidden-admin|note\.txt/);
  const repeated = await api.disableShare('share_1');
  assert.equal(repeated.status, 'not_executed');
  assert.equal(repeated.code, 'ALREADY_DISABLED');
  assert.deepEqual(routes.slice(3), ['GET /api/share/get']);
});

test('share disable refuses malformed or out-of-scope IDs before any write', async () => {
  let writes = 0;
  let reads = 0;
  const api = new OpenListApi(createConfig(env(async request => {
    if (request.method === 'POST') writes++;
    else reads++;
    return ok({ id:'share_1', files:['/drive/outside/secret'], disabled:false });
  })));
  await assert.rejects(api.disableShare('../share'), (error: unknown) =>
    error instanceof OpenListError && error.code === 'INVALID_INPUT');
  const result = await api.disableShare('share_1');
  assert.equal(result.status, 'not_executed');
  assert.equal(result.code, 'OUT_OF_SCOPE');
  assert.equal(writes, 0);
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('share disable never repeats a dispatched unknown write or trusts a success body alone', async () => {
  for (const variant of ['missing','unchanged','changed-files','timeout'] as const) {
    let reads = 0;
    let writes = 0;
    const api = new OpenListApi(createConfig(env(async request => {
      if (request.method === 'POST') {
        writes++;
        if (variant === 'timeout') throw Error('upstream timeout with secret');
        return ok(null);
      }
      reads++;
      if (reads === 2 && variant === 'missing')
        return Response.json({code:404, message:'missing', data:null});
      const files = reads === 2 && variant === 'changed-files' ?
        ['/drive/safe/other.txt'] : ['/drive/safe/note.txt'];
      return ok({id:'share_1',files,disabled:reads === 2 && variant !== 'unchanged'});
    })));
    const result = await api.disableShare('share_1');
    assert.equal(result.status, 'unknown', variant);
    assert.equal(result.code, 'UPSTREAM_UNCERTAIN', variant);
    assert.equal(writes, 1, variant);
    assert.doesNotMatch(JSON.stringify(result), /secret|other\.txt/);
  }
});

test('finite signed download link uses only verified Cloudflare route with native expiry', async () => {
  const expiration=Math.floor(Date.now()/1000)+3600;
  const sign=String(expiration)+'.'+'a'.repeat(64);
  const api=new OpenListApi(createConfig(env(async request => {
    assert.equal(request.method,'POST');
    assert.equal(new URL(request.url).pathname,'/api/fs/get');
    assert.equal(request.headers.get('authorization'),'admin-token');
    const data=await request.json() as {path:string};
    assert.equal(data.path,'/drive/safe/hello world.txt');
    return ok({name:'hello world.txt',path:data.path,is_dir:false,size:11,
      sign,raw_url:'https://untrusted.example/private?password=leak',
      provider_token:'private'});
  })));
  const output=await api.downloadLink('/drive/safe/hello world.txt');
  assert.equal(output.url,'https://openlist.lirtual.dpdns.org/api/p/drive/safe/hello%20world.txt?sign='+encodeURIComponent(sign));
  assert.equal(output.permanent,false);
  assert.equal(output.expires_at,new Date(expiration*1000).toISOString());
  assert.doesNotMatch(JSON.stringify(output),/untrusted\.example|password|provider_token|admin-token/);
});

test('non-expiring upstream signature is never returned as a bearer download link', async () => {
  let calls=0;
  const api=new OpenListApi(createConfig(env(async request => {
    calls++;
    assert.equal(new URL(request.url).pathname,'/api/fs/get');
    return ok({name:'file.txt',path:'/drive/safe/file.txt',size:5,
      is_dir:false,sign:'0.'+'a'.repeat(64)});
  })));
  await assert.rejects(api.downloadLink('/drive/safe/file.txt'), (e: unknown) =>
    e instanceof OpenListError && e.code === 'NOT_SUPPORTED' &&
    !e.message.includes('0.'+'a'.repeat(64)));
  assert.equal(calls,1);
});

test('download link fails closed for out-of-scope path, unsigned, expired and directory responses', async () => {
  let calls=0;
  const api=new OpenListApi(createConfig(env(async () => {calls++;return ok({
    name:'file.txt',is_dir:false,sign:''});})));
  await assert.rejects(api.downloadLink('/drive/outside/file.txt'),(e:unknown)=>
    e instanceof OpenListError && e.code==='OUT_OF_SCOPE');
  assert.equal(calls,0);
  await assert.rejects(api.downloadLink('/drive/safe/file.txt'),(e:unknown)=>
    e instanceof OpenListError && e.code==='NOT_SUPPORTED');
  const variants=[
    {name:'file.txt',is_dir:false,sign:String(Math.floor(Date.now()/1000)-100)+'.'+'a'.repeat(64)},
    {name:'file.txt',is_dir:true,sign:'0.'+'a'.repeat(64)},
  ];
  for(const item of variants) {
    const candidate=new OpenListApi(createConfig(env(async()=>ok(item))));
    await assert.rejects(candidate.downloadLink('/drive/safe/file.txt'),(e:unknown)=>
      e instanceof OpenListError && e.code==='NOT_SUPPORTED');
  }
});

test('native rename/copy/move adapt exactly one scoped target and observe destination', async () => {
  const cases=[
    {kind:'rename',dest:'/drive/safe/updated.txt',data:{path:'/drive/safe/file.txt',name:'updated.txt'}},
    {kind:'copy',dest:'/drive/safe/sub/file.txt',
      data:{src_dir:'/drive/safe',dst_dir:'/drive/safe/sub',names:['file.txt']}},
    {kind:'move',dest:'/drive/safe/sub/file.txt',
      data:{src_dir:'/drive/safe',dst_dir:'/drive/safe/sub',names:['file.txt']}},
  ] as const;
  for (const c of cases) {
    const routes:string[]=[];
    let mutated=false;
    const api=new OpenListApi(createConfig(env(async request=>{
      const route=new URL(request.url).pathname;
      routes.push(request.method+' '+route);
      assert.equal(request.headers.get('authorization'),'admin-token');
      const body=await request.json() as Record<string,unknown>;
      if(route==='/api/fs/get') {
        const file=body.path;
        const expected=file===c.dest?c.dest:'/drive/safe/file.txt';
        assert.equal(file,expected);
        if (mutated && c.kind !== 'copy' && file === '/drive/safe/file.txt')
          return Response.json({code:404,data:null});
        return ok({name:expected.slice(expected.lastIndexOf('/')+1),path:expected,
          is_dir:false,size:3,pwd:'secret'});
      }
      assert.equal(route,'/api/fs/'+c.kind);
      assert.deepEqual(body,c.data);
      mutated=true;
      return ok(null);
    })));
    const result=c.kind==='rename'?
      await api.renameFile('/drive/safe/file.txt','updated.txt'):
      c.kind==='copy'?await api.copyFile('/drive/safe/file.txt','/drive/safe/sub'):
        await api.moveFile('/drive/safe/file.txt','/drive/safe/sub');
    assert.equal(result.status,'succeeded',c.kind);
    assert.deepEqual(result.observed_state,{
      destination:c.dest,is_dir:false,native_may_overwrite:true});
    assert.deepEqual(routes,['POST /api/fs/get','POST /api/fs/'+c.kind,'POST /api/fs/get',
      ...(c.kind==='copy'?[]:['POST /api/fs/get'])]);
    assert.doesNotMatch(JSON.stringify(result),/secret|admin-token/);
  }
});

test('native rename/move confirms absent source using one fresh parent listing after upstream get 500', async () => {
  for (const kind of ['rename', 'move'] as const) {
    const source='/drive/safe/file.txt';
    const destination=kind==='rename'?'/drive/safe/updated.txt':'/drive/safe/sub/file.txt';
    const parent='/drive/safe';
    const routes:string[]=[];
    let mutated=false,writes=0;
    const api=new OpenListApi(createConfig(env(async request=>{
      const route=new URL(request.url).pathname;
      routes.push(route);
      if(route==='/api/fs/get') {
        const {path}=await request.json() as {path:string};
        if(!mutated) {
          assert.equal(path,source);
          return ok({name:'file.txt',path:source,is_dir:false,size:3});
        }
        if(path===destination) return ok({name:'file.txt'===destination.split('/').at(-1)?'file.txt':'updated.txt',
          path:destination,is_dir:false,size:3});
        assert.equal(path,source);
        // OpenList's /get returns 500 for a nonexistent source path.
        return Response.json({code:500,message:'upstream path sensitive',data:null},{status:500});
      }
      if(route==='/api/fs/'+kind) {
        writes++;mutated=true;return ok(null);
      }
      assert.equal(route,'/api/fs/list');
      assert.deepEqual(await request.json(),{
        path:parent,page:1,per_page:100,refresh:true,
      });
      const content=kind==='rename'?[{name:'updated.txt',is_dir:false}]:[];
      return ok({content,total:content.length});
    })));
    const result=kind==='rename'?
      await api.renameFile(source,'updated.txt'):
      await api.moveFile(source,'/drive/safe/sub');
    assert.equal(result.status,'succeeded',kind);
    assert.equal(result.code,'OK');
    assert.equal(writes,1);
    assert.deepEqual(routes,['/api/fs/get','/api/fs/'+kind,'/api/fs/get',
      '/api/fs/get','/api/fs/list']);
    assert.doesNotMatch(JSON.stringify(result),/sensitive|admin-token/);
  }
});

test('missing-source confirmation fails closed for present source, partial list and forged paths', async () => {
  const cases=[
    {content:[{name:'file.txt',is_dir:false},{name:'updated.txt',is_dir:false}],total:2},
    {content:[{name:'updated.txt',is_dir:false}],total:101},
    {content:[{name:'updated.txt',path:'/drive/outside/updated.txt',is_dir:false}],total:1},
    {content:[{name:'updated.txt',is_dir:false},{name:'updated.txt',is_dir:false}],total:2},
  ];
  for (const response of cases) {
    let writes=0,lists=0,mutated=false;
    const api=new OpenListApi(createConfig(env(async request=>{
      const route=new URL(request.url).pathname;
      if(route==='/api/fs/rename'){writes++;mutated=true;return ok(null);}
      if(route==='/api/fs/list') {lists++;return ok(response);}
      assert.equal(route,'/api/fs/get');
      const {path}=await request.json() as {path:string};
      if(!mutated) return ok({name:'file.txt',path,is_dir:false,size:1});
      if(path==='/drive/safe/updated.txt')
        return ok({name:'updated.txt',path,is_dir:false,size:1});
      return Response.json({code:500,message:'secret',data:null},{status:500});
    })));
    const result=await api.renameFile('/drive/safe/file.txt','updated.txt');
    assert.equal(result.status,'unknown');
    assert.equal(result.code,'UPSTREAM_UNCERTAIN');
    assert.equal(writes,1);
    assert.equal(lists,1);
    assert.doesNotMatch(JSON.stringify(result),/secret/);
  }
});

test('native file mutations block out-of-scope paths and preserve unknown after one dispatch', async () => {
  let calls=0,writes=0;
  const api=new OpenListApi(createConfig(env(async request=>{
    calls++;
    const route=new URL(request.url).pathname;
    if(route==='/api/fs/rename') {writes++;throw new Error('possible write timeout');}
    assert.equal(route,'/api/fs/get');
    return ok({name:'file.txt',path:'/drive/safe/file.txt',is_dir:false});
  })));
  await assert.rejects(api.renameFile('/drive/other/file.txt','good.txt'),(e:unknown)=>
    e instanceof OpenListError && e.code==='OUT_OF_SCOPE');
  await assert.rejects(api.copyFile('/drive/safe/file.txt','/drive/other'),(e:unknown)=>
    e instanceof OpenListError && e.code==='OUT_OF_SCOPE');
  await assert.rejects(api.moveFile('/drive/safe/file.txt','/drive/safe/file.txt/sub'),(e:unknown)=>
    e instanceof OpenListError && ['INVALID_PATH','INVALID_INPUT'].includes(e.code));
  assert.equal(calls,0);
  const result=await api.renameFile('/drive/safe/file.txt','updated.txt');
  assert.equal(result.status,'unknown');
  assert.equal(result.code,'UPSTREAM_UNCERTAIN');
  assert.equal(writes,1);
  assert.equal(calls,2);
});

test('native small upload uses File-Path header, raw bytes and exact readback', async () => {
  for(const encoding of ['utf8','base64'] as const) {
    let received:Uint8Array|undefined;
    const requests:string[]=[];
    const api=new OpenListApi(createConfig(env(async request=>{
      const route=new URL(request.url).pathname;
      requests.push(request.method+' '+route);
      if(route==='/api/fs/put') {
        assert.equal(request.method,'PUT');
        assert.equal(request.headers.get('file-path'),encodeURIComponent('/drive/safe/hello.txt'));
        assert.equal(request.headers.get('authorization'),'admin-token');
        received=new Uint8Array(await request.arrayBuffer());
        return ok(null);
      }
      assert.equal(route,'/api/fs/get');
      return ok({name:'hello.txt',path:'/drive/safe/hello.txt',
        is_dir:false,size:received?.byteLength});
    })));
    const result=await api.uploadSmall('/drive/safe/hello.txt',
      encoding==='utf8'?'hello 世界':btoa('hello!'),encoding);
    assert.equal(result.status,'succeeded');
    assert.deepEqual(Array.from(received!),
      Array.from(new TextEncoder().encode(encoding==='utf8'?'hello 世界':'hello!')));
    assert.deepEqual(requests,['PUT /api/fs/put','POST /api/fs/get']);
    assert.equal((result.observed_state as {native_may_overwrite:boolean}).native_may_overwrite,true);
  }
});

test('native small upload refuses scope, malformed base64 and over-limit text before dispatch', async () => {
  let calls=0;
  const api=new OpenListApi(createConfig(env(async()=>{calls++;return ok(null)})));
  await assert.rejects(api.uploadSmall('/drive/outside/x.txt','x','utf8'),(e:unknown)=>
    e instanceof OpenListError && e.code==='OUT_OF_SCOPE');
  await assert.rejects(api.uploadSmall('/drive/safe/x.txt','**','base64'),(e:unknown)=>
    e instanceof OpenListError && e.code==='INVALID_INPUT');
  await assert.rejects(api.uploadSmall('/drive/safe/x.txt','a'.repeat(1024*1024+1),'utf8'),(e:unknown)=>
    e instanceof OpenListError && e.code==='LIMIT_EXCEEDED');
  assert.equal(calls,0);
});

test('native upload does not replay an uncertain upstream write', async () => {
  let writes=0;
  const api=new OpenListApi(createConfig(env(async request=>{
    if(request.method==='PUT') {writes++;throw new Error('after dispatch');}
    throw new Error('unexpected post-write read');
  })));
  const result=await api.uploadSmall('/drive/safe/x.txt','a','utf8');
  assert.equal(result.status,'unknown');
  assert.equal(result.code,'UPSTREAM_UNCERTAIN');
  assert.equal(writes,1);
});

test('gated createShare accepts only scoped files, uses native API, and returns password only once', async () => {
  let made: Record<string,unknown>|undefined;
  let writes=0;
  const routes: string[]=[];
  const api=new OpenListApi(createConfig(env(async req=>{
    const url=new URL(req.url);
    routes.push(req.method+' '+url.pathname);
    assert.equal(req.headers.get('authorization'),'admin-token');
    if(url.pathname==='/api/fs/get') return ok({
      name:'test.txt',path:'/drive/safe/test.txt',is_dir:false});
    if(url.pathname==='/api/share/get') {
      if(!made)return Response.json({code:404,data:null});
      return ok({...made,creator:'private-creator'});
    }
    if(url.pathname==='/api/share/create'){
      writes++;
      made=await req.json() as Record<string,unknown>;
      assert.deepEqual(Object.keys(made).sort(),
        ['id','files','pwd','expires','max_accessed','disabled'].sort());
      assert.equal(made.disabled,false);
      assert.deepEqual(made.files,['/drive/safe/test.txt']);
      assert.match(String(made.pwd),/^[a-f0-9]{48}$/);
      return ok({...made,raw_url:'https://private.invalid/secret'});
    }
    throw new Error('Unexpected route');
  })));
  const result=await api.createShare(['/drive/safe/test.txt'],1,2);
  assert.equal(result.status,'succeeded');
  assert.equal(writes,1);
  assert.match(String((result.observed_state as Record<string,unknown>).password_once),/^[a-f0-9]{48}$/);
  assert.equal((result.observed_state as Record<string,unknown>).max_accessed,2);
  assert.doesNotMatch(JSON.stringify(result),/private-creator|private.invalid|admin-token/);
  assert.deepEqual(routes.map(x=>x.split(' ')[1]),
    ['/api/fs/get','/api/share/get','/api/share/create','/api/share/get']);
});

test('gated createShare rejects out-of-scope records before any upstream call',async()=>{
  let calls=0;
  const api=new OpenListApi(createConfig(env(async()=>{calls++;return ok(null)})));
  await assert.rejects(api.createShare(['/drive/outside/file.txt'],1,1),
    (e:unknown)=>e instanceof OpenListError&&e.code==='OUT_OF_SCOPE');
  await assert.rejects(api.createShare(['/drive/safe/a','/drive/safe/a'],1,1),
    (e:unknown)=>e instanceof OpenListError&&e.code==='INVALID_INPUT');
  await assert.rejects(api.createShare(['/drive/safe/a'],0,1),
    (e:unknown)=>e instanceof OpenListError&&e.code==='INVALID_INPUT');
  assert.equal(calls,0);
});

test('gated updateShare modifies only expiry and access cap via native API',async()=>{
  const calls:string[]=[];
  let expires='2026-12-01T00:00:00.000Z',max=5;
  const api=new OpenListApi(createConfig(env(async req=>{
    const url=new URL(req.url);
    calls.push(req.method+' '+url.pathname);
    if(url.pathname==='/api/share/get') return ok({
      id:'share_1',files:['/drive/safe/x.txt'],disabled:false,
      expires,max_accessed:max,pwd:'hidden'});
    const body=await req.json() as Record<string,unknown>;
    assert.deepEqual(Object.keys(body).sort(),['expires','id','max_accessed']);
    assert.equal(body.id,'share_1');
    expires=String(body.expires);max=Number(body.max_accessed);
    return ok(null);
  })));
  const result=await api.updateShare('share_1',3,2);
  assert.equal(result.status,'succeeded');
  assert.equal((result.observed_state as Record<string,unknown>).max_accessed,2);
  assert.deepEqual(calls,['GET /api/share/get','POST /api/share/update','GET /api/share/get']);
  assert.doesNotMatch(JSON.stringify(result),/hidden/);
});

test('gated enable/revoke use only scoped explicit IDs and independent readback',async()=>{
  let disabled=true,deleted=false,writes=0;
  const api=new OpenListApi(createConfig(env(async req=>{
    const url=new URL(req.url);
    assert.equal(url.searchParams.get('id'),'abc');
    if(req.method==='GET')return deleted?
      Response.json({code:404,data:null}):
      ok({id:'abc',files:['/drive/safe/f.txt'],disabled,max_accessed:1});
    writes++;
    if(url.pathname==='/api/share/enable')disabled=false;
    else if(url.pathname==='/api/share/delete')deleted=true;
    else throw Error('unexpected write');
    return ok(null);
  })));
  const enable=await api.enableShare('abc');
  assert.equal(enable.status,'succeeded');
  const again=await api.enableShare('abc');
  assert.equal(again.status,'not_executed');
  assert.equal(again.code,'ALREADY_ENABLED');
  const revoked=await api.revokeShare('abc');
  assert.equal(revoked.status,'succeeded');
  assert.deepEqual(revoked.observed_state,{revoked:true});
  assert.equal(writes,2);
});

test('gated delete refuses folders and removes only one file with proof of absence',async()=>{
  let deleted=false,writes=0;
  const api=new OpenListApi(createConfig(env(async req=>{
    const route=new URL(req.url).pathname;
    if(route==='/api/fs/get')return deleted?Response.json({code:404,data:null}):
      ok({name:'x.txt',path:'/drive/safe/x.txt',is_dir:false});
    assert.equal(route,'/api/fs/remove');
    assert.deepEqual(await req.json(),{dir:'/drive/safe',names:['x.txt']});
    writes++;deleted=true;return ok(null);
  })));
  const result=await api.deleteFile('/drive/safe/x.txt');
  assert.equal(result.status,'succeeded');
  assert.equal(writes,1);
  assert.deepEqual(result.observed_state,{deleted:true});
  const dirApi=new OpenListApi(createConfig(env(async req=>{
    assert.equal(new URL(req.url).pathname,'/api/fs/get');
    return ok({name:'folder',path:'/drive/safe/folder',is_dir:true});
  })));
  assert.equal((await dirApi.deleteFile('/drive/safe/folder')).code,'NOT_SUPPORTED');
});


test('Koofr deleted file is proven absent by one refreshed complete parent listing after get 500',async()=>{
  const routes:string[]=[];
  let writes=0,deleted=false;
  const api=new OpenListApi(createConfig(env(async req=>{
    const route=new URL(req.url).pathname;
    routes.push(route);
    if(route==='/api/fs/get'){
      const {path}=await req.json() as {path:string};
      assert.equal(path,'/drive/safe/x.txt');
      if(deleted)return Response.json({code:500,message:'sensitive upstream missing file',data:null},{status:500});
      return ok({name:'x.txt',path,is_dir:false,size:50});
    }
    if(route==='/api/fs/remove'){
      writes++;assert.deepEqual(await req.json(),{dir:'/drive/safe',names:['x.txt']});
      deleted=true;return ok(null);
    }
    assert.equal(route,'/api/fs/list');
    assert.deepEqual(await req.json(),{path:'/drive/safe',page:1,per_page:100,refresh:true});
    return ok({content:[{name:'other.txt',path:'/drive/safe/other.txt',is_dir:false}],total:1});
  })));
  const result=await api.deleteFile('/drive/safe/x.txt');
  assert.equal(result.status,'succeeded');
  assert.equal(result.code,'OK');
  assert.deepEqual(result.observed_state,{deleted:true});
  assert.equal(writes,1);
  assert.deepEqual(routes,['/api/fs/get','/api/fs/remove','/api/fs/get','/api/fs/list']);
  assert.doesNotMatch(JSON.stringify(result),/sensitive upstream|admin-token/);
});

test('delete absence proof fails closed for present, incomplete, forged or malformed parent listings',async()=>{
  const cases=[
    {content:[{name:'x.txt',is_dir:false}],total:1},
    {content:[{name:'other.txt',is_dir:false}],total:101},
    {content:[{name:'other.txt',is_dir:false}],total:2},
    {content:[{name:'other.txt',path:'/drive/outside/other.txt'}],total:1},
    {content:[{name:'other.txt'},{name:'other.txt'}],total:2},
    {content:[{path:'/drive/safe/other.txt'}],total:1},
  ];
  for(const listing of cases){
    let writes=0,reads=0;
    const api=new OpenListApi(createConfig(env(async req=>{
      const route=new URL(req.url).pathname;
      if(route==='/api/fs/get'){
        reads++;
        return reads===1?ok({name:'x.txt',path:'/drive/safe/x.txt',is_dir:false,size:50}):
          Response.json({code:500,data:null},{status:500});
      }
      if(route==='/api/fs/remove'){
        writes++;return ok(null);
      }
      assert.equal(route,'/api/fs/list');
      assert.deepEqual(await req.json(),{path:'/drive/safe',page:1,per_page:100,refresh:true});
      return ok(listing);
    })));
    const result=await api.deleteFile('/drive/safe/x.txt');
    assert.equal(result.status,'unknown');
    assert.equal(result.code,'UPSTREAM_UNCERTAIN');
    assert.equal(writes,1);
    assert.equal(reads,2);
  }
});

test('delete with uncertain native remove never trusts a later listing or retries',async()=>{
  let writes=0,lists=0;
  const api=new OpenListApi(createConfig(env(async req=>{
    const route=new URL(req.url).pathname;
    if(route==='/api/fs/get')
      return ok({name:'x.txt',path:'/drive/safe/x.txt',is_dir:false,size:50});
    if(route==='/api/fs/remove'){
      writes++;return Response.json({code:500,data:null},{status:500});
    }
    if(route==='/api/fs/list')lists++;
    throw Error('unexpected request');
  })));
  const result=await api.deleteFile('/drive/safe/x.txt');
  assert.equal(result.status,'unknown');
  assert.equal(result.code,'UPSTREAM_UNCERTAIN');
  assert.equal(writes,1);
  assert.equal(lists,0);
});

test('native rename and move report unknown when source still exists after a nominal success',async()=>{
  for(const kind of ['rename','move'] as const) {
    let writes=0;
    const api=new OpenListApi(createConfig(env(async request=>{
      const path=new URL(request.url).pathname;
      if (path==='/api/fs/'+kind) {writes++;return ok(null);}
      assert.equal(path,'/api/fs/get');
      const file=(await request.json() as {path:string}).path;
      return ok({name:file.split('/').at(-1),path:file,is_dir:false,size:7});
    })));
    const result=kind==='rename' ?
      await api.renameFile('/drive/safe/test.txt','renamed.txt') :
      await api.moveFile('/drive/safe/test.txt','/drive/safe/dest');
    assert.equal(result.status,'unknown',kind);
    assert.equal(result.code,'UPSTREAM_UNCERTAIN');
    assert.equal(writes,1);
    assert.doesNotMatch(JSON.stringify(result),/renamed.txt|dest.*secret/);
  }
});

test('native copy does not require source absence',async()=>{
  const api=new OpenListApi(createConfig(env(async request=>{
    const path=new URL(request.url).pathname;
    if (path==='/api/fs/copy') return ok(null);
    assert.equal(path,'/api/fs/get');
    const file=(await request.json() as {path:string}).path;
    return ok({name:file.split('/').at(-1),path:file,is_dir:false,size:7});
  })));
  const result=await api.copyFile('/drive/safe/test.txt','/drive/safe/dest');
  assert.equal(result.status,'succeeded');
});


test('all five native high-risk adapters report unknown after at most one dispatched write', async()=>{
  const cases=[
    ['create', (api:OpenListApi)=>api.createShare(['/drive/safe/a.txt'],1,2)],
    ['update', (api:OpenListApi)=>api.updateShare('share_1',2,3)],
    ['enable', (api:OpenListApi)=>api.enableShare('share_1')],
    ['revoke', (api:OpenListApi)=>api.revokeShare('share_1')],
    ['delete', (api:OpenListApi)=>api.deleteFile('/drive/safe/a.txt')],
  ] as const;
  for(const [kind,invoke] of cases){
    let writes=0;
    const api=new OpenListApi(createConfig(env(async req=>{
      const path=new URL(req.url).pathname;
      if(req.method==='POST' && path!=='/api/fs/get'){
        writes++;
        throw Error('secret-failure-after-dispatch');
      }
      if(path==='/api/fs/get')return ok({
        path:'/drive/safe/a.txt',name:'a.txt',is_dir:false,size:5});
      if(path==='/api/share/get'){
        return kind==='create'
          ? Response.json({code:404,data:null})
          : ok({id:'share_1',files:['/drive/safe/a.txt'],
              disabled:kind==='enable',max_accessed:2,
              pwd:'private-value',creator:'do-not-disclose'});
      }
      throw Error('unexpected request in '+kind);
    })));
    const result=await invoke(api);
    assert.equal(result.status,'unknown',kind);
    assert.equal(result.code,'UPSTREAM_UNCERTAIN',kind);
    assert.equal(writes,1,kind+' must never retry an uncertain write');
    assert.doesNotMatch(JSON.stringify(result),
      /secret-failure-after-dispatch|private-value|do-not-disclose/);
  }
});
