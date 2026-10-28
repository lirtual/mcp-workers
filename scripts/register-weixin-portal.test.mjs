import test from 'node:test';
import assert from 'node:assert/strict';
import {attachWeixinPortal, WEIXIN_TOOLS} from './register-weixin-portal.mjs';

const account='a'.repeat(32);
const env={CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:'fake-cloudflare',
  MCP_ACCESS_TOKEN:'fake-worker-bearer'};
const appIds=['6260cc46-4f44-4a95-a550-ad68ae4d0cfa',
  '3530fecd-7afa-4489-81f2-9e4a810a5c4d'];
const policies=()=>[
  {id:'7cec582c-4038-4fb0-9ad8-fcdb04af4adc',
    decision:'non_identity',reusable:true,precedence:1,
    include:[{service_token:{token_id:'synthetic'}}]},
  {id:'659d043c-e957-4c91-9f33-2416c52ecbe5',
    decision:'allow',reusable:true,precedence:2,
    include:[{email:{email:'one@example.invalid'}},
      {email:{email:'two@example.invalid'}},
      {email:{email:'three@example.invalid'}}]},
];
const previous=['workflow','database','ima','raindrop','sentry','ssh',
  'remote-control','github-actions','email','openlist'];
const basePortal=()=>({id:'one-mcp',name:'One-MCP',
  hostname:'mcp.lirtual.dpdns.org',code_mode:'opt_in',
  secure_web_gateway:false,servers:previous.map(server_id=>({
    server_id,on_behalf:false,default_disabled:false,
    updated_tools:[{name:'existing_tool',enabled:true,alias:'preserved'}],
  }))});
function mock({accessStatus=200,policyDrift=false}={}){
  let portal=basePortal(),weixin=null;
  const calls=[];
  const transport=async request=>{
    const path=new URL(request.url).pathname;
    calls.push({method:request.method,path});
    assert.equal(request.headers.get('authorization'),'Bearer fake-cloudflare');
    const appIdx=appIds.findIndex(id=>path.endsWith('/access/apps/'+id));
    if(appIdx>=0){
      if(accessStatus!==200)return new Response('blocked',{status:accessStatus});
      const policiesForApp=policies();
      if(policyDrift&&appIdx===1)policiesForApp[1].include=[{everyone:{}}];
      return Response.json({success:true,result:{
        name:appIdx===0?'One-MCP':'Weixin',
        type:appIdx===0?'mcp_portal':'mcp',
        ...(appIdx===0?{domain:'mcp.lirtual.dpdns.org'}:{}),
        policies:policiesForApp,
      }});
    }
    const tail=path.split('/access/ai-controls/mcp')[1];
    let result;
    if(request.method==='GET'&&tail==='/portals/one-mcp')
      result=structuredClone(portal);
    else if(request.method==='GET'&&tail==='/servers')
      result=[...previous.map(id=>({id})),...(weixin?[weixin]:[])];
    else if(request.method==='POST'&&tail==='/servers'){
      const body=await request.json();
      assert.deepEqual({id:body.id,hostname:body.hostname,auth_type:body.auth_type,
        auth_credentials:body.auth_credentials},{
        id:'weixin',hostname:'https://weixin-mcp.lirtual.dpdns.org/mcp',
        auth_type:'bearer',auth_credentials:'fake-worker-bearer'});
      weixin={id:'weixin',hostname:body.hostname,auth_type:'bearer',
        status:'ready',tools:WEIXIN_TOOLS.map(name=>({name}))};
      result={id:'weixin'};
    }else if(request.method==='POST'&&tail==='/servers/weixin/sync')
      result={status:'ready'};
    else if(request.method==='GET'&&tail==='/servers/weixin')
      result=structuredClone(weixin);
    else if(request.method==='PUT'&&tail==='/portals/one-mcp'){
      const value=await request.json();
      assert.equal(value.code_mode,'opt_in');
      assert.equal(value.secure_web_gateway,false);
      assert.deepEqual(value.servers.slice(0,previous.length),
        basePortal().servers);
      portal={...portal,...value};result=structuredClone(portal);
    }else throw Error('unexpected request: '+request.method+' '+path);
    return Response.json({success:true,result});
  };
  return {transport,calls,getPortal:()=>portal};
}

test('Weixin registration actually verifies both Access apps before mutation, then safely repeats',async()=>{
  const api=mock();
  assert.equal(await attachWeixinPortal(env,api.transport),true);
  assert.equal(await attachWeixinPortal(env,api.transport),true);
  assert.deepEqual(api.calls.slice(0,2).map(x=>x.path),
    appIds.map(id=>'/client/v4/accounts/'+account+'/access/apps/'+id));
  assert.equal(api.calls.filter(x=>x.method==='POST'&&x.path.endsWith('/servers')).length,1);
  assert.equal(api.calls.filter(x=>x.method==='PUT').length,1);
  assert.equal(api.getPortal().servers.length,previous.length+1);
  assert.deepEqual(api.getPortal().servers.slice(0,previous.length),
    basePortal().servers);
});
test('Access token with no Apps read permission aborts before any Portal request or write',async()=>{
  const api=mock({accessStatus:403});
  await assert.rejects(()=>attachWeixinPortal(env,api.transport),
    /portal_access_read_http_403/);
  assert.equal(api.calls.length,1);
  assert.equal(api.getPortal().servers.length,previous.length);
});
test('drifted owner Access policy rejects registration before Portal mutation',async()=>{
  const api=mock({policyDrift:true});
  await assert.rejects(()=>attachWeixinPortal(env,api.transport),
    /portal_access_policy_drift/);
  assert.equal(api.calls.length,2);
  assert.equal(api.getPortal().servers.length,previous.length);
});
