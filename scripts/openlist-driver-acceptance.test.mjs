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
  authEnv = env,nativeMoveError,staleUploadedListingReads = 0,failRefresh = false,
  permanentLink = true, rejectFinite = false} = {}) {
  const requests = [];
  let made = false, uploaded = false, deleted = false;
  let highShare = null;
  const highId='1234567890abcdef';
  const highPwd='b'.repeat(48);
  let publicReads=0;
  let staleReads = staleUploadedListingReads;
  const nativeSource = `${folder}/native-${env.GITHUB_RUN_ID}-1.txt`;
  const nativeDir = `${folder}/native-copies`;
  const nativeDest = `${nativeDir}/native-${env.GITHUB_RUN_ID}-1.txt`;
  const renamedDest = `${nativeDir}/renamed-${env.GITHUB_RUN_ID}-1.txt`;
  const nativeData = `OpenList native MCP E2E ${env.GITHUB_RUN_ID}-1\n`;
  const nativeFiles=new Map();
  const finiteExpiration = Math.floor(Date.now()/1000)+3600;
  const signature = (permanentLink ? '0' : String(finiteExpiration))+'.'+'a'.repeat(64);
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
    if(url.pathname === '/api/fs/list') {
      requests.push('refresh_listing');
      assert.equal(req.method,'POST');
      assert.equal(url.origin,'https://openlist.lirtual.dpdns.org');
      assert.equal(req.headers.get('authorization'),authEnv.OPENLIST_API_TOKEN);
      assert.deepEqual(await req.json(),{
        path:folder,page:1,per_page:100,refresh:true,
      });
      if(failRefresh) return Response.json({code:500,data:null},{status:500});
      assert.equal(uploaded,true);
      staleReads=0;
      return Response.json({code:200,data:{content:[
        {name:file.split('/').at(-1),is_dir:false}],total:1}});
    }
    if(url.pathname === '/api/fs/get' && req.headers.get('authorization')===null) {
      requests.push('public_share_get');
      assert.equal(req.method,'POST');
      const args=await req.json();
      assert.deepEqual(args,{path:'/@s/'+highId,password:highPwd});
      if(!highShare) return Response.json({code:404,message:'share not found'}, {status:404});
      if(highShare.disabled)return Response.json({code:400,
        message:'share has been disabled'},{status:400});
      publicReads++;
      return Response.json({code:200,data:{
        name:file.split('/').at(-1),size:new TextEncoder().encode(fixture).length,is_dir:false}});
    }
    if(url.pathname === '/api/fs/get') {
      requests.push('upstream_sign_check');
      assert.equal(req.method,'POST');
      assert.equal(url.origin,'https://openlist.lirtual.dpdns.org');
      assert.equal(req.headers.get('authorization'),authEnv.OPENLIST_API_TOKEN);
      assert.deepEqual(await req.json(),{path:nativeDest});
      return Response.json({code:200,data:{name:nativeDest.split('/').at(-1),
        path:nativeDest,is_dir:false,sign:signature}});
    }
    if(url.pathname.startsWith('/api/p/')) {
      requests.push('signed_get');
      assert.equal(req.method,'GET');
      assert.equal(url.origin,'https://openlist.lirtual.dpdns.org');
      assert.equal(req.headers.get('authorization'),null);
      assert.equal(url.pathname,'/api/p/'+nativeDest.slice(1));
      assert.equal(url.searchParams.get('sign'),signature);
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
      if(args.path===folder) {
        if(uploaded && staleReads > 0) {
          staleReads--;
          return response(name,args.path,{total:0,page:1,entries:[]});
        }
        return response(name,args.path,{
        total:uploaded?1:0,page:1,
        entries:uploaded?[{name:file.split('/').at(-1),is_dir:false,size:new TextEncoder().encode(fixture).length}]:[]});
      }
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
      if(args.path===file && deleted)
        return response(name,file,undefined,true,'NOT_FOUND');
      if(args.path===folder && made)
        return response(name,folder,{path:folder,name:folder.split('/').at(-1),is_dir:true});
      if(args.path===file && uploaded && !deleted)
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
    if(name==='openlist_delete') {
      if(args.path.startsWith('/__openlist_e2e_prohibited/'))
        return response(name,args.path,undefined,true,'OUT_OF_SCOPE');
      assert.equal(args.path,file);
      assert.equal(uploaded,true);
      assert.equal(deleted,false);
      deleted=true;
      return response(name,file,{deleted:true});
    }
    if(name==='openlist_share_create') {
      if(args.files[0]?.startsWith('/__openlist_e2e_prohibited/'))
        return response(name,args.files[0],undefined,true,'OUT_OF_SCOPE');
      assert.deepEqual(args,{files:[file],expires_hours:1,max_accessed:3});
      assert.equal(highShare,null);
      highShare={id:highId,files:[file],disabled:false,max_accessed:3,
        expires:'2026-10-28T13:00:00.000Z'};
      return response(name,highId,{...highShare,password_once:highPwd});
    }
    if(name==='openlist_share_get') {
      assert.ok([highId,'mcp_spec309_no_such_share'].includes(args.id));
      if(!highShare || args.id!==highId)return response(name,args.id,undefined,true,'NOT_FOUND');
      return response(name,highId,{...highShare});
    }
    if(name==='openlist_share_update') {
      if(args.id==='mcp_spec309_no_such_share')
        return response(name,args.id,undefined,true,'NOT_FOUND');
      assert.equal(args.id,highId);
      assert.equal(args.expires_hours,2);
      assert.equal(args.max_accessed,4);
      highShare={...highShare,max_accessed:4,expires:'2026-10-28T14:00:00.000Z'};
      return response(name,highId,{...highShare});
    }
    if(name==='openlist_share_disable') {
      assert.equal(args.id,highId);
      assert.equal(highShare.disabled,false);
      highShare={...highShare,disabled:true};
      return response(name,highId,{disabled:true});
    }
    if(name==='openlist_share_enable') {
      assert.equal(args.id,highId);
      assert.equal(highShare.disabled,true);
      highShare={...highShare,disabled:false};
      return response(name,highId,{disabled:false});
    }
    if(name==='openlist_share_revoke') {
      assert.equal(args.id,highId);
      assert.ok(highShare);
      highShare=null;
      return response(name,highId,{revoked:true});
    }
    if(name==='openlist_download_link'){
      assert.equal(args.path,nativeDest);
      if(permanentLink || rejectFinite)
        return response(name,nativeDest,null,true,'NOT_SUPPORTED');
      return response(name,nativeDest,{permanent:false,
        expires_at:new Date(finiteExpiration*1000).toISOString(),
        url:'https://openlist.lirtual.dpdns.org/api/p/'+nativeDest.slice(1)+'?sign='+signature});
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
test('cached empty listing triggers one read-only refresh, not a second upload',async()=>{
  const {transport,requests}=fakeTransport({staleUploadedListingReads:8});
  const result=await runOpenListDriverAcceptance(env,transport);
  assert.equal(result.folder,folder.split('/').at(-1));
  assert.equal(requests.filter(x=>x==='upload').length,1);
  assert.equal(requests.filter(x=>x==='refresh_listing').length,1);
  assert.equal(requests.filter(x=>x==='openlist_list_files').length,4);
  assert.equal(requests.filter(x=>x==='openlist_create_folder').length,2);
});

test('failed read-only refresh stops before any native write and is never retried',async()=>{
  const {transport,requests}=fakeTransport({
    staleUploadedListingReads:8,failRefresh:true,
  });
  await assert.rejects(()=>runOpenListDriverAcceptance(env,transport),
    /openlist_driver_e2e_file_listing_refresh_unknown/);
  assert.equal(requests.filter(x=>x==='upload').length,1);
  assert.equal(requests.filter(x=>x==='refresh_listing').length,1);
  assert.equal(requests.filter(x=>x==='openlist_upload_small').length,0);
  assert.equal(requests.at(-1),'refresh_listing');
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
    'permanent_signed_link_refused','native_scope_denial']);
  assert.equal(requests.filter(x=>x==='upload').length,1);
  assert.equal(requests.filter(x=>x==='openlist_upload_small').length,1);
  assert.equal(requests.filter(x=>x==='openlist_copy').length,1);
  assert.equal(requests.filter(x=>x==='openlist_rename').length,1);
  assert.equal(requests.filter(x=>x==='openlist_move').length,2);
  assert.equal(requests.filter(x=>x==='signed_get').length,0);
  assert.equal(requests.filter(x=>x==='upstream_sign_check').length,1);
  assert.equal(requests.includes('openlist_share_disable'),false);
  assert.equal(requests.includes('openlist_delete'),false);
});

test('high-risk manual E2E is first-attempt only and runs only on newly created synthetic file/share',async()=>{
  const {transport,requests}=fakeTransport();
  const result=await runOpenListDriverAcceptance({
    ...env,OPENLIST_HIGH_RISK_E2E_APPROVED:'true'},transport);
  assert.equal(result.tested.includes('single_file_delete'),true);
  assert.equal(requests.filter(x=>x==='openlist_share_create').length,2);
  assert.equal(requests.filter(x=>x==='openlist_share_update').length,2);
  assert.equal(requests.filter(x=>x==='openlist_share_disable').length,1);
  assert.equal(requests.filter(x=>x==='openlist_share_enable').length,1);
  assert.equal(requests.filter(x=>x==='openlist_share_revoke').length,1);
  assert.equal(requests.filter(x=>x==='openlist_delete').length,2);
  assert.equal(requests.filter(x=>x==='public_share_get').length,3);
});
test('high-risk manual E2E refuses replay and conflicting native approval without network',async()=>{
  for(const overrides of [
    {GITHUB_RUN_ATTEMPT:'2'},
    {OPENLIST_NATIVE_E2E_APPROVED:'true'},
    {OPENLIST_DRIVER_E2E_APPROVED:'false'},
  ]){
    const {transport,requests}=fakeTransport();
    await assert.rejects(runOpenListDriverAcceptance({
      ...env,OPENLIST_HIGH_RISK_E2E_APPROVED:'true',...overrides},transport),
      /openlist_driver_e2e_high_risk_approval_invalid|openlist_driver_e2e_not_approved/);
    assert.equal(requests.length,0);
  }
});
test('native signed-link E2E still fetches and verifies finite-expiry URL when upstream issues it',async()=>{
  const {transport,requests}=fakeTransport({permanentLink:false});
  const result=await runOpenListDriverAcceptance(
    {...env,OPENLIST_NATIVE_E2E_APPROVED:'true'},transport);
  assert.ok(result.tested.includes('finite_signed_download_link'));
  assert.equal(requests.filter(x=>x==='signed_get').length,1);
  assert.equal(requests.filter(x=>x==='upstream_sign_check').length,0);
});

test('native E2E does not confuse unrelated NOT_SUPPORTED with permanent-link policy refusal',async()=>{
  const {transport,requests}=fakeTransport({permanentLink:false,rejectFinite:true});
  await assert.rejects(runOpenListDriverAcceptance(
    {...env,OPENLIST_NATIVE_E2E_APPROVED:'true'},transport),
    /openlist_driver_e2e_native_link_policy_unverified/);
  assert.equal(requests.filter(x=>x==='upstream_sign_check').length,1);
  assert.equal(requests.filter(x=>x==='signed_get').length,0);
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
