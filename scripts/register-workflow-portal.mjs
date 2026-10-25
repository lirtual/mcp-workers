// Attach one already-deployed Workflow MCP to the existing Cloudflare One-MCP
// Portal. No Worker deploy or credential creation. Fail closed on drift.
// GitHub Actions supplies the existing Workflow Worker's MCP_ACCESS_TOKEN.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT='https://api.cloudflare.com/client/v4/accounts/';
const BASE='/access/ai-controls/mcp';
const ORIGIN='https://workflow.lirtual.dpdns.org/mcp';
const PORTAL_HOST='mcp.lirtual.dpdns.org';
export const EXPECTED_TOOLS=[
  'workflow_capabilities','workflow_action_list',
  'workflow_list','workflow_get','workflow_create','workflow_update',
  'workflow_validate','workflow_publish','workflow_pause','workflow_resume',
  'workflow_run','workflow_status','workflow_result',
].sort();

export function portalServerMapping(entry){
  assert.ok(entry && /^[a-z0-9-]{1,32}$/.test(entry.server_id),
    'portal_previous_mapping_invalid');
  const result={server_id:entry.server_id};
  for(const field of ['default_disabled','on_behalf']){
    if(entry[field]!==undefined){
      assert.equal(typeof entry[field],'boolean','portal_previous_mapping_invalid');
      result[field]=entry[field];
    }
  }
  for(const field of ['updated_tools','updated_prompts']){
    if(entry[field]!==undefined){
      assert.ok(Array.isArray(entry[field]),'portal_previous_mapping_invalid');
      result[field]=entry[field].map(item=>{
        assert.ok(typeof item.name==='string','portal_previous_mapping_invalid');
        const value={name:item.name};
        for(const prop of ['alias','description','enabled']){
          if(item[prop]!==undefined)value[prop]=item[prop];
        }
        return value;
      });
    }
  }
  return result;
}

// Cloudflare may canonicalize Portal server order on write. Identity and
// effective overrides must remain identical, but list positions need not.
export function assertSamePortalMappings(expected,actual){
  assert.equal(actual.length,expected.length,'portal_server_count_mismatch');
  const current=new Map(actual.map(entry=>[entry.server_id,entry]));
  assert.equal(current.size,actual.length,'portal_duplicate_server');
  for(const old of expected){
    assert.deepEqual(current.get(old.server_id),old,
      'portal_existing_mapping_changed');
  }
}

export function buildPortalUpdate(portal,server){
  assert.equal(portal?.id,'one-mcp','portal_identity_drift');
  assert.equal(portal?.hostname,PORTAL_HOST,'portal_identity_drift');
  assert.equal(portal?.name,'One-MCP','portal_identity_drift');
  assert.ok(Array.isArray(portal.servers) && portal.servers.length>=9,
    'portal_existing_servers_missing');
  const preserved=portal.servers.map(portalServerMapping);
  const ids=preserved.map(x=>x.server_id);
  assert.equal(new Set(ids).size,ids.length,'portal_duplicate_server');
  assert.ok(ids.includes('ima')&&ids.includes('database')&&ids.includes('raindrop'),
    'portal_existing_servers_missing');
  const duplicate=ids.includes('workflow');
  const servers=duplicate?preserved:[...preserved,{server_id:'workflow',
    on_behalf:false,default_disabled:false}];
  // Keep existing portal authentication/Code Mode/routing unchanged.
  return {name:portal.name,hostname:portal.hostname,
    ...(typeof portal.description==='string'?{description:portal.description}:{}),
    code_mode:portal.code_mode,secure_web_gateway:portal.secure_web_gateway,
    servers};
}

export async function attachWorkflowPortal(env,transport=fetch){
  const token=env.CLOUDFLARE_API_TOKEN,workerToken=env.MCP_ACCESS_TOKEN;
  const account=env.CLOUDFLARE_ACCOUNT_ID;
  assert.ok(/^[a-f0-9]{32}$/.test(account||''),'portal_account_invalid');
  assert.ok(typeof token==='string'&&token.length>0,'portal_admin_token_missing');
  assert.ok(typeof workerToken==='string'&&workerToken.length>0 &&
    !/\r|\n/.test(workerToken),'portal_worker_token_missing');
  const api=ROOT+account+BASE;
  const request=async(method,tail,body)=>{
    const res=await transport(new Request(api+tail,{
      method,redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{authorization:'Bearer '+token,
        accept:'application/json','content-type':'application/json',
        'user-agent':'mcp-workers-workflow-portal-registration'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    }));
    if(res.status<200||res.status>=300)
      throw Error('portal_'+method.toLowerCase()+'_http_'+res.status);
    let json;
    try{json=await res.json();}catch{throw Error('portal_invalid_json');}
    if(json?.success!==true||json.result==null)
      throw Error('portal_api_unavailable');
    return json.result;
  };
  const portal=await request('GET','/portals/one-mcp');
  const before=buildPortalUpdate(portal);
  const old=await request('GET','/servers');
  assert.ok(Array.isArray(old)&&old.length>=9,'portal_server_inventory_incomplete');
  let server=old.find(x=>x.id==='workflow');
  if(server){
    assert.equal(server.hostname,ORIGIN,'portal_server_identity_drift');
    assert.equal(server.auth_type,'bearer','portal_server_auth_drift');
  }else{
    server=await request('POST','/servers',{
      id:'workflow',name:'Workflow',hostname:ORIGIN,auth_type:'bearer',
      auth_credentials:workerToken,
      description:'Versioned owner-approved Workflow MCP (Workflow/MCP/GitHub registered Echo)',
    });
    assert.equal(server.id,'workflow','portal_server_creation_mismatch');
    console.log('WORKFLOW_PORTAL_SERVER_CREATED');
  }
  // Existing server credentials are immutable here: no automatic token
  // replacement or rotation of an already registered upstream.
  // Always sync on a registration run; stored metadata is not proof that
  // the existing bearer credential still authenticates upstream.
  const synced=await request('POST','/servers/workflow/sync');
  assert.equal(synced.status,'ready','portal_server_sync_failed');
  let details=await request('GET','/servers/workflow');
  for(let attempt=0;attempt<10&&details.status!=='ready';attempt++){
    await new Promise(done=>setTimeout(done,1000));
    details=await request('GET','/servers/workflow');
  }
  assert.equal(details.hostname,ORIGIN,'portal_server_identity_drift');
  assert.equal(details.auth_type,'bearer','portal_server_auth_drift');
  assert.equal(details.status,'ready','portal_server_not_ready');
  assert.deepEqual((details.tools||[]).map(x=>x.name).sort(),EXPECTED_TOOLS,
    'portal_server_tool_inventory_drift');
  console.log('WORKFLOW_PORTAL_TOOLS_SYNCED');
  // Re-read just before updating to guard against concurrent Portal edits.
  const fresh=await request('GET','/portals/one-mcp');
  const body=buildPortalUpdate(fresh,details);
  assertSamePortalMappings(before.servers,body.servers);
  if(!fresh.servers.some(x=>x.server_id==='workflow')){
    const updated=await request('PUT','/portals/one-mcp',body);
    assert.ok(updated.servers?.some(x=>x.server_id==='workflow'),
      'portal_attach_unconfirmed');
  }
  const final=await request('GET','/portals/one-mcp');
  const normalized=buildPortalUpdate(final,details);
  assertSamePortalMappings(before.servers,normalized.servers);
  assert.equal(normalized.servers.filter(x=>x.server_id==='workflow').length,1,
    'portal_attach_unconfirmed');
  assert.equal(normalized.servers.length,before.servers.length+
    (before.servers.some(x=>x.server_id==='workflow')?0:1),
    'portal_server_count_mismatch');
  assert.equal(final.code_mode,portal.code_mode,'portal_auth_mode_changed');
  assert.equal(final.secure_web_gateway,portal.secure_web_gateway,
    'portal_gateway_mode_changed');
  console.log('WORKFLOW_PORTAL_ATTACHED_OK: one-mcp, exact tools, unchanged previous servers');
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  attachWorkflowPortal(process.env).catch(error=>{
    const value=String(error?.message||'');
    const safe=/^portal_[a-z_]+(?:http_[1-5][0-9]{2})?$/.test(value);
    console.error('WORKFLOW_PORTAL_REGISTRATION_FAILED',safe?value:'portal_unavailable');
    process.exitCode=1;
  });
}
