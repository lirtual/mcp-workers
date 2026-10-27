// Register only the existing production Weixin Worker on One-MCP. No new Worker.
// GitHub Actions supplies the shared Repository MCP_ACCESS_TOKEN; never log it.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyMcpAccessPolicies } from './verify-mcp-access-policies.mjs';
import { portalServerMapping, assertSamePortalMappings } from './register-workflow-portal.mjs';

const ORIGIN = 'https://weixin-mcp.lirtual.dpdns.org/mcp';
export const WEIXIN_TOOLS = ['weixin_status','weixin_send_message'].sort();

export function portalPlan(portal) {
  assert.equal(portal?.id, 'one-mcp', 'portal_identity_drift');
  assert.equal(portal?.name, 'One-MCP', 'portal_identity_drift');
  assert.equal(portal?.hostname, 'mcp.lirtual.dpdns.org', 'portal_identity_drift');
  assert.ok(Array.isArray(portal.servers) && portal.servers.length >= 9,
    'portal_existing_servers_missing');
  const servers = portal.servers.map(portalServerMapping);
  const ids = servers.map(x=>x.server_id);
  assert.equal(new Set(ids).size, ids.length, 'portal_duplicate_server');
  for (const id of ['workflow','database','ima','raindrop'])
    assert.ok(ids.includes(id), 'portal_existing_servers_missing');
  return {name:portal.name,hostname:portal.hostname,
    ...(typeof portal.description==='string'?{description:portal.description}:{}),
    code_mode:portal.code_mode,secure_web_gateway:portal.secure_web_gateway,servers};
}

export async function attachWeixinPortal(env, transport=fetch) {
  const account=env.CLOUDFLARE_ACCOUNT_ID;
  const cfToken=env.CLOUDFLARE_API_TOKEN;
  const weixinToken=env.MCP_ACCESS_TOKEN;
  assert.match(account??'',/^[a-f0-9]{32}$/,'portal_account_invalid');
  assert.ok(typeof cfToken==='string'&&cfToken.length>0,'portal_admin_token_missing');
  assert.ok(typeof weixinToken==='string'&&weixinToken.length>0&&!/\r|\n/.test(weixinToken),
    'portal_worker_token_missing');
  const api='https://api.cloudflare.com/client/v4/accounts/'+account+'/access/ai-controls/mcp';
  const request=async(method,tail,body)=>{
    const res=await transport(new Request(api+tail,{
      method,redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{authorization:'Bearer '+cfToken,accept:'application/json',
        'content-type':'application/json','user-agent':'mcp-workers-weixin-portal-registration'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    }));
    if(!res.ok)throw Error('portal_'+method.toLowerCase()+'_http_'+res.status);
    let json;try{json=await res.json();}catch{throw Error('portal_invalid_json');}
    if(json?.success!==true||json.result==null)throw Error('portal_api_unavailable');
    return json.result;
  };
  const before=portalPlan(await request('GET','/portals/one-mcp'));
  assert.ok(!before.servers.some(x=>x.server_id==='weixin') ||
    before.servers.filter(x=>x.server_id==='weixin').length===1,'portal_duplicate_weixin');
  const existing=await request('GET','/servers');
  assert.ok(Array.isArray(existing)&&existing.length>=9,'portal_inventory_incomplete');
  let weixin=existing.find(x=>x.id==='weixin');
  if(weixin){
    assert.equal(weixin.hostname,ORIGIN,'portal_weixin_endpoint_drift');
    assert.equal(weixin.auth_type,'bearer','portal_weixin_auth_drift');
  }else{
    weixin=await request('POST','/servers',{
      id:'weixin',name:'Weixin',hostname:ORIGIN,auth_type:'bearer',
      auth_credentials:weixinToken,description:'Single-owner Weixin ClawBot MCP (#346)',
    });
    assert.equal(weixin.id,'weixin','portal_weixin_create_mismatch');
    console.log('WEIXIN_PORTAL_SERVER_CREATED');
  }
  // Sync confirms bearer auth and the exact live tool inventory, not just config.
  const synced=await request('POST','/servers/weixin/sync');
  assert.equal(synced.status,'ready','portal_weixin_sync_failed');
  let detail=await request('GET','/servers/weixin');
  for(let i=0;i<10&&detail.status!=='ready';i++){
    await new Promise(done=>setTimeout(done,1000));
    detail=await request('GET','/servers/weixin');
  }
  assert.equal(detail.status,'ready','portal_weixin_not_ready');
  assert.equal(detail.hostname,ORIGIN,'portal_weixin_endpoint_drift');
  assert.equal(detail.auth_type,'bearer','portal_weixin_auth_drift');
  assert.deepEqual((detail.tools??[]).map(x=>x.name).sort(),WEIXIN_TOOLS,
    'portal_weixin_tool_inventory_drift');
  await verifyMcpAccessPolicies(env,{id:'weixin',name:'Weixin'},transport);
  console.log('WEIXIN_ACCESS_POLICIES_VERIFIED');
  console.log('WEIXIN_PORTAL_TOOLS_SYNCED');
  const fresh=portalPlan(await request('GET','/portals/one-mcp'));
  assertSamePortalMappings(before.servers,fresh.servers);
  if(!fresh.servers.some(x=>x.server_id==='weixin')){
    const result=await request('PUT','/portals/one-mcp',{
      ...fresh,servers:[...fresh.servers,{server_id:'weixin',on_behalf:false,default_disabled:false}],
    });
    assert.ok(result.servers?.some(x=>x.server_id==='weixin'),'portal_weixin_attach_failed');
  }
  const after=portalPlan(await request('GET','/portals/one-mcp'));
  const priorIds=new Set(before.servers.map(x=>x.server_id));
  assertSamePortalMappings(before.servers,after.servers.filter(x=>priorIds.has(x.server_id)));
  assert.equal(after.servers.filter(x=>x.server_id==='weixin').length,1,
    'portal_weixin_attach_failed');
  assert.equal(after.servers.length,before.servers.length+
    (before.servers.some(x=>x.server_id==='weixin')?0:1),'portal_count_drift');
  assert.equal(after.code_mode,before.code_mode,'portal_code_mode_changed');
  assert.equal(after.secure_web_gateway,before.secure_web_gateway,'portal_gateway_mode_changed');
  console.log('WEIXIN_PORTAL_REGISTRATION_SUCCESS');
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  attachWeixinPortal(process.env).catch(error=>{
    const value=String(error?.message??'');
    const safe=/^portal_[a-z_]+(?:http_[1-5][0-9]{2})?$/.test(value);
    console.error('WEIXIN_PORTAL_REGISTRATION_FAILED',safe?value:'portal_unavailable');
    process.exitCode=1;
  });
}
