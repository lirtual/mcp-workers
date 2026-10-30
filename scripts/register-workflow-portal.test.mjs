import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_TOOLS,portalServerMapping,buildPortalUpdate,
  assertSamePortalMappings,attachWorkflowPortal,
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
const publishedTools=[
  'workflow_capabilities','workflow_action_list',
  'workflow_list','workflow_get','workflow_create','workflow_update',
  'workflow_validate','workflow_publish','workflow_approval','workflow_pause',
  'workflow_delete','workflow_resume','workflow_run','workflow_cancel',
  'workflow_status','workflow_result','workflow_session_data_get',
].sort();
const originalServer={id:'workflow',name:'Workflow',hostname:host,
  auth_type:'bearer',status:'ready',
  tools:EXPECTED_TOOLS.map(name=>({name}))};

test('exact Portal tool contract includes all 17 published Workflow tools',()=>{
  assert.deepEqual(EXPECTED_TOOLS,publishedTools);
});

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
function accessApplications(name, withPolicies=true){
  const policies=()=>[
    {id:'11111111-1111-4111-8111-111111111111',name:'WORKFLOWS',
      decision:'non_identity',precedence:1,reusable:true,
      include:[{service_token:{token_id:'fixture'}}]},
    {id:'22222222-2222-4222-8222-222222222222',name:'Default Allow Rule',
      decision:'allow',precedence:2,reusable:true,
      include:[{email:{email:'fixture@example.invalid'}}]},
  ];
  return [{name:'One-MCP',type:'mcp_portal',domain:'mcp.lirtual.dpdns.org',policies:policies()},
    {name, type:'mcp',policies:withPolicies?policies():[]}];
}
function fake(expectedToken=env.MCP_ACCESS_TOKEN,withPolicies=true,
  toolNames=EXPECTED_TOOLS){
  let current=portal();
  let upstream;
  const requests=[];
  const res=(status,result)=>new Response(JSON.stringify({success:status<300,result}),
    {status,headers:{'content-type':'application/json'}});
  const send=async request=>{
    const tail=new URL(request.url).pathname.split('/access/ai-controls/mcp')[1];
    requests.push({method:request.method,tail});
    if(request.method==='GET' &&
       new URL(request.url).pathname.endsWith('/access/apps'))
      return Response.json({success:true,
        result:accessApplications('Workflow',withPolicies),
        result_info:{total_pages:1}});

    if(request.method==='GET'&&tail==='/portals/one-mcp')return res(200,current);
    if(request.method==='GET'&&tail==='/servers')
      return res(200,[...oldServers.map(id=>({id})),...(upstream?[upstream]:[])]);
    if(request.method==='POST'&&tail==='/servers'){
      const value=JSON.parse(await request.text());
      assert.equal(value.auth_credentials,expectedToken);
      upstream={...originalServer,tools:toolNames.map(name=>({name}))};
      return res(200,upstream);
    }
    if(request.method==='POST'&&tail==='/servers/workflow/sync')return res(200,{status:'ready'});
    if(request.method==='GET'&&tail==='/servers/workflow')return res(200,upstream);
    if(request.method==='PUT'&&tail==='/portals/one-mcp'){
      const value=JSON.parse(await request.text());
      assert.equal(value.name,'One-MCP');
      assert.equal(value.code_mode,'off');
      assert.deepEqual(value.servers.slice(0,9),portal().servers.map(portalServerMapping));
      // Cloudflare reorders server entries after the PUT, although
      // each per-server mapping and enabled flag is preserved.
      const reordered=[...value.servers];
      const added=reordered.pop();
      reordered.splice(3,0,added);
      current={...current,...value,servers:reordered};
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
test('comparison ignores ordering but rejects altered capability settings',()=>{
  const original=portal().servers.map(portalServerMapping);
  const reordered=[original[3],...original.slice(0,3),...original.slice(4)];
  assert.doesNotThrow(()=>assertSamePortalMappings(original,reordered));
  const altered=structuredClone(reordered);
  altered[0].updated_tools[1].enabled=true;
  assert.throws(()=>assertSamePortalMappings(original,altered),/portal_existing_mapping_changed/);
});

test('rejects missing or unknown upstream tools without changing Portal',async()=>{
  for(const toolNames of [
    publishedTools.filter(name=>name!=='workflow_delete'),
    [...publishedTools,'unexpected_tool'],
  ]){
    const api=fake(env.MCP_ACCESS_TOKEN,true,toolNames);
    await assert.rejects(
      ()=>attachWorkflowPortal(env,api.send),
      /portal_server_tool_inventory_drift/);
    assert.equal(api.requests.filter(x=>x.method==='PUT').length,0);
    assert.equal(api.getPortal().servers.length,9);
  }
});

test('missing credential fails before any network request',async()=>{
  for(const bad of ['',undefined]){
    const api=fake();
    await assert.rejects(attachWorkflowPortal({...env,MCP_ACCESS_TOKEN:bad},api.send),
      /portal_worker_token_missing/);
    assert.equal(api.requests.length,0);
  }
});
test('short existing bearer is allowed only after real upstream sync',async()=>{
  const api=fake('x');
  assert.equal(await attachWorkflowPortal({...env,MCP_ACCESS_TOKEN:'x'},api.send),true);
  assert.equal(api.getPortal().servers.length,10);
});
test('denied Cloudflare access fails closed without changing Portal',async()=>{
  const api=fake();
  await assert.rejects(attachWorkflowPortal(env,async request=>
    new Response('blocked',{status:403})),/portal_get_http_403/);
  assert.equal(api.getPortal().servers.length,9);
});

test('Workflow Portal attachment fails before PUT when Access policies are missing',async()=>{
  const api=fake(env.MCP_ACCESS_TOKEN,false);
  await assert.rejects(
    ()=>attachWorkflowPortal(env,api.send),
    /portal_access_policy_missing/);
  assert.equal(api.requests.filter(x=>x.method==='PUT').length,0);
  assert.equal(api.getPortal().servers.length,9);
});
