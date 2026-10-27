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
const env = {
  CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
  CLOUDFLARE_API_TOKEN:'synthetic-cloudflare-token',
  MCP_ACCESS_TOKEN:'synthetic-worker-bearer',
};
test('OpenList Portal is attached only after verified exact 6-tool inventory and preserves mappings', async () => {
  const state = portal(), originally = structuredClone(state.servers);
  let server = null, created = 0, synced = 0, puts = 0;
  const transport = async request => {
    assert.equal(request.headers.get('authorization'), 'Bearer synthetic-cloudflare-token');
    const path = new URL(request.url).pathname.split('/access/ai-controls/mcp')[1];
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
  for (const bad of ['inventory','origin']) {
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
          tools:[{name:'openlist_delete'}]};
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
  assert.match(release.slice(attach,attach+300),/if: inputs.worker == 'openlist-mcp-worker'/);
  assert.match(release,/github\.event_name == 'workflow_dispatch'/);
  assert.match(release,/inputs\.deploy_to_production == true/);
});
