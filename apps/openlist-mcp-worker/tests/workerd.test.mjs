import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const scriptPath = fileURLToPath(new URL('../.build/openlist/index.js', import.meta.url));
const secret = 'synthetic-openlist-admin';
const portal = 'synthetic-portal-bearer';
const upstream = `
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.host !== 'openlist.internal' ||
        !['/api/fs/list','/api/fs/search'].includes(url.pathname) ||
        request.method !== 'POST' || request.headers.get('authorization') !== 'synthetic-openlist-admin' ||
        request.headers.has('cookie')) {
      return Response.json({code:403,message:'wrong service binding request',data:null},{status:403});
    }
    const body = await request.json();
    if (url.pathname === '/api/fs/search') {
      if (body.parent !== '/Koofr/safe' || body.keywords !== 'txt' ||
          body.page !== 1 || body.per_page !== 10)
        return Response.json({code:400,message:'bad search scope',data:null},{status:400});
      return Response.json({code:200,message:'success',data:{total:3,content:[
        {parent:'/Koofr/safe',name:'found.txt',size:7,is_dir:false,
          raw_url:'https://secret.example/signature'},
        {parent:'/Koofr/safe/docs',name:'nested.txt',size:2,is_dir:false},
        {parent:'/Koofr/safe2',name:'neighbor.txt',size:999}
      ]}});
    }
    if (body.path !== '/Koofr/safe' || body.page !== 1 || body.per_page !== 10) {
      return Response.json({code:400,message:'bad scope',data:null},{status:400});
    }
    return Response.json({code:200,message:'success',
      data:{total:1,content:[{name:'notes.txt',size:5,is_dir:false,
        raw_url:'https://provider.example/private?token=forbidden'}]}});
  }
}`;

async function invoke(mf, method, params, bearer) {
  return mf.dispatchFetch('https://mcp.example.test/mcp', {
    method:'POST',
    headers:{
      'content-type':'application/json',
      accept:'application/json, text/event-stream',
      ...(bearer ? {authorization:'Bearer '+bearer} : {}),
    },
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
  });
}
test('workerd runs MCP ingress and private Service Binding to an isolated upstream Worker', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    port:0,
    workers:[
      {
        name:'openlist-mcp-worker',
        modules:true,
        script:readFileSync(scriptPath,'utf8'),
        bindings:{
          MCP_ACCESS_TOKEN:portal,
          OPENLIST_API_TOKEN:secret,
          OPENLIST_ALLOWED_ROOTS:'["/Koofr/safe"]',
        },
        serviceBindings:{OPENLIST:'openlist-tsworkers'},
        compatibilityDate:'2026-09-10',
      },
      {name:'openlist-tsworkers',modules:true,script:upstream,compatibilityDate:'2026-09-10'},
    ],
  }));
  try {
    const unauth = await invoke(mf,'tools/list',{},undefined);
    assert.equal(unauth.status,401);
    const list = await invoke(mf,'tools/list',{},portal);
    assert.equal(list.status,200);
    const inventory = await list.text();
    assert.match(inventory,/openlist_list_files/);
    assert.doesNotMatch(inventory,/openlist_delete/);
    const call = await invoke(mf,'tools/call',{name:'openlist_list_files',
      arguments:{path:'/Koofr/safe',page:1,per_page:10}},portal);
    assert.equal(call.status,200);
    const body = await call.text();
    assert.match(body,/notes\.txt/);
    assert.doesNotMatch(body,/provider\.example|forbidden/);
    const search = await invoke(mf,'tools/call',{name:'openlist_search_files',
      arguments:{parent:'/Koofr/safe',keywords:'txt',page:1,per_page:10}},portal);
    assert.equal(search.status,200);
    const hits = await search.text();
    assert.match(hits,/found\.txt/);
    assert.match(hits,/nested\.txt/);
    assert.doesNotMatch(hits,/neighbor\.txt|secret\.example/);
    const reject = await invoke(mf,'tools/call',{name:'openlist_list_files',
      arguments:{path:'/Koofr/other',page:1,per_page:10}},portal);
    assert.equal(reject.status,200);
    assert.match(await reject.text(),/OUT_OF_SCOPE/);
  } finally { await mf.dispose(); }
});

test('workerd observes mkdir result and refuses duplicate without another write', async () => {
  const fixture = `
  const entries = new Map();
  export default { async fetch(request) {
    const route = new URL(request.url).pathname;
    if (request.headers.get('authorization') !== 'synthetic-openlist-admin')
      return Response.json({code:401,data:null},{status:401});
    if (route === '/api/fs/list') return Response.json({code:200,data:{
      content:[...entries.keys()].map(name=>({name,is_dir:true})), total:entries.size
    }});
    const body = await request.json();
    if (route === '/api/fs/mkdir' && body.path === '/Koofr/safe/new-folder') {
      entries.set('new-folder',true);
      return Response.json({code:200,data:null});
    }
    if (route === '/api/fs/get' && body.path === '/Koofr/safe/new-folder' && entries.has('new-folder'))
      return Response.json({code:200,data:{name:'new-folder',is_dir:true,size:0}});
    return Response.json({code:404,data:null},{status:404});
  }};
  `;
  const mf = new Miniflare(convertV4MiniflareOptions({
    port:0,
    workers:[
      {name:'openlist-mcp-worker',modules:true,script:readFileSync(scriptPath,'utf8'),
        bindings:{
          MCP_ACCESS_TOKEN:portal, OPENLIST_API_TOKEN:secret,
          OPENLIST_ALLOWED_ROOTS:'["/Koofr/safe"]',
        },serviceBindings:{OPENLIST:'openlist-tsworkers'},compatibilityDate:'2026-09-10'},
      {name:'openlist-tsworkers',modules:true,script:fixture,compatibilityDate:'2026-09-10'},
    ],
  }));
  try {
    const input = {name:'openlist_create_folder',arguments:{path:'/Koofr/safe/new-folder'}};
    const first = await invoke(mf,'tools/call',input,portal);
    assert.equal(first.status,200);
    const body = await first.text();
    assert.match(body,/succeeded/);
    assert.match(body,/is_dir/);
    const second = await invoke(mf,'tools/call',input,portal);
    assert.equal(second.status,200);
    assert.match(await second.text(),/CONFLICT/);
  } finally { await mf.dispose(); }
});
