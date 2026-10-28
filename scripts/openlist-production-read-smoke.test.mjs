import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runOpenListProductionReadSmoke, runOpenListHistoricalShareRead, runOpenListHistoricalShareDisable, OPENLIST_MCP_URL } from './openlist-production-read-smoke.mjs';

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

test('fail closed if actual list metadata leaks raw links, passwords or forged identity', async () => {
  const localRoot=roots[0];
  for (const entry of [
    {name:'sample.txt',size:7,raw_url:'https://example.invalid/secret'},
    {name:'sample.txt',sign:'signature'},
    {name:'sample.txt',unexpected_field:'not-a-file-field'},
    {name:'another.txt',path:'/Koofr/elsewhere/another.txt'},
    {name:'../escaped'},
    {name:'sample.txt',size:'7'},
    {name:'sample.txt',is_dir:'false'},
    {name:'sample.txt',modified:'x'.repeat(65)},
  ]) {
    await assert.rejects(runOpenListProductionReadSmoke({
      ...validEnv,OPENLIST_ALLOWED_ROOTS:JSON.stringify([localRoot]),
    },async request => {
      const target=(await request.json()).params.arguments.path;
      return response(target===localRoot
        ? reply(target,{observed_state:{entries:[entry],total:1,page:1}})
        : denied(target));
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

const knownShare = 'mcp_spec309_40493124967_1';
const knownFile = '/Koofr/Downloads/mcp-spec309-e2e-40493124967-1/sample-40493124967-1.txt';
const shareEnv = {
  ...validEnv,
  OPENLIST_ALLOWED_ROOTS:JSON.stringify(['/Koofr/Downloads']),
  OPENLIST_HISTORICAL_SHARE_READ:'true',
};
const shareResult = (state, isError = false) => response({
  jsonrpc:'2.0',id:1,result:{...(isError?{isError:true}:{}),content:[{
    type:'text',text:JSON.stringify({
      operation:'openlist_share_get',target:knownShare,...state,
    }),
  }]},
});
const checkedShareTransport = (responseValue) => async req => {
  assert.equal(req.url,OPENLIST_MCP_URL);
  assert.equal(req.method,'POST');
  assert.equal(req.redirect,'manual');
  assert.equal(req.headers.get('authorization'),'Bearer synthetic-release-ingress-token');
  const rpc=await req.json();
  assert.deepEqual({method:rpc.method,name:rpc.params?.name,args:rpc.params?.arguments},
    {method:'tools/call',name:'openlist_share_get',args:{id:knownShare}});
  return responseValue.clone();
};

test('explicitly gated old synthetic share is queried once read-only and no secrets appear in result',async()=>{
  let calls=0;
  const expires='2026-10-27T13:55:00.000Z';
  const result=await runOpenListHistoricalShareRead(shareEnv,async req=>{
    calls++;
    return checkedShareTransport(shareResult({
      status:'succeeded',code:'OK',
      observed_state:{id:knownShare,files:[knownFile],disabled:false,
        expires,max_accessed:1},
    }))(req);
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{present:true,disabled:false,expired:true,expires});
});

test('already disabled old synthetic share is only reported, never mutated',async()=>{
  const r=await runOpenListHistoricalShareRead(shareEnv,checkedShareTransport(
    shareResult({status:'succeeded',code:'OK',
      observed_state:{id:knownShare,files:[knownFile],disabled:true}})));
  assert.deepEqual(r,{present:true,disabled:true,expired:null,expires:null});
});

test('confirmed explicit missing share ID is read as absent; other upstream errors are inconclusive',async()=>{
  const absent=await runOpenListHistoricalShareRead(shareEnv,checkedShareTransport(
    shareResult({status:'not_executed',code:'NOT_FOUND'},true)));
  assert.deepEqual(absent,{present:false});
  for(const code of ['UPSTREAM_UNAVAILABLE','UPSTREAM_UNCERTAIN','OUT_OF_SCOPE']){
    await assert.rejects(runOpenListHistoricalShareRead(shareEnv,
      checkedShareTransport(shareResult({status:'not_executed',code},true))),
      /openlist_smoke_share_read_unverified/);
  }
});

test('share read refuses any other files, extra metadata, mismatched ID, malformed or missing expiry',async()=>{
  const base={id:knownShare,files:[knownFile],disabled:false};
  for(const invalid of [
    {...base,id:'other'},
    {...base,files:['/Koofr/Downloads/user-file.txt']},
    {...base,files:[knownFile,knownFile]},
    {...base,disabled:'false'},
    {...base,pwd:'sensitive'},
    {...base,expires:'garbage'},
    {...base,max_accessed:-1},
  ]){
    await assert.rejects(runOpenListHistoricalShareRead(shareEnv,
      checkedShareTransport(shareResult({status:'succeeded',code:'OK',
        observed_state:invalid}))),/^Error: openlist_smoke_/);
  }
});

test('read-only approval and configured exact root fail before network',async()=>{
  let calls=0;
  for(const override of [
    {OPENLIST_HISTORICAL_SHARE_READ:'false'},
    {OPENLIST_ALLOWED_ROOTS:JSON.stringify(['/Koofr/other'])},
    {OPENLIST_ALLOWED_ROOTS:'not-json'},
    {MCP_ACCESS_TOKEN:''},
  ]){
    await assert.rejects(runOpenListHistoricalShareRead({...shareEnv,...override},
      async()=>{calls++;throw Error('network forbidden')}),/^Error: openlist_smoke_/);
  }
  assert.equal(calls,0);
});

test('share-read workflow is mutually exclusive with write and Portal modes',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/openlist-acceptance.yml',import.meta.url),'utf8');
  assert.match(workflow,/confirm_historical_share_read:/);
  assert.match(workflow,/APPROVE_SHARE_READ: \${{ inputs.confirm_historical_share_read }}/);
  assert.match(workflow,/\$APPROVE_SHARE_READ" == "true"/);
  assert.match(workflow,/OPENLIST_HISTORICAL_SHARE_READ: "true"/);
  assert.match(workflow,/name: Read only exact historical synthetic share/);
  assert.match(workflow,/inputs.confirm_historical_share_read == true/);
});

const disableEnv = {
  ...shareEnv,OPENLIST_HISTORICAL_SHARE_READ:'false',
  OPENLIST_HISTORICAL_SHARE_DISABLE:'true',
};
const exactExpiry='2026-10-27T13:55:53.913Z';
const mockDisableTransport=({
  initialDisabled=false,afterDisabled=true,
  badFiles=false,unknownOutcome=false,throwOnWrite=false,
}={}) => {
  let reads=0,writes=0;
  return {
    counts:()=>({reads,writes}),
    transport:async req=>{
      assert.equal(req.method,'POST');
      assert.equal(req.url,OPENLIST_MCP_URL);
      assert.equal(req.headers.get('authorization'),
        'Bearer synthetic-release-ingress-token');
      const data=await req.json();
      assert.equal(data.method,'tools/call');
      assert.equal(data.params.arguments.id,knownShare);
      if(data.params.name==='openlist_share_get') {
        reads++;
        const disabled = reads===1 ? initialDisabled : afterDisabled;
        return shareResult({status:'succeeded',code:'OK',
          observed_state:{id:knownShare,files:badFiles?['/Koofr/Downloads/other.txt']:[knownFile],
            disabled,expires:exactExpiry,max_accessed:1}});
      }
      assert.equal(data.params.name,'openlist_share_disable');
      writes++;
      assert.equal(writes,1,'never replay an effectful mutation');
      if(throwOnWrite) throw Error('write transport lost');
      if(unknownOutcome) return response({jsonrpc:'2.0',id:1,result:{
        isError:true,content:[{type:'text',text:JSON.stringify({
          operation:'openlist_share_disable',target:knownShare,
          status:'unknown',code:'UPSTREAM_UNCERTAIN'})}]}});
      return response({jsonrpc:'2.0',id:1,result:{
        content:[{type:'text',text:JSON.stringify({
          operation:'openlist_share_disable',target:knownShare,
          status:'succeeded',code:'OK',observed_state:{disabled:true}})}]}});
    },
  };
};

test('approved historical share is disabled once, after exact preflight and independent readback',async()=>{
  const mock=mockDisableTransport();
  const result=await runOpenListHistoricalShareDisable(disableEnv,mock.transport);
  assert.deepEqual(result,{id:knownShare,before_disabled:false,
    after_disabled:true,expired:true,write_calls:1});
  assert.deepEqual(mock.counts(),{reads:2,writes:1});
});

test('an already-disabled or unexpected shared file blocks before any mutation',async()=>{
  for(const options of [{initialDisabled:true},{badFiles:true}]){
    const mock=mockDisableTransport(options);
    await assert.rejects(runOpenListHistoricalShareDisable(disableEnv,mock.transport),
      /^Error: openlist_smoke_/);
    assert.deepEqual(mock.counts(),{reads:1,writes:0});
  }
});

test('unknown dispatched mutation and lost response never trigger a replay',async()=>{
  for(const options of [{unknownOutcome:true},{throwOnWrite:true}]){
    const mock=mockDisableTransport(options);
    await assert.rejects(runOpenListHistoricalShareDisable(disableEnv,mock.transport),
      /openlist_smoke_share_disable_unknown/);
    assert.deepEqual(mock.counts(),{reads:1,writes:1});
  }
});

test('postwrite independent readback mismatch is unknown but no duplicate write',async()=>{
  const mock=mockDisableTransport({afterDisabled:false});
  await assert.rejects(runOpenListHistoricalShareDisable(disableEnv,mock.transport),
    /openlist_smoke_share_disable_readback_unknown/);
  assert.deepEqual(mock.counts(),{reads:2,writes:1});
});

test('mutation mode and root authorization are required before any network',async()=>{
  for(const override of [
    {OPENLIST_HISTORICAL_SHARE_DISABLE:'false'},
    {OPENLIST_HISTORICAL_SHARE_READ:'true'},
    {OPENLIST_ALLOWED_ROOTS:'["/Koofr/other"]'},
    {MCP_ACCESS_TOKEN:''},
  ]){
    const mock=mockDisableTransport();
    await assert.rejects(runOpenListHistoricalShareDisable(
      {...disableEnv,...override},mock.transport),/^Error: openlist_smoke_/);
    assert.deepEqual(mock.counts(),{reads:0,writes:0});
  }
});

test('one-time historical share disable is manual, exclusive and not a deployment',async()=>{
  const wf=await readFile(new URL('../.github/workflows/openlist-acceptance.yml',import.meta.url),'utf8');
  assert.match(wf,/confirm_historical_share_disable:/);
  assert.match(wf,/APPROVE_SHARE_DISABLE: \${{ inputs.confirm_historical_share_disable }}/);
  assert.match(wf,/\$APPROVE_SHARE_DISABLE" == "true"/);
  assert.match(wf,/inputs.confirm_historical_share_disable == true/);
  assert.match(wf,/OPENLIST_HISTORICAL_SHARE_DISABLE: "true"/);
  assert.match(wf,/name: One-time owner-approved historical synthetic share disable \(no deploy\)/);
  assert.match(wf,/Independent new-process readback of historical share \(no writes\)/);
  assert.match(wf,/cancel-in-progress: false/);
});
