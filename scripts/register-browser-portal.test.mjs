import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {attachBrowserPortal,BROWSER_TOOLS} from './register-browser-portal.mjs';
const ids=['workflow','database','ima','raindrop','sentry','ssh','remote-control','github-actions','git-guardian','kdocs','apifox','email','http','openlist'];
const newPortal=()=>({id:'one-mcp',name:'One-MCP',hostname:'mcp.lirtual.dpdns.org',code_mode:'opt_in',secure_web_gateway:false,servers:ids.map(server_id=>({server_id,default_disabled:false}))});
const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'cloudflare-fixture',MCP_ACCESS_TOKEN:'shared-fixture'};
const policies=[{id:'11111111-1111-4111-8111-111111111111',name:'WORKFLOWS',decision:'non_identity',reusable:true,precedence:1,include:[{service_token:{token_id:'fixture'}}]},{id:'22222222-2222-4222-8222-222222222222',name:'Default Allow Rule',decision:'allow',reusable:true,precedence:2,include:[{email:{email:'owner@invalid.test'}}]}];
const apps=(enabled=true)=>[{name:'One-MCP',type:'mcp_portal',domain:'mcp.lirtual.dpdns.org',policies},...(enabled?[{name:'Browser',type:'mcp',policies}]:[])];
test('the exact fixed 16 tools match public Browser MCP and five interaction actions',()=>{
  const source=readFileSync(new URL('../apps/browser-mcp-worker/src/worker.ts',import.meta.url),'utf8');
  const interactions=readFileSync(new URL('../apps/browser-mcp-worker/src/interactions.ts',import.meta.url),'utf8');
  const named=[...source.matchAll(/name:"(browser_[a-z_]+)"/g)].map(x=>x[1]);
  const actions=['click','fill','keypress','scroll','select'].map(x=>'browser_'+x);
  assert.match(interactions,/interactionActions = \["click","fill","keypress","scroll","select"\]/);
  assert.deepEqual([...new Set([...named,...actions])].sort(),BROWSER_TOOLS);
  assert.equal(BROWSER_TOOLS.length,16);
});
test('idempotent Browser registration preserves all existing One-MCP mappings and uses shared Bearer',async()=>{
  const portal=newPortal(),before=structuredClone(portal.servers);
  let browser=null,created=0,attached=0,synced=0;
  const transport=async req=>{
    assert.equal(req.headers.get('authorization'),'Bearer cloudflare-fixture');
    const url=new URL(req.url),path=url.pathname.split('/access/ai-controls/mcp')[1];
    if(req.method==='GET'&&url.pathname.endsWith('/access/apps'))return Response.json({success:true,result:apps(),result_info:{total_pages:1}});
    let result;
    if(req.method==='GET'&&path==='/portals/one-mcp')result=structuredClone(portal);
    else if(req.method==='GET'&&path==='/servers')result=[...ids.map(id=>({id})),...(browser?[browser]:[])];
    else if(req.method==='POST'&&path==='/servers'){
      const body=await req.json();assert.equal(body.id,'browser');assert.equal(body.auth_type,'bearer');
      assert.equal(body.hostname,'https://browser.lirtual.dpdns.org/mcp');assert.equal(body.auth_credentials,'shared-fixture');
      created++;browser={id:'browser',hostname:body.hostname,auth_type:'bearer',status:'ready',tools:BROWSER_TOOLS.map(name=>({name}))};result={id:'browser'};
    }else if(req.method==='POST'&&path==='/servers/browser/sync'){synced++;result={status:'ready'};}
    else if(req.method==='GET'&&path==='/servers/browser')result=structuredClone(browser);
    else if(req.method==='PUT'&&path==='/portals/one-mcp'){
      const body=await req.json();assert.equal(body.code_mode,'opt_in');assert.equal(body.secure_web_gateway,false);
      portal.servers=body.servers;attached++;result=structuredClone(portal);
    }else throw Error('unexpected fixture route '+req.method+' '+path);
    return Response.json({success:true,result});
  };
  assert.equal(await attachBrowserPortal(env,transport),true);
  assert.equal(await attachBrowserPortal(env,transport),true);
  assert.deepEqual(portal.servers.slice(0,before.length),before);
  assert.equal(portal.servers.at(-1).server_id,'browser');
  assert.deepEqual([created,attached,synced],[1,1,2]);
});
test('fail closed for absent Access, wrong tools, or missing shared Bearer',async()=>{
  await assert.rejects(()=>attachBrowserPortal({...env,MCP_ACCESS_TOKEN:''}),/portal_worker_token_missing/);
  for(const variant of ['no_access','wrong_tools']){
    const portal=newPortal();let attached=false;
    const transport=async req=>{
      const url=new URL(req.url),path=url.pathname.split('/access/ai-controls/mcp')[1];
      if(req.method==='GET'&&url.pathname.endsWith('/access/apps'))return Response.json({success:true,result:apps(false),result_info:{total_pages:1}});
      if(req.method==='PUT')attached=true;
      let result;
      if(req.method==='GET'&&path==='/portals/one-mcp')result=portal;
      else if(req.method==='GET'&&path==='/servers')result=[...ids.map(id=>({id})),{id:'browser',hostname:'https://browser.lirtual.dpdns.org/mcp',auth_type:'bearer'}];
      else if(req.method==='POST'&&path==='/servers/browser/sync')result={status:'ready'};
      else if(req.method==='GET'&&path==='/servers/browser')result={id:'browser',hostname:'https://browser.lirtual.dpdns.org/mcp',auth_type:'bearer',status:'ready',tools:(variant==='wrong_tools'?['bad']:BROWSER_TOOLS).map(name=>({name}))};
      else throw Error('unexpected fixture request');
      return Response.json({success:true,result});
    };
    await assert.rejects(()=>attachBrowserPortal(env,transport),variant==='wrong_tools'?/tool_inventory_drift/:/inventory_unverifiable|app_missing_or_ambiguous/);
    assert.equal(attached,false);
  }
});
