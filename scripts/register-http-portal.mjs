// Register only the existing production HTTP Worker on One-MCP. No new Worker.
// GitHub Actions supplies the shared Repository MCP_ACCESS_TOKEN; never log it.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { portalServerMapping, assertSamePortalMappings } from './register-workflow-portal.mjs';

const ORIGIN = 'https://http-mcp-worker.aiyaya.workers.dev/mcp';
export const HTTP_TOOLS = ['http_request'].sort();

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

export async function attachHTTPPortal(env, transport=fetch) {
  const account=env.CLOUDFLARE_ACCOUNT_ID;
  const cfToken=env.CLOUDFLARE_API_TOKEN;
  const httpToken=env.MCP_ACCESS_TOKEN;
  assert.match(account??'',/^[a-f0-9]{32}$/,'portal_account_invalid');
  assert.ok(typeof cfToken==='string'&&cfToken.length>0,'portal_admin_token_missing');
  assert.ok(typeof httpToken==='string'&&httpToken.length>0&&!/\r|\n/.test(httpToken),
    'portal_worker_token_missing');
  const api='https://api.cloudflare.com/client/v4/accounts/'+account+'/access/ai-controls/mcp';
  const request=async(method,tail,body)=>{
    const res=await transport(new Request(api+tail,{
      method,redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{authorization:'Bearer '+cfToken,accept:'application/json',
        'content-type':'application/json','user-agent':'mcp-workers-http-portal-registration'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    }));
    if(!res.ok)throw Error('portal_'+method.toLowerCase()+'_http_'+res.status);
    let json;try{json=await res.json();}catch{throw Error('portal_invalid_json');}
    if(json?.success!==true||json.result==null)throw Error('portal_api_unavailable');
    return json.result;
  };
  const before=portalPlan(await request('GET','/portals/one-mcp'));
  assert.ok(!before.servers.some(x=>x.server_id==='http') ||
    before.servers.filter(x=>x.server_id==='http').length===1,'portal_duplicate_http');
  const existing=await request('GET','/servers');
  assert.ok(Array.isArray(existing)&&existing.length>=9,'portal_inventory_incomplete');
  let http=existing.find(x=>x.id==='http');
  if(http){
    assert.equal(http.hostname,ORIGIN,'portal_http_endpoint_drift');
    assert.equal(http.auth_type,'bearer','portal_http_auth_drift');
  }else{
    http=await request('POST','/servers',{
      id:'http',name:'HTTP',hostname:ORIGIN,auth_type:'bearer',
      auth_credentials:httpToken,description:'Production public HTTP(S) MCP (#303)',
    });
    assert.equal(http.id,'http','portal_http_create_mismatch');
    console.log('HTTP_PORTAL_SERVER_CREATED');
  }
  // Sync confirms bearer auth and the exact live tool inventory, not just config.
  const synced=await request('POST','/servers/http/sync');
  assert.equal(synced.status,'ready','portal_http_sync_failed');
  let detail=await request('GET','/servers/http');
  for(let i=0;i<10&&detail.status!=='ready';i++){
    await new Promise(done=>setTimeout(done,1000));
    detail=await request('GET','/servers/http');
  }
  assert.equal(detail.status,'ready','portal_http_not_ready');
  assert.equal(detail.hostname,ORIGIN,'portal_http_endpoint_drift');
  assert.equal(detail.auth_type,'bearer','portal_http_auth_drift');
  assert.deepEqual((detail.tools??[]).map(x=>x.name).sort(),HTTP_TOOLS,
    'portal_http_tool_inventory_drift');
  console.log('HTTP_PORTAL_TOOLS_SYNCED');
  const fresh=portalPlan(await request('GET','/portals/one-mcp'));
  assertSamePortalMappings(before.servers,fresh.servers);
  if(!fresh.servers.some(x=>x.server_id==='http')){
    const result=await request('PUT','/portals/one-mcp',{
      ...fresh,servers:[...fresh.servers,{server_id:'http',on_behalf:false,default_disabled:false}],
    });
    assert.ok(result.servers?.some(x=>x.server_id==='http'),'portal_http_attach_failed');
  }
  const after=portalPlan(await request('GET','/portals/one-mcp'));
  const priorIds=new Set(before.servers.map(x=>x.server_id));
  assertSamePortalMappings(before.servers,after.servers.filter(x=>priorIds.has(x.server_id)));
  assert.equal(after.servers.filter(x=>x.server_id==='http').length,1,
    'portal_http_attach_failed');
  assert.equal(after.servers.length,before.servers.length+
    (before.servers.some(x=>x.server_id==='http')?0:1),'portal_count_drift');
  assert.equal(after.code_mode,before.code_mode,'portal_code_mode_changed');
  assert.equal(after.secure_web_gateway,before.secure_web_gateway,'portal_gateway_mode_changed');
  console.log('HTTP_PORTAL_REGISTRATION_SUCCESS');
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  attachHTTPPortal(process.env).catch(error=>{
    const value=String(error?.message??'');
    const safe=/^portal_[a-z_]+(?:http_[1-5][0-9]{2})?$/.test(value);
    console.error('HTTP_PORTAL_REGISTRATION_FAILED',safe?value:'portal_unavailable');
    process.exitCode=1;
  });
}
