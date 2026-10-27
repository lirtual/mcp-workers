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

function fakeTransport({rootEntries = [],rootReportedTotal,failUpload = false,
  authEnv = env,nativeMoveError} = {}) {
  const requests = [];
  let made = false, uploaded = false;
  const nativeSource = `${folder}/native-${env.GITHUB_RUN_ID}-1.txt`;
  const nativeDir = `${folder}/native-copies`;
  const nativeDest = `${nativeDir}/native-${env.GITHUB_RUN_ID}-1.txt`;
  const renamedDest = `${nativeDir}/renamed-${env.GITHUB_RUN_ID}-1.txt`;
  const nativeData = `OpenList native MCP E2E ${env.GITHUB_RUN_ID}-1\n`;
  const nativeFiles=new Map();
  let nativeFolder=false;
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
    if(url.pathname.startsWith('/api/p/')) {
      requests.push('signed_get');
      assert.equal(req.method,'GET');
      assert.equal(url.origin,'https://openlist.lirtual.dpdns.org');
      assert.equal(req.headers.get('authorization'),null);
      assert.equal(url.pathname,'/api/p/'+nativeDest.slice(1));
      assert.equal(url.searchParams.get('sign'),'0.'+'a'.repeat(64));
      return new Response(nativeFiles.get(nativeDest),{
        status:200,headers:{'content-type':'text/plain'}});
    }
    assert.equal(url.pathname,'/mcp');
    assert.equal(req.headers.get('authorization'),'Bearer '+authEnv.MCP_ACCESS_TOKEN);
    const rpc=await req.json();
    const name=rpc.params.name,args=rpc.params.arguments;
    requests.push(name);
    if(name==='openlist_list_files') {
      if(args.path===ROOT) {
        const entries = [...rootEntries, ...(made?[{name:folder.split('/').at(-1),is_dir:true}]:[])];
        return response(name,args.path,{
          total:rootReportedTotal ?? entries.length,page:1,entries});
      }
      if(args.path===nativeDir) {
        const entries=[...nativeFiles.keys()].filter(path=>path.startsWith(nativeDir+'/'))
          .map(path=>({name:path.slice(nativeDir.length+1),is_dir:false}));
        return response(name,args.path,{total:entries.length,page:1,entries});
      }
      if(args.path===folder) return response(name,args.path,{
        total:uploaded?1:0,page:1,
        entries:uploaded?[{name:file.split('/').at(-1),is_dir:false,size:new TextEncoder().encode(fixture).length}]:[]});
      throw Error('unexpected_list_path');
    }
    if (name==='openlist_create_folder') {
      if(args.path==='/__openlist_e2e_prohibited')
        return response(name,args.path,undefined,true,'OUT_OF_SCOPE');
      if(args.path===nativeDir) {
        assert.equal(made,true);
        assert.equal(nativeFolder,false);
        nativeFolder=true;
        return response(name,nativeDir,{is_dir:true});
      }
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
      if(nativeFiles.has(args.path)) return response(name,args.path,{
        path:args.path,name:args.path.split('/').at(-1),
        is_dir:false,size:new TextEncoder().encode(nativeFiles.get(args.path)).length});
      throw Error('unexpected_get_path');
    }
    if(name==='openlist_search_files') {
      assert.equal(args.parent,folder);
      return response(name,folder,{entries:uploaded?[{path:file,name:file.split('/').at(-1)}]:[]});
    }
    if(name==='openlist_read_text') {
      if(args.path===file) return response(name,file,{path:file,text:fixture});
      assert.ok(nativeFiles.has(args.path));
      return response(name,args.path,{path:args.path,text:nativeFiles.get(args.path)});
    }
    if(name==='openlist_upload_small') {
      assert.equal(args.path,nativeSource);
      assert.equal(args.encoding,'utf8');
      assert.equal(args.content,nativeData);
      nativeFiles.set(nativeSource,nativeData);
      return response(name,nativeSource,{
        size:new TextEncoder().encode(nativeData).length,native_may_overwrite:true});
    }
    if(name==='openlist_copy'){
      assert.equal(args.path,nativeSource);
      assert.equal(args.destination_dir,nativeDir);
      nativeFiles.set(nativeDest,nativeFiles.get(nativeSource));
      return response(name,nativeSource,{destination:nativeDest,native_may_overwrite:true});
    }
    if(name==='openlist_rename'){
      assert.equal(args.path,nativeDest);
      assert.equal(args.new_name,renamedDest.split('/').at(-1));
      nativeFiles.set(renamedDest,nativeFiles.get(nativeDest));
      nativeFiles.delete(nativeDest);
      return response(name,nativeDest,{destination:renamedDest,native_may_overwrite:true});
    }
    if(name==='openlist_move'){
      if(args.path.startsWith('/__openlist_e2e_prohibited'))
        return response(name,args.path,undefined,true,'OUT_OF_SCOPE');
      assert.equal(args.path,nativeSource);
      assert.equal(args.destination_dir,nativeDir);
      if (nativeMoveError) {
        return Response.json({jsonrpc:'2.0',id:1,result:{isError:true,
          content:[{type:'text',text:JSON.stringify({
            operation:name,status:nativeMoveError.status,code:nativeMoveError.code,
            target:nativeSource,
            message:'Never print upstream errors, file paths or ' + authEnv.MCP_ACCESS_TOKEN,
          })}]}});
      }
      nativeFiles.set(nativeDest,nativeFiles.get(nativeSource));
      nativeFiles.delete(nativeSource);
      return response(name,nativeSource,{destination:nativeDest,native_may_overwrite:true});
    }
    if(name==='openlist_download_link'){
      assert.equal(args.path,nativeDest);
      return response(name,nativeDest,{permanent:true,expires_at:null,url:
        'https://openlist.lirtual.dpdns.org/api/p/'+nativeDest.slice(1)+'?sign=0.'+'a'.repeat(64)});
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
test('retained prior fixture permits a new isolated run without touching older files',async()=>{
  const previous = {name:'mcp-spec309-e2e-40447759574-1',is_dir:true};
  const {transport,requests}=fakeTransport({rootEntries:[previous]});
  const result=await runOpenListDriverAcceptance(env,transport);
  assert.equal(result.folder,folder.split('/').at(-1));
  assert.equal(requests.filter(x=>x==='upload').length,1);
  assert.equal(requests.filter(x=>x==='openlist_create_folder').length,2);
  assert.equal(requests.includes('openlist_delete'),false);
});

test('user data, foreign directories, or reused run ID prevent all writes',async()=>{
  for (const item of [
    {name:'existing.txt',is_dir:false},
    {name:'my-photos',is_dir:true},
    {name:folder.split('/').at(-1),is_dir:true},
    {name:'mcp-spec309-e2e-40447759574-1',is_dir:false},
    {name:'mcp-spec309-e2e-40447759574-1',is_dir:true,path:'/Koofr/Other/forged'},
  ]) {
    const {transport,requests}=fakeTransport({rootEntries:[item]});
    await assert.rejects(()=>runOpenListDriverAcceptance(env,transport),/root_not_isolated/);
    assert.deepEqual(requests,['openlist_list_files']);
  }
});

test('incomplete, excessive, or duplicate root metadata prevents writes',async()=>{
  for (const options of [
    {rootEntries:[],rootReportedTotal:101},
    {rootEntries:[{name:'mcp-spec309-e2e-40447759574-1',is_dir:true}],rootReportedTotal:2},
    {rootEntries:Array.from({length:2},()=>({name:'mcp-spec309-e2e-40447759574-1',is_dir:true}))},
  ]) {
    const {transport,requests}=fakeTransport(options);
    await assert.rejects(()=>runOpenListDriverAcceptance(env,transport),/root_not_isolated/);
    assert.deepEqual(requests,['openlist_list_files']);
  }
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
  for (const invalid of ['', ' ', ' bearer', 'bearer ', 'hello'+String.fromCharCode(13,10)+'world']) {
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

test('expanded native E2E requires a separate explicit opt-in and only mutates this run fixture',async()=>{
  const {transport,requests}=fakeTransport();
  const result=await runOpenListDriverAcceptance(
    {...env,OPENLIST_NATIVE_E2E_APPROVED:'true'},transport);
  assert.equal(result.folder,folder.split('/').at(-1));
  assert.deepEqual(result.tested.slice(6),[
    'upload_small','copy','rename','move','read_native_text',
    'signed_download_link','native_scope_denial']);
  assert.equal(requests.filter(x=>x==='upload').length,1);
  assert.equal(requests.filter(x=>x==='openlist_upload_small').length,1);
  assert.equal(requests.filter(x=>x==='openlist_copy').length,1);
  assert.equal(requests.filter(x=>x==='openlist_rename').length,1);
  assert.equal(requests.filter(x=>x==='openlist_move').length,2);
  assert.equal(requests.filter(x=>x==='signed_get').length,1);
  assert.equal(requests.includes('openlist_share_disable'),false);
  assert.equal(requests.includes('openlist_delete'),false);
});

test('native move error is classified without leaking payloads or replaying the write',async()=>{
  for (const c of [
    {status:'unknown',code:'UPSTREAM_UNCERTAIN',
      expected:'openlist_driver_e2e_openlist_move_unknown_upstream_uncertain'},
    {status:'not_executed',code:'UPSTREAM_REJECTED',
      expected:'openlist_driver_e2e_openlist_move_not_executed_upstream_rejected'},
    {status:'unknown',code:'SECRET_' + env.MCP_ACCESS_TOKEN,
      expected:'openlist_driver_e2e_openlist_move_unknown_unclassified'},
  ]) {
    const {transport,requests}=fakeTransport({nativeMoveError:c});
    await assert.rejects(
      ()=>runOpenListDriverAcceptance({...env,OPENLIST_NATIVE_E2E_APPROVED:'true'},transport),
      error=>{
        assert.equal(error.message,c.expected);
        assert.doesNotMatch(error.message,/synthetic-|Koofr|Never print|SECRET_/);
        assert.equal(error.message.includes('/api/'),false);
        return true;
      },
    );
    assert.equal(requests.filter(x=>x==='openlist_move').length,1);
    assert.equal(requests.filter(x=>x==='openlist_download_link').length,0);
    assert.equal(requests.filter(x=>x==='signed_get').length,0);
    assert.equal(requests.at(-1),'openlist_move');
  }
});

test('native approval alone never authorizes a live write without the existing fixture approval',async()=>{
  const {transport,requests}=fakeTransport();
  await assert.rejects(()=>runOpenListDriverAcceptance({
    ...env,OPENLIST_DRIVER_E2E_APPROVED:'false',OPENLIST_NATIVE_E2E_APPROVED:'true',
  },transport),/not_approved/);
  assert.deepEqual(requests,[]);
});

test('manual acceptance selection gate rejects empty, conflicting and non-main approvals before secrets',async()=>{
  const {readFile} = await import('node:fs/promises');
  const path = new URL('../.github/workflows/openlist-acceptance.yml',import.meta.url);
  const workflow=await readFile(path,'utf8');
  assert.match(workflow,/\n  selection-gate:\s*\n/);
  assert.match(workflow,/name: Validate exact manual approval selection \(no secrets\)/);
  assert.match(workflow,/CURRENT_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflow,/APPROVE_FIXTURE_WRITE: \$\{\{ inputs\.confirm_disposable_write \}\}/);
  assert.match(workflow,/APPROVE_NATIVE: \$\{\{ inputs\.confirm_native_tool_tests \}\}/);
  assert.match(workflow,/APPROVE_PORTAL: \$\{\{ inputs\.confirm_portal_registration \}\}/);
  assert.match(workflow,/\[\[ "\$CURRENT_REF" == "refs\/heads\/main" \]\] \|\| exit 1/);
  assert.match(workflow,/\[\[ "\$APPROVE_FIXTURE_WRITE" == "false" &&\s*"\$APPROVE_NATIVE" == "false" \]\] \|\| exit 1/);
  assert.match(workflow,/\[\[ "\$APPROVE_FIXTURE_WRITE" == "true" \]\] \|\| exit 1/);
  assert.match(workflow,/name: Live OpenList MCP \/ Koofr driver E2E \(no deploy\)\s*\n\s*needs: selection-gate/);
  assert.match(workflow,/name: Required checks before OpenList Portal registration\s*\n\s*needs: selection-gate/);
  assert.match(workflow,/name: Deny unapproved, conflicting or non-main dispatches/);
});
