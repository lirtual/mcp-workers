import test from 'node:test';
import assert from 'node:assert/strict';
import { portalPlan, attachHTTPPortal, HTTP_TOOLS } from './register-http-portal.mjs';
const ids=['workflow','database','ima','raindrop','sentry','ssh','remote-control',
  'github-actions','git-guardian','kdocs','apifox','email'];
const initial=()=>({id:'one-mcp',name:'One-MCP',hostname:'mcp.lirtual.dpdns.org',
  code_mode:'opt_in',secure_web_gateway:false,
  servers:ids.map(server_id=>({server_id,updated_tools:[{name:'example',enabled:true}]}))});
const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'cloudflare-secret',MCP_ACCESS_TOKEN:'shared-secret'};

test('Portal preparation preserves every existing mapping and refuses a wrong Portal',()=>{
  const p=initial();
  assert.deepEqual(portalPlan(p).servers,p.servers);
  assert.throws(()=>portalPlan({...p,hostname:'untrusted.invalid'}),/portal_identity_drift/);
  assert.throws(()=>portalPlan({...p,servers:[]}),/portal_existing_servers_missing/);
});

test('HTTP registration syncs one live tool and preserves Portal, including repeated run',async()=>{
  const portal=initial(); const originally=structuredClone(portal.servers);
  let server=null,created=0,puts=0,synced=0;let extras=false;
  const transport=async request=>{
    assert.equal(request.headers.get('authorization'),'Bearer cloudflare-secret');
    const path=new URL(request.url).pathname.split('/access/ai-controls/mcp')[1];
    const method=request.method;
    let result;
    if(method==='GET'&&path==='/portals/one-mcp')result=structuredClone(portal);
    else if(method==='GET'&&path==='/servers')result=server?[...ids.map(id=>({id})),server]:ids.map(id=>({id}));
    else if(method==='POST'&&path==='/servers'){
      const body=await request.json();
      assert.equal(body.auth_credentials,'shared-secret');
      assert.equal(body.hostname,'https://http-mcp-worker.aiyaya.workers.dev/mcp');
      created++;
      server={id:'http',hostname:body.hostname,auth_type:'bearer',status:'ready',
        tools:HTTP_TOOLS.map(name=>({name}))};result={id:'http'};
    }else if(method==='POST'&&path==='/servers/http/sync'){synced++;result={status:'ready'};}
    else if(method==='GET'&&path==='/servers/http')result=structuredClone(server);
    else if(method==='PUT'&&path==='/portals/one-mcp'){
      const body=await request.json();puts++;
      assert.equal(body.code_mode,'opt_in');
      assert.equal(body.secure_web_gateway,false);
      portal.servers=body.servers;result=structuredClone(portal);
    }else{extras=true;throw Error('Unexpected route: '+method+' '+path);}
    return Response.json({success:true,result});
  };
  assert.equal(await attachHTTPPortal(env,transport),true);
  assert.equal(await attachHTTPPortal(env,transport),true);
  assert.equal(created,1);assert.equal(puts,1);assert.equal(synced,2);
  assert.equal(extras,false);
  assert.deepEqual(portal.servers.slice(0,originally.length),originally);
  assert.equal(portal.servers.at(-1).server_id,'http');
});

test('Unauthorized server, changed tool inventory, or missing token fails closed',async()=>{
  await assert.rejects(()=>attachHTTPPortal({...env,MCP_ACCESS_TOKEN:''}),/portal_worker_token_missing/);
  const portal=initial();let mutated=false;
  const transport=async r=>{
    const path=new URL(r.url).pathname.split('/access/ai-controls/mcp')[1];
    if(r.method==='GET'&&path==='/portals/one-mcp')return Response.json({success:true,result:portal});
    if(r.method==='GET'&&path==='/servers')return Response.json({success:true,result:[...ids.map(id=>({id})),{id:'http',hostname:'https://http-mcp-worker.aiyaya.workers.dev/mcp',auth_type:'bearer'}]});
    if(r.method==='POST'&&path==='/servers/http/sync')return Response.json({success:true,result:{status:'ready'}});
    if(r.method==='GET'&&path==='/servers/http')return Response.json({success:true,result:{id:'http',hostname:'https://http-mcp-worker.aiyaya.workers.dev/mcp',auth_type:'bearer',status:'ready',tools:[{name:'account_list'}]}});
    if(r.method==='PUT')mutated=true;
    throw Error('unexpected request');
  };
  await assert.rejects(()=>attachHTTPPortal(env,transport),/portal_http_tool_inventory_drift/);
  assert.equal(mutated,false);
});
