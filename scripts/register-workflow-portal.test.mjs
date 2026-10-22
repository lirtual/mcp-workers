import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_TOOLS,portalServerMapping,buildPortalUpdate,attachWorkflowPortal,
} from './register-workflow-portal.mjs';

const host='https://workflow.lirtual.dpdns.org/mcp';
const oldServers=['sentry','apifox','ima','kdocs','database',
  'remote-control','ssh','github-actions','raindrop'];
const entry=(name)=>({
  server_id:name,on_behalf:false,default_disabled:false,
  updated_tools:[{name:name+'_read',enabled:true,server_description:'preserved remote description'},
    {name:name+'_danger',enabled:false,alias:'hidden'}],
});
const portal=()=>({
  id:'one-mcp',name:'One-MCP',hostname:'mcp.lirtual.dpdns.org',
  code_mode:'off',secure_web_gateway:true,description:'Private production portal',
  servers:oldServers.map(entry),
});
const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
  CLOUDFLARE_API_TOKEN:'secure-cloudflare-api-test',
  MCP_ACCESS_TOKEN:'secure-worker-bearer-test'};
const originalServer={id:'workflow',name:'Workflow',hostname:host,
  auth_type:'bearer',status:'ready',
  tools:EXPECTED_TOOLS.map(name=>({name}))};

test('keeps every old server, flags and tool enable/alias overrides',()=>{
  const source=portal();
  const built=buildPortalUpdate(source);
  assert.equal(built.servers.length,10);
  assert.deepEqual(built.servers.slice(0,9),source.servers.map(portalServerMapping));
  assert.deepEqual(built.servers.at(-1),{
    server_id:'workflow',on_behalf:false,default_disabled:false,
  });
  assert.deepEqual(source.servers.at(0).updated_tools[0].server_description,
    'preserved remote description');
  assert.equal(built.code_mode,'off');
  assert.equal(built.secure_web_gateway,true);
  assert.equal(built.description,source.description);
});
test('never accepts a renamed/replaced Portal or incomplete inventory',()=>{
  for(const mutation of [
    p=>{p.hostname='attacker.example';},
    p=>{p.name='not One-MCP';},
    p=>{p.servers=[];},
    p=>{p.servers[1].server_id='ima';},
  ]){
    const p=portal();mutation(p);
    assert.throws(()=>buildPortalUpdate(p),/portal_/);
  }
});
function fake(){
  let current=portal();
  let upstream;
  const requests=[];
  const res=(status,result)=>new Response(JSON.stringify({success:status<300,result}),
    {status,headers:{'content-type':'application/json'}});
  const send=async request=>{
    const tail=new URL(request.url).pathname.split('/access/ai-controls/mcp')[1];
    requests.push({method:request.method,tail});
    if(request.method==='GET'&&tail==='/portals/one-mcp')return res(200,current);
    if(request.method==='GET'&&tail==='/servers')
      return res(200,[...oldServers.map(id=>({id})),...(upstream?[upstream]:[])]);
    if(request.method==='POST'&&tail==='/servers'){
      const value=JSON.parse(await request.text());
      assert.equal(value.auth_credentials,env.MCP_ACCESS_TOKEN);
      upstream={...originalServer};
      return res(200,upstream);
    }
    if(request.method==='POST'&&tail==='/servers/workflow/sync')return res(200,{status:'ready'});
    if(request.method==='GET'&&tail==='/servers/workflow')return res(200,upstream);
    if(request.method==='PUT'&&tail==='/portals/one-mcp'){
      const value=JSON.parse(await request.text());
      assert.equal(value.name,'One-MCP');
      assert.equal(value.code_mode,'off');
      assert.deepEqual(value.servers.slice(0,9),portal().servers.map(portalServerMapping));
      current={...current,...value};
      return res(200,current);
    }
    return res(404,null);
  };
  return {send,requests,getPortal:()=>current};
}
test('one scoped registration and one Portal append, repeat safely',async()=>{
  const api=fake();
  assert.equal(await attachWorkflowPortal(env,api.send),true);
  assert.equal(api.requests.filter(x=>x.method==='POST'&&x.tail==='/servers').length,1);
  assert.equal(api.requests.filter(x=>x.method==='PUT').length,1);
  assert.equal(api.getPortal().servers.length,10);
  assert.equal(await attachWorkflowPortal(env,api.send),true);
  assert.equal(api.requests.filter(x=>x.method==='PUT').length,1);
  assert.equal(api.requests.filter(x=>x.method==='POST'&&x.tail==='/servers').length,1);
});
test('missing credential fails before any network request',async()=>{
  const api=fake();
  await assert.rejects(attachWorkflowPortal({...env,MCP_ACCESS_TOKEN:''},api.send),
    /portal_worker_token_missing/);
  assert.equal(api.requests.length,0);
});
test('denied Cloudflare access fails closed without changing Portal',async()=>{
  const api=fake();
  await assert.rejects(attachWorkflowPortal(env,async request=>
    new Response('blocked',{status:403})),/portal_get_http_403/);
  assert.equal(api.getPortal().servers.length,9);
});
