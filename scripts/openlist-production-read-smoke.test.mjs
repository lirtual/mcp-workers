import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runOpenListProductionReadSmoke, OPENLIST_MCP_URL } from './openlist-production-read-smoke.mjs';

const roots=['/Koofr/mcp-test','/OneDrive/safe'];
const validEnv = {
  MCP_ACCESS_TOKEN:'synthetic-release-ingress-token',
  OPENLIST_ALLOWED_ROOTS:JSON.stringify(roots),
};
const denied = target => ({
  jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:JSON.stringify({
    operation:'openlist_list_files',status:'not_executed',code:'OUT_OF_SCOPE',target,
  })}]},
});
const reply = (root, opts={}) => ({
  jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({
    operation:'openlist_list_files',status:'succeeded',code:'OK',
    target:root,observed_state:{entries:[],total:0,page:1},...opts,
  })}]}
});
const response = (value, type='application/json') =>
  new Response(type==='text/event-stream'?'event: message\ndata: '+JSON.stringify(value)+'\n\n':
    JSON.stringify(value),{headers:{'content-type':type}});

test('live smoke checks every configured root with only read-only MCP list, no secrets or file values logged', async () => {
  const called=[];
  const transport=async req => {
    assert.equal(req.method,'POST');
    assert.equal(req.url,OPENLIST_MCP_URL);
    assert.equal(req.redirect,'manual');
    assert.equal(req.headers.get('authorization'),'Bearer synthetic-release-ingress-token');
    const body=await req.json();
    assert.deepEqual({method:body.method,name:body.params.name,page:body.params.arguments.page,
      per_page:body.params.arguments.per_page},
      {method:'tools/call',name:'openlist_list_files',page:1,per_page:1});
    const root=body.params.arguments.path;
    called.push(root);
    return response(root.startsWith('/__openlist_mcp_scope_probe_') ?
      denied(root) : reply(root));
  };
  assert.equal(await runOpenListProductionReadSmoke(validEnv,transport),2);
  assert.deepEqual(called,[...roots,'/__openlist_mcp_scope_probe_0']);
});

test('accepts bounded MCP SSE response but rejects misbound or error outcomes', async () => {
  assert.equal(await runOpenListProductionReadSmoke({
    ...validEnv,OPENLIST_ALLOWED_ROOTS:JSON.stringify([roots[0]]),
  },async req => {
    const target=(await req.json()).params.arguments.path;
    return response(target.startsWith('/__openlist_mcp_scope_probe_') ?
      denied(target) : reply(target),'text/event-stream');
  }),1);
  for (const failure of [
    response(reply('/Koofr/not-the-root')),
    response(reply(roots[0],{status:'unknown'})),
    response({jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:'sensitive'}]}}),
    response({jsonrpc:'2.0',id:1,error:{code:500,message:'secret'}}),
    response(reply(roots[0]),'text/html'),
    new Response('Bearer secret',{status:401}),
    new Response('redirect',{status:302,headers:{location:'https://evil.example/'}}),
    new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),
    response({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'bad json'}]}}),
  ]) {
    await assert.rejects(
      runOpenListProductionReadSmoke({...validEnv,OPENLIST_ALLOWED_ROOTS:JSON.stringify([roots[0]])},
        async () => failure.clone()),
      error => /^openlist_smoke_[a-z0-9_]+$/.test(String(error?.message)) &&
        !String(error?.message).includes('secret'));
  }
});

test('an open scope or non-denial blocks Portal acceptance despite a readable root', async () => {
  const oneRoot={...validEnv,OPENLIST_ALLOWED_ROOTS:JSON.stringify([roots[0]])};
  for (const unsafe of [
    path => reply(path), // out-of-scope request erroneously succeeds
    path => denied('/Koofr/mismatched'), // error attributed to a different target
    path => ({...denied(path),result:{...denied(path).result,isError:false}}),
  ]) {
    await assert.rejects(runOpenListProductionReadSmoke(oneRoot,async request => {
      const path=(await request.json()).params.arguments.path;
      return response(path===roots[0] ? reply(path) : unsafe(path));
    }),error => /^openlist_smoke_[a-z0-9_]+$/.test(error?.message));
  }
});

test('missing credentials or invalid roots fail before any request', async () => {
  let calls=0;
  for (const env of [
    {...validEnv,MCP_ACCESS_TOKEN:''},
    {...validEnv,OPENLIST_ALLOWED_ROOTS:'[]'},
    {...validEnv,OPENLIST_ALLOWED_ROOTS:'["/"]'},
    {...validEnv,OPENLIST_ALLOWED_ROOTS:'["/Koofr/../secret"]'},
    {...validEnv,OPENLIST_ALLOWED_ROOTS:'invalid'},
  ]) {
    await assert.rejects(runOpenListProductionReadSmoke(env,async () => {
      ++calls;throw Error('must-not-call');
    }),/^Error: openlist_smoke_/);
  }
  assert.equal(calls,0);
});

test('release runs positive OpenList read smoke after version + anonymous denial but before Portal registration',async () => {
  const release=await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const ci=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const step=release.indexOf('name: Verify OpenList production Service Binding via read-only MCP');
  const version=release.indexOf('name: Verify exact active version and required production bindings');
  const denial=release.indexOf('name: Check unauthenticated MCP surface without credentials');
  const portal=release.indexOf('name: Register production OpenList MCP with existing One-MCP Portal');
  assert.ok(version>=0 && denial>version && step>denial && portal>step);
  assert.match(release.slice(step,step+440),/if: inputs.worker == 'openlist-mcp-worker'/);
  assert.match(release.slice(step,step+440),/secrets.MCP_ACCESS_TOKEN/);
  assert.match(release.slice(step,step+440),/vars.OPENLIST_ALLOWED_ROOTS/);
  assert.match(release.slice(step,step+440),/node scripts\/openlist-production-read-smoke\.mjs/);
  assert.match(ci,/node --test scripts\/openlist-production-read-smoke\.test\.mjs/);
  assert.equal((release.match(/node scripts\/openlist-production-read-smoke\.mjs/g)||[]).length,1);
});
