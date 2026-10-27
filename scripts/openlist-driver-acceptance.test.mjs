import test from 'node:test';
import assert from 'node:assert/strict';
import { runOpenListDriverAcceptance } from './openlist-driver-acceptance.mjs';

const ROOT = '/Koofr/Downloads';
const env = Object.freeze({
  OPENLIST_DRIVER_E2E_APPROVED: 'true',
  OPENLIST_ALLOWED_ROOTS: JSON.stringify([ROOT]),
  MCP_ACCESS_TOKEN: 'synthetic-ingress-token-123',
  OPENLIST_API_TOKEN: 'synthetic-upstream-token-456',
  GITHUB_RUN_ID: '40445123456',
  GITHUB_RUN_ATTEMPT: '1',
});
const folder = `${ROOT}/mcp-spec309-e2e-${env.GITHUB_RUN_ID}-1`;
const file = `${folder}/sample-${env.GITHUB_RUN_ID}-1.txt`;
const fixture = `OpenList MCP Spec309 disposable E2E ${env.GITHUB_RUN_ID}-1\n`;

function fakeTransport({rootOccupied = false,failUpload = false,authEnv = env} = {}) {
  const requests = [];
  let made = false, uploaded = false;
  const response = (name, target, observed_state, isError = false, code = 'OK') =>
    Response.json({jsonrpc:'2.0',id:1,result:{ ...(isError ? {isError:true} : {}),
      content:[{type:'text',text:JSON.stringify({operation:name,
        status:isError?'not_executed':'succeeded',code,target,observed_state})}]}});
  async function transport(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/fs/put') {
      requests.push('upload');
      assert.equal(req.method,'PUT');
      assert.equal(req.headers.get('authorization'),authEnv.OPENLIST_API_TOKEN);
      assert.equal(decodeURIComponent(req.headers.get('file-path')),file);
      assert.equal(await req.text(),fixture);
      if (failUpload) return Response.json({code:500,data:null});
      uploaded=true;
      return Response.json({code:200,data:null});
    }
    assert.equal(url.pathname,'/mcp');
    assert.equal(req.headers.get('authorization'),'Bearer '+authEnv.MCP_ACCESS_TOKEN);
    const rpc=await req.json();
    const name=rpc.params.name,args=rpc.params.arguments;
    requests.push(name);
    if(name==='openlist_list_files') {
      if(args.path===ROOT) return response(name,args.path,{
        total:made?1:rootOccupied?1:0,page:1,
        entries:made?[{name:folder.split('/').at(-1),is_dir:true}]:rootOccupied?[{name:'existing.txt'}]:[]});
      if(args.path===folder) return response(name,args.path,{
        total:uploaded?1:0,page:1,
        entries:uploaded?[{name:file.split('/').at(-1),is_dir:false,size:new TextEncoder().encode(fixture).length}]:[]});
      throw Error('unexpected_list_path');
    }
    if (name==='openlist_create_folder') {
      if(args.path==='/__openlist_e2e_prohibited')
        return response(name,args.path,undefined,true,'OUT_OF_SCOPE');
      assert.equal(args.path,folder);
      assert.equal(made,false);
      made=true;
      return response(name,folder,{is_dir:true});
    }
    if(name==='openlist_get_file') {
      if(args.path===folder && made)
        return response(name,folder,{path:folder,name:folder.split('/').at(-1),is_dir:true});
      if(args.path===file && uploaded)
        return response(name,file,{path:file,name:file.split('/').at(-1),is_dir:false,
          size:new TextEncoder().encode(fixture).length});
      throw Error('unexpected_get_path');
    }
    if(name==='openlist_search_files') {
      assert.equal(args.parent,folder);
      return response(name,folder,{entries:uploaded?[{path:file,name:file.split('/').at(-1)}]:[]});
    }
    if(name==='openlist_read_text') {
      assert.equal(args.path,file);
      return response(name,file,{path:file,text:fixture});
    }
    throw Error('unexpected_tool');
  }
  return {transport,requests};
}

test('isolated E2E verifies all six operations with only one fixture PUT',async()=>{
  const {transport,requests}=fakeTransport();
  const result=await runOpenListDriverAcceptance(env,transport);
  assert.equal(result.folder,folder.split('/').at(-1));
  assert.deepEqual(result.tested,['mkdir','get','list','search','read_text','scope_denial']);
  assert.equal(requests.filter(x=>x==='upload').length,1);
  assert.equal(requests.filter(x=>x==='openlist_create_folder').length,2);
});
test('missing approval and non-reviewed roots refuse every request',async()=>{
  const {transport,requests}=fakeTransport();
  await assert.rejects(()=>runOpenListDriverAcceptance({...env,OPENLIST_DRIVER_E2E_APPROVED:'false'},transport),/not_approved/);
  await assert.rejects(()=>runOpenListDriverAcceptance({...env,OPENLIST_ALLOWED_ROOTS:'["/"]'},transport),/unexpected_root/);
  assert.deepEqual(requests,[]);
});
test('pre-existing user file prevents all writes',async()=>{
  const {transport,requests}=fakeTransport({rootOccupied:true});
  await assert.rejects(()=>runOpenListDriverAcceptance(env,transport),/root_not_empty/);
  assert.deepEqual(requests,['openlist_list_files']);
});
test('ambiguous fixture write is not repeated or followed by further tool calls',async()=>{
  const {transport,requests}=fakeTransport({failUpload:true});
  await assert.rejects(()=>runOpenListDriverAcceptance(env,transport),/fixture_write_unknown/);
  assert.equal(requests.filter(x=>x==='upload').length,1);
  assert.equal(requests.at(-1),'upload');
});

test('short nonempty Secret values use the deployed auth contract, not an arbitrary length gate',async()=>{
  const authEnv = {...env,MCP_ACCESS_TOKEN:'mcp123',OPENLIST_API_TOKEN:'api789'};
  const {transport,requests}=fakeTransport({authEnv});
  const result=await runOpenListDriverAcceptance(authEnv,transport);
  assert.equal(result.tested.length,6);
  assert.equal(requests.filter(x=>x==='upload').length,1);
});
test('empty, whitespace-padded and CRLF tokens fail before network operations',async()=>{
  const {transport,requests}=fakeTransport();
  for (const invalid of ['', ' ', ' bearer', 'bearer ', 'hello\\r\\nworld']) {
    await assert.rejects(
      ()=>runOpenListDriverAcceptance({...env,MCP_ACCESS_TOKEN:invalid},transport),
      /missing_mcp_token/,
    );
    await assert.rejects(
      ()=>runOpenListDriverAcceptance({...env,OPENLIST_API_TOKEN:invalid},transport),
      /missing_upstream_token/,
    );
  }
  assert.deepEqual(requests,[]);
});
