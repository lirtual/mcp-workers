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

test('valid signed text flows through internal route, bounded and without returning signer', async () => {
  let calls = 0;
  const api = new OpenListApi(createConfig(env(async request => {
    calls++;
    const url = new URL(request.url);
    if (url.pathname === '/api/fs/get') return ok({
      name: 'notes.md', size: 5, is_dir: false, sign: 'private-signature',
      raw_url: 'https://outside.example/sensitive',
    });
    assert.equal(url.pathname, '/d/drive/safe/notes.md');
    assert.equal(url.searchParams.get('sign'), 'private-signature');
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
