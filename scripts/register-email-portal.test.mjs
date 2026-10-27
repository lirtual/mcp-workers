import test from 'node:test';
import assert from 'node:assert/strict';
import { portalPlan, attachEmailPortal, EMAIL_TOOLS } from './register-email-portal.mjs';
const ids=['workflow','database','ima','raindrop','sentry','ssh','remote-control',
  'github-actions','git-guardian','kdocs','apifox'];
const initial=()=>({id:'one-mcp',name:'One-MCP',hostname:'mcp.lirtual.dpdns.org',
  code_mode:'opt_in',secure_web_gateway:false,
  servers:ids.map(server_id=>({server_id,updated_tools:[{name:'example',enabled:true}]}))});
const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'cloudflare-secret',MCP_ACCESS_TOKEN:'shared-secret'};
const accessApps=(withPolicies=true)=>{
  const policies=()=>[
    {id:'11111111-1111-4111-8111-111111111111',name:'WORKFLOWS',
      decision:'non_identity',reusable:true,precedence:1,
      include:[{service_token:{token_id:'fake'}}]},
    {id:'22222222-2222-4222-8222-222222222222',name:'Default Allow Rule',
      decision:'allow',reusable:true,precedence:2,
      include:[{email:{email:'example@invalid.test'}}]},
  ];
  return [{name:'One-MCP',type:'mcp_portal',domain:'mcp.lirtual.dpdns.org',
    policies:policies()},
    {name:'Email',type:'mcp',policies:withPolicies?policies():[]}];
};


test('Portal preparation preserves every existing mapping and refuses a wrong Portal',()=>{
  const p=initial();
  assert.deepEqual(portalPlan(p).servers,p.servers);
  assert.throws(()=>portalPlan({...p,hostname:'untrusted.invalid'}),/portal_identity_drift/);
  assert.throws(()=>portalPlan({...p,servers:[]}),/portal_existing_servers_missing/);
});

test('Email registration syncs live 13 tools and preserves Portal, including repeated run',async()=>{
  const portal=initial(); const originally=structuredClone(portal.servers);
  let server=null,created=0,puts=0,synced=0;let extras=false;
  const transport=async request=>{
    assert.equal(request.headers.get('authorization'),'Bearer cloudflare-secret');
    const path=new URL(request.url).pathname.split('/access/ai-controls/mcp')[1];
    const method=request.method;
    if(method==='GET'&&new URL(request.url).pathname.endsWith('/access/apps'))
      return Response.json({success:true,result:accessApps(),
        result_info:{total_pages:1}});
    let result;
    if(method==='GET'&&path==='/portals/one-mcp')result=structuredClone(portal);
    else if(method==='GET'&&path==='/servers')result=server?[...ids.map(id=>({id})),server]:ids.map(id=>({id}));
    else if(method==='POST'&&path==='/servers'){
      const body=await request.json();
      assert.equal(body.auth_credentials,'shared-secret');
      assert.equal(body.hostname,'https://email-mcp.lirtual.dpdns.org/mcp');
      created++;
      server={id:'email',hostname:body.hostname,auth_type:'bearer',status:'ready',
        tools:EMAIL_TOOLS.map(name=>({name}))};result={id:'email'};
    }else if(method==='POST'&&path==='/servers/email/sync'){synced++;result={status:'ready'};}
    else if(method==='GET'&&path==='/servers/email')result=structuredClone(server);
    else if(method==='PUT'&&path==='/portals/one-mcp'){
      const body=await request.json();puts++;
      assert.equal(body.code_mode,'opt_in');
      assert.equal(body.secure_web_gateway,false);
      portal.servers=body.servers;result=structuredClone(portal);
    }else{extras=true;throw Error('Unexpected route: '+method+' '+path);}
    return Response.json({success:true,result});
  };
  assert.equal(await attachEmailPortal(env,transport),true);
  assert.equal(await attachEmailPortal(env,transport),true);
  assert.equal(created,1);assert.equal(puts,1);assert.equal(synced,2);
  assert.equal(extras,false);
  assert.deepEqual(portal.servers.slice(0,originally.length),originally);
  assert.equal(portal.servers.at(-1).server_id,'email');
});

test('Unauthorized server, changed tool inventory, or missing token fails closed',async()=>{
  await assert.rejects(()=>attachEmailPortal({...env,MCP_ACCESS_TOKEN:''}),/portal_worker_token_missing/);
  const portal=initial();let mutated=false;
  const transport=async r=>{
    const path=new URL(r.url).pathname.split('/access/ai-controls/mcp')[1];
    if(r.method==='GET'&&path==='/portals/one-mcp')return Response.json({success:true,result:portal});
    if(r.method==='GET'&&path==='/servers')return Response.json({success:true,result:[...ids.map(id=>({id})),{id:'email',hostname:'https://email-mcp.lirtual.dpdns.org/mcp',auth_type:'bearer'}]});
    if(r.method==='POST'&&path==='/servers/email/sync')return Response.json({success:true,result:{status:'ready'}});
    if(r.method==='GET'&&path==='/servers/email')return Response.json({success:true,result:{id:'email',hostname:'https://email-mcp.lirtual.dpdns.org/mcp',auth_type:'bearer',status:'ready',tools:[{name:'account_list'}]}});
    if(r.method==='PUT')mutated=true;
    throw Error('unexpected request');
  };
  await assert.rejects(()=>attachEmailPortal(env,transport),/portal_email_tool_inventory_drift/);
  assert.equal(mutated,false);
});

test('missing Access policies block attaching synced Email server to One-MCP',async()=>{
  const portal=initial();let server=null,puts=0;
  const transport=async req=>{
    const path=new URL(req.url).pathname;
    if(req.method==='GET'&&path.endsWith('/access/apps'))
      return Response.json({success:true,result:accessApps(false),
        result_info:{total_pages:1}});
    const tail=path.split('/access/ai-controls/mcp')[1];
    if(req.method==='GET'&&tail==='/portals/one-mcp')
      return Response.json({success:true,result:portal});
    if(req.method==='GET'&&tail==='/servers')
      return Response.json({success:true,result:server?[...ids.map(id=>({id})),server]:
        ids.map(id=>({id}))});
    if(req.method==='POST'&&tail==='/servers'){
      server={id:'email',hostname:'https://email-mcp.lirtual.dpdns.org/mcp',
        auth_type:'bearer',status:'ready',tools:EMAIL_TOOLS.map(name=>({name}))};
      return Response.json({success:true,result:{id:'email'}});
    }
    if(req.method==='POST'&&tail==='/servers/email/sync')
      return Response.json({success:true,result:{status:'ready'}});
    if(req.method==='GET'&&tail==='/servers/email')
      return Response.json({success:true,result:server});
    if(req.method==='PUT'){puts++;throw Error('unexpected Portal write');}
    throw Error('unexpected API route');
  };
  await assert.rejects(()=>attachEmailPortal(env,transport),
    /portal_access_policy_missing/);
  assert.equal(puts,0);
  assert.deepEqual(portal.servers,initial().servers);
});
