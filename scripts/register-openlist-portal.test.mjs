import test from 'node:test';
import assert from 'node:assert/strict';
import { attachOpenListPortal, OPENLIST_TOOLS } from './register-openlist-portal.mjs';

const ids = ['workflow','database','ima','raindrop','sentry','ssh','remote-control',
  'github-actions','git-guardian','kdocs','apifox','email','http'];
const portal = () => ({
  id:'one-mcp',name:'One-MCP',hostname:'mcp.lirtual.dpdns.org',
  code_mode:'opt_in',secure_web_gateway:false,
  servers:ids.map(server_id => ({server_id,updated_tools:[{name:'fixture',enabled:true}]})),
});
const accessApps = () => {
  const policy = () => [
    {id:'11111111-1111-4111-8111-111111111111',name:'WORKFLOWS',
      decision:'non_identity',reusable:true,precedence:1,
      include:[{service_token:{token_id:'fixture'}}]},
    {id:'22222222-2222-4222-8222-222222222222',name:'Default Allow Rule',
      decision:'allow',reusable:true,precedence:2,
      include:[{email:{email:'owner@example.invalid'}}]},
  ];
  return [{name:'One-MCP',type:'mcp_portal',domain:'mcp.lirtual.dpdns.org',policies:policy()},
    {name:'OpenList MCP',type:'mcp',policies:policy()}];
};
const accessReply = (apps=accessApps()) =>
  Response.json({success:true,result:apps,result_info:{total_pages:1}});
const env = {
  CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
  CLOUDFLARE_API_TOKEN:'synthetic-cloudflare-token',
  MCP_ACCESS_TOKEN:'synthetic-worker-bearer',
};
test('OpenList Portal is attached only after verified exact 13-tool inventory and preserves mappings', async () => {
  assert.deepEqual(OPENLIST_TOOLS, [
    'openlist_capabilities',
    'openlist_copy',
    'openlist_create_folder',
    'openlist_download_link',
    'openlist_get_file',
    'openlist_list_files',
    'openlist_move',
    'openlist_read_text',
    'openlist_rename',
    'openlist_search_files',
    'openlist_share_disable',
    'openlist_share_get',
    'openlist_upload_small',
    'openlist_delete','openlist_share_create','openlist_share_update',
    'openlist_share_enable','openlist_share_revoke',
  ].sort());
  const state = portal(), originally = structuredClone(state.servers);
  let server = null, created = 0, synced = 0, puts = 0;
  const transport = async request => {
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-cloudflare-token');
    const fullPath = new URL(request.url).pathname;
    if (request.method === 'GET' && fullPath.endsWith('/access/apps'))
      return accessReply();
    const path = fullPath.split('/access/ai-controls/mcp')[1];
    let result;
    if (request.method === 'GET' && path === '/portals/one-mcp') result = structuredClone(state);
    else if (request.method === 'GET' && path === '/servers')
      result = server ? [...ids.map(id => ({id})),server] : ids.map(id => ({id}));
    else if (request.method === 'POST' && path === '/servers') {
      const body = await request.json();
      assert.deepEqual({id:body.id,hostname:body.hostname,auth_type:body.auth_type,
        auth_credentials:body.auth_credentials}, {
        id:'openlist',hostname:'https://openlist-mcp-worker.aiyaya.workers.dev/mcp',
        auth_type:'bearer',auth_credentials:'synthetic-worker-bearer',
      });
      server = {id:'openlist',hostname:body.hostname,auth_type:'bearer',status:'ready',
        tools:OPENLIST_TOOLS.map(name => ({name}))};
      created++;result = {id:'openlist'};
    } else if (request.method === 'POST' && path === '/servers/openlist/sync') {
      synced++;result = {status:'ready'};
    } else if (request.method === 'GET' && path === '/servers/openlist') result = structuredClone(server);
    else if (request.method === 'PUT' && path === '/portals/one-mcp') {
      const body = await request.json();
      assert.deepEqual(body.servers.slice(0,originally.length),originally);
      assert.equal(body.code_mode,'opt_in');
      assert.equal(body.secure_web_gateway,false);
      puts++;state.servers = body.servers;result=structuredClone(state);
    } else throw Error('unexpected portal request: '+request.method+' '+path);
    return Response.json({success:true,result});
  };
  assert.equal(await attachOpenListPortal(env,transport),true);
  assert.equal(await attachOpenListPortal(env,transport),true);
  assert.equal(created,1);assert.equal(synced,2);assert.equal(puts,1);
  assert.deepEqual(state.servers.slice(0,originally.length),originally);
  assert.equal(state.servers.at(-1).server_id,'openlist');
});
test('unauthorized credential, renamed tools or mismatched existing hostname fail before Portal attachment', async () => {
  await assert.rejects(() => attachOpenListPortal({...env,MCP_ACCESS_TOKEN:''}),/portal_worker_token_missing/);
  for (const bad of ['inventory','stale-seven','origin']) {
    const state = portal();let wrote=false;
    const transport = async request => {
      const path = new URL(request.url).pathname.split('/access/ai-controls/mcp')[1];
      let result;
      if (request.method === 'GET' && path === '/portals/one-mcp') result=state;
      else if (request.method === 'GET' && path === '/servers')
        result=[...ids.map(id=>({id})),{id:'openlist',hostname:bad==='origin'?
          'https://evil.example/mcp':'https://openlist-mcp-worker.aiyaya.workers.dev/mcp',
          auth_type:'bearer'}];
      else if (request.method === 'POST' && path === '/servers/openlist/sync')
        result={status:'ready'};
      else if (request.method === 'GET' && path === '/servers/openlist')
        result={id:'openlist',status:'ready',auth_type:'bearer',
          hostname:'https://openlist-mcp-worker.aiyaya.workers.dev/mcp',
          tools:bad === 'stale-seven' ? [
            'openlist_capabilities','openlist_list_files','openlist_get_file',
            'openlist_search_files','openlist_read_text','openlist_share_get',
            'openlist_create_folder',
          ].map(name=>({name})) : [{name:'openlist_delete'}]};
      else if (request.method === 'PUT') {wrote=true;throw Error('not allowed');}
      else throw Error('unexpected route '+path);
      return Response.json({success:true,result});
    };
    await assert.rejects(() => attachOpenListPortal(env,transport),/portal_openlist_(?:tool_inventory|endpoint)_drift/);
    assert.equal(wrote,false);
  }
});

test('manual-release registration happens after deployed version readback and is never a PR deployment', async () => {
  const {readFile} = await import('node:fs/promises');
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url),'utf8');
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url),'utf8');
  assert.match(ci,/Verify OpenList Portal registration contract \(offline\)/);
  assert.match(ci,/node --test scripts\/register-openlist-portal\.test\.mjs/);
  assert.equal((release.match(/run: node scripts\/register-openlist-portal\.mjs/g) ?? []).length,1);
  const verify = release.indexOf('name: Verify exact active version and required production bindings');
  const deny = release.indexOf('name: Check unauthenticated MCP surface without credentials');
  const attach = release.indexOf('name: Register production OpenList MCP with existing One-MCP Portal');
  assert.ok(verify >= 0 && deny > verify && attach > deny);
  // A deployment can verify binding/read scope before separately approving
  // an expanded tool inventory in Portal. Human approval after live driver E2E is separate.
  assert.match(release,/openlist_portal_registration:\s*\n\s*description:.*live driver E2E/);
  assert.match(release,/openlist_portal_registration:[\s\S]*?type: boolean\s*\n\s*default: false/);
  assert.match(release.slice(attach,attach+400),
    /if: inputs.worker == 'openlist-mcp-worker' && inputs.openlist_portal_registration == true/);
  assert.match(release,/github\.event_name == 'workflow_dispatch'/);
  assert.match(release,/inputs\.deploy_to_production == true/);
});

test('missing Access policies block attaching the newly synced OpenList server', async()=>{
  const state = portal();
  let server=null, putCount=0;
  const transport=async request=>{
    const p = new URL(request.url).pathname;
    if(request.method==='GET'&&p.endsWith('/access/apps')){
      const apps=accessApps();apps[1].policies=[];
      return accessReply(apps);
    }
    const path=p.split('/access/ai-controls/mcp')[1];
    let result;
    if(request.method==='GET'&&path==='/portals/one-mcp')result=structuredClone(state);
    else if(request.method==='GET'&&path==='/servers')
      result=server?[{id:'workflow'},{id:'database'},{id:'ima'},{id:'raindrop'},
        {id:'sentry'},{id:'ssh'},{id:'remote-control'},{id:'github-actions'},
        {id:'git-guardian'},{id:'kdocs'},{id:'apifox'},{id:'email'},{id:'http'},server]:
        ids.map(id=>({id}));
    else if(request.method==='POST'&&path==='/servers'){
      server={id:'openlist',hostname:'https://openlist-mcp-worker.aiyaya.workers.dev/mcp',
        auth_type:'bearer',status:'ready',tools:OPENLIST_TOOLS.map(name=>({name}))};
      result={id:'openlist'};
    } else if(request.method==='POST'&&path==='/servers/openlist/sync')result={status:'ready'};
    else if(request.method==='GET'&&path==='/servers/openlist')result=server;
    else if(request.method==='PUT'){putCount++;throw Error('portal write forbidden');}
    else throw Error('unexpected API route');
    return Response.json({success:true,result});
  };
  await assert.rejects(()=>attachOpenListPortal(env,transport),/portal_access_policy_missing/);
  assert.equal(putCount,0);
  assert.deepEqual(state.servers,portal().servers);
});


test('Worker and Portal both stage exactly eighteen bounded operations with risk annotations', async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(
    new URL('../apps/openlist-mcp-worker/src/tools.ts',import.meta.url),'utf8');
  const registered=[...source.matchAll(/server\.registerTool\('([^']+)'/g)]
    .map(match=>match[1]).sort();
  assert.equal(registered.length,18,
    'candidate tool surface must remain exactly the reviewed 18');
  assert.equal(new Set(registered).size,registered.length);
  assert.deepEqual(registered,[...OPENLIST_TOOLS].sort(),
    'a Worker-only tool bypasses the vetted Portal inventory or vice versa');
  const gated=[
    'openlist_delete','openlist_share_create','openlist_share_update',
    'openlist_share_enable','openlist_share_revoke',
  ];
  for(const name of gated) {
    assert.ok(registered.includes(name),name+' must be in candidate inventory');
    const start=source.indexOf("server.registerTool('"+name+"'");
    const next=source.indexOf("server.registerTool('",start+1);
    const section=source.slice(start,next<0?undefined:next);
    assert.match(section,/destructiveHint:\s*true/,name+' risk annotation');
    assert.match(section,/annotations:\s*\{\s*\.\.\.annotationsWrite/,name+' write annotation');
    assert.doesNotMatch(section,/confirm_approved|confirmation_token|approval_secret/,
      'model-provided confirmation field must never be mistaken for trusted approval');
  }
  const shareDisable=source.slice(
    source.indexOf("server.registerTool('openlist_share_disable'"),
    source.indexOf("server.registerTool('openlist_upload_small'"));
  assert.match(shareDisable,/destructiveHint:\s*true/);
  assert.match(shareDisable,/readOnlyHint:\s*false|annotations:\s*\{\s*\.\.\.annotationsWrite/);
  const download=source.slice(
    source.indexOf("server.registerTool('openlist_download_link'"),
    source.indexOf("server.registerTool('openlist_share_disable'"));
  assert.match(download,/Permanently valid signatures \(link_expiration=0\) are rejected as NOT_SUPPORTED/);
  assert.match(download,/openWorldHint:\s*true/);
});
