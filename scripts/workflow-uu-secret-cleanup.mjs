// Spec #774: scoped, read-only guards for a separately approved UU Secret
// versioned Prepare/Publish. No Secret values, Cloudflare writes or deploys.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {verifyWorkflowQuiet} from './legacy-secret-cleanup.mjs';

const fail=msg=>{throw Error('UU Secret cleanup blocked: '+msg);};
const check=(v,msg)=>{if(!v)fail(msg);};
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const TARGET='WORKFLOW_SESSION_RUNTIME_DATA_KEY';
const D1_ID='a4a477cd-6339-478c-ab7c-f7d87bb0d772';
// Spec #774 recovery is intentionally limited to the single reviewed pair.
const RESTORE_FROM='3f27e9ca-790c-4ec9-914e-cb4204a736e6';
const RESTORE_TO='414da2d7-a16f-4ce6-9350-013ad4f7166a';

const expected=new Map([
  ['ACTIONS','service'],['DB','d1'],['WORKFLOW','workflow'],
  ['MCP_ACCESS_TOKEN','secret_text'],['WORKFLOW_GITHUB_DISPATCH_TOKEN','secret_text'],
  ['WORKFLOW_MCP_PORTAL_CLIENT_SECRET','secret_text'],[TARGET,'secret_text'],
  ['WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES','plain_text'],
  ['WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE','plain_text'],
  ['WORKFLOW_MCP_PORTAL_CLIENT_ID','plain_text'],['WORKFLOW_MCP_PORTAL_ENDPOINT','plain_text'],
]);
const stable=x=>JSON.stringify(x,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)
  ?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const index=bs=>{
  check(Array.isArray(bs),'Worker bindings missing');
  const x=new Map();
  for(const b of bs){check(b&&typeof b.name==='string'&&typeof b.type==='string'&&!x.has(b.name),'duplicate or invalid binding');x.set(b.name,b);}
  return x;
};
const signature=bs=>bs.map(b=>[b.name,b.type]).sort(([a],[b])=>a.localeCompare(b));
const inventory=bs=>bs.filter(b=>b.type==='secret_text').map(b=>b.name).sort();
const protectedResource=(r,drop)=>{
  const copy={...r,bindings:r.bindings.filter(b=>!drop||b.name!==TARGET)
    .map(b=>b.type==='secret_text'?{name:b.name,type:b.type}:b)
    .sort((a,b)=>a.name.localeCompare(b.name))};
  return stable(copy);
};
export function verifyUuSecretRequest({phase,sourceSha,expectedSha,activeVersion,candidateVersion}){
  check(['prepare','publish'].includes(phase),'unsupported phase');
  check(SHA.test(expectedSha??'')&&sourceSha===expectedSha,'Owner-reviewed source SHA differs');
  check(UUID.test(activeVersion??''),'fixed active Worker version required');
  if(phase==='prepare')check(!candidateVersion,'Prepare cannot accept candidate');
  else check(UUID.test(candidateVersion??'')&&candidateVersion!==activeVersion,'independent candidate required');
  return true;
}
export function verifyUuSecretCandidate(baseline,candidate){
  check(UUID.test(baseline?.id??'')&&UUID.test(candidate?.id??'')&&baseline.id!==candidate.id&&
    Number.isInteger(baseline.number)&&Number.isInteger(candidate.number)&&candidate.number>baseline.number,
    'candidate version number or identity differs');
  const before=index(baseline.resources?.bindings);
  const after=index(candidate.resources?.bindings);
  check(before.size===expected.size&&after.size===before.size-1&&!after.has(TARGET),
    'candidate must remove exactly one UU binding');
  for(const [name,type] of expected)check(before.get(name)?.type===type,'baseline binding inventory drift: '+name);
  check((before.get('DB')?.id||before.get('DB')?.database_id)===D1_ID,'D1 source identity differs');
  check(protectedResource(baseline.resources,true)===protectedResource(candidate.resources,false),
    'candidate changes retained Worker resources or script');
  return true;
}
export function verifyUuSecretInventory({baseline,candidate,deployment,settings,inventory:secrets,phase}){
  const rows=deployment?.deployments;
  check(Array.isArray(rows)&&rows.length===1&&rows[0]?.versions?.length===1&&
    rows[0].versions[0].percentage===100&&rows[0].versions[0].version_id===baseline.id,
    'reviewed Worker is not the unique 100% active baseline');
  const before=index(baseline.resources?.bindings);
  check(before.size===expected.size,'active Worker resource inventory changed');
  for(const [name,type] of expected)check(before.get(name)?.type===type,'active Worker binding changed: '+name);
  check((before.get('DB')?.id||before.get('DB')?.database_id)===D1_ID,'active Worker D1 differs');
  const latest=phase==='prepare'?baseline:candidate;
  check(latest,'latest Worker candidate unavailable');
  if(phase==='publish')verifyUuSecretCandidate(baseline,candidate);
  const actual=index(settings?.bindings);
  check(stable(signature([...actual.values()]))===stable(signature(latest.resources.bindings)),
    'latest Worker Settings differ from version binding inventory');
  check(Array.isArray(secrets)&&new Set(secrets.map(x=>x.name)).size===secrets.length&&
    stable(secrets.map(x=>x.name).sort())===stable(inventory(latest.resources.bindings)),
    'latest Worker Secret names differ from version');
  return true;
}
export function verifyUuSecretRestoreRequest({phase,sourceSha,expectedSha,activeVersion,candidateVersion}){
  check(phase==='restore'&&SHA.test(expectedSha??'')&&sourceSha===expectedSha,
    'restore requires independently reviewed current main SHA');
  check(activeVersion===RESTORE_FROM&&candidateVersion===RESTORE_TO,
    'restore is limited to Version 143 -> Version 142');
  return true;
}
export function verifyUuSecretRestoreInventory({current,target,deployment,settings,inventory:secrets,after}){
  check(current?.id===RESTORE_FROM&&current.number===143&&
    target?.id===RESTORE_TO&&target.number===142,
    'restore version identifiers or numbers drifted');
  // Validate the *entire* pair, including script and all retained bindings.
  verifyUuSecretCandidate(target,current);
  const live=after?RESTORE_TO:RESTORE_FROM;
  const rows=deployment?.deployments;
  check(Array.isArray(rows)&&rows.length===1&&rows[0]?.versions?.length===1&&
    rows[0].versions[0].percentage===100&&rows[0].versions[0].version_id===live,
    'restore requires the exact unique 100% active version');
  // Cloudflare Settings/Secret inventory can describe the latest *created*
  // version (143) even after redeploying older Version 142. Never use it
  // as evidence of the active version's Secret inventory.
  const actual=index(settings?.bindings);
  check(Array.isArray(secrets)&&new Set(secrets.map(x=>x.name)).size===secrets.length,
    'restore latest Secret inventory missing or duplicated');
  const choices=after?[current,target]:[current];
  check(choices.some(version=>
    stable(signature([...actual.values()]))===stable(signature(version.resources.bindings))&&
    stable(secrets.map(x=>x.name).sort())===stable(inventory(version.resources.bindings))),
  'restore latest Settings or Secret names differ from both reviewed versions');
  return true;
}

export function verifyUuSecretD1(row){
  const required={migration_count:20,uu_table:1,uu_rows:0,active_sessions:0,
    unfinished_windows_attempts:0,windows_state:'paused',old_rca_deleted:1,old_version_count:1};
  for(const [name,value] of Object.entries(required))check(row?.[name]===value,'D1/Plan drift: '+name);
  return true;
}
export function verifyUuSecretNative(response,status){
  check(['queued','running','paused','waitingForPause','waiting','rollingBack'].includes(status),
    'unrecognized Cloudflare Workflow instance status');
  const items=Array.isArray(response?.result)?response.result:response?.result?.instances;
  const page=response?.result_info;
  check(Array.isArray(items)&&items.length===0&&page?.count===0&&
    page.per_page===100&&page.total_count===0&&
    !page.cursor&&!page.next_cursor&&!response?.result?.cursor&&!response?.result?.next_cursor,
    'native Workflow not proven fully drained: '+status);
  return true;
}
export function verifyUuSecretPostflight({baseline,candidate,deployment,settings,inventory:secrets}){
  verifyUuSecretCandidate(baseline,candidate);
  const rows=deployment?.deployments;
  check(rows?.length===1&&rows[0]?.versions?.length===1&&
    rows[0].versions[0].percentage===100&&rows[0].versions[0].version_id===candidate.id,
    'retired Secret candidate is not the unique 100% active Worker');
  const latest=index(settings?.bindings);
  check(stable(signature([...latest.values()]))===stable(signature(candidate.resources.bindings)),
    'post-publish settings differ from reviewed candidate');
  check(Array.isArray(secrets)&&stable(secrets.map(s=>s.name).sort())===
    stable(inventory(candidate.resources.bindings)),'post-publish Secret inventory drift');
  return true;
}

const SQL=`SELECT
 (SELECT COUNT(*) FROM d1_migrations) AS migration_count,
 (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_runtime_data') AS uu_table,
 (SELECT COUNT(*) FROM session_runtime_data) AS uu_rows,
 (SELECT COUNT(*) FROM session_executions WHERE state!='terminated') AS active_sessions,
 (SELECT COUNT(*) FROM step_attempts WHERE workflow_ref LIKE '%windows.yml%'
   AND state NOT IN ('succeeded','failed','cancelled','rejected')) AS unfinished_windows_attempts,
 (SELECT state FROM workflows WHERE id='00b1e052-f383-4d26-bef2-db49a97c72b9') AS windows_state,
 (SELECT deleted_at IS NOT NULL FROM workflows
   WHERE id='8a698bd3-838b-4c05-88b7-12b1d4ec38d5') AS old_rca_deleted,
 (SELECT COUNT(*) FROM workflow_versions
   WHERE id='c9a00b47-521e-43f5-b6a6-a06dffcf98ac') AS old_version_count`;

async function main(){
 const [stage,worker]=process.argv.slice(2);
 check(['preflight','candidate','readback','restore-preflight','restore-readback'].includes(stage)&&
   worker==='workflow-mcp-worker','unsupported exact worker or phase');
 const e=process.env;
 check(e.UU_SESSION_SECRET_CLEANUP==='true'&&
   e.GITHUB_ACTOR==='lirtual'&&e.GITHUB_REPOSITORY==='lirtual/mcp-workers'&&
   e.GITHUB_REF==='refs/heads/main'&&e.WORKFLOW_CODE_ONLY!=='true',
   'protected Owner main workflow required');
 const phase=e.LEGACY_CLEANUP_MODE;
 const restoring=phase==='restore';
 check(restoring?['restore-preflight','restore-readback'].includes(stage):
   ['preflight','candidate','readback'].includes(stage)&&
   ((stage==='readback')===(phase==='publish')||stage==='preflight'),
   'unexpected stage/phase combination');
 const active=e.EXPECTED_ACTIVE_VERSION,candidateId=e.CANDIDATE_VERSION_ID||'';
 const request={phase,sourceSha:e.GITHUB_SHA,expectedSha:e.EXPECTED_SOURCE_SHA,
   activeVersion:active,candidateVersion:candidateId};
 if(restoring)verifyUuSecretRestoreRequest(request);
 else verifyUuSecretRequest({...request,candidateVersion:phase==='publish'?candidateId:''});
 // Prepare preflight has no candidate yet; Prepare verification has the new
 // unpublished candidate; Publish preflight/readback REQUIRE its reviewed ID.
 const stageReady=restoring?true:stage==='preflight'
   ?(phase==='prepare'?!candidateId:UUID.test(candidateId))
   :stage==='candidate'
   ?phase==='prepare'&&UUID.test(candidateId)
   :phase==='publish'&&UUID.test(candidateId);
 check(stageReady,'phase or reviewed candidate mismatches read-only stage');
 const account=e.CLOUDFLARE_ACCOUNT_ID,token=e.CLOUDFLARE_API_TOKEN;
 check(/^[a-f0-9]{32}$/.test(account??'')&&token?.length>0,'Cloudflare read credentials missing');
 const api=async(path,sql)=>{
   const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+path,{
     method:sql?'POST':'GET',headers:{Authorization:'Bearer '+token,
       ...(sql?{'Content-Type':'application/json'}:{})},
     redirect:'manual',signal:AbortSignal.timeout(15000),
     ...(sql?{body:JSON.stringify({sql})}:{})});
   check(response.status===200,'Cloudflare readback HTTP '+response.status);
   const result=await response.json();
   check(result?.success===true&&Array.isArray(result.errors)&&result.errors.length===0,
     'Cloudflare inventory unavailable');
   return result;
 };
 const workerPath='/workers/scripts/workflow-mcp-worker';
 const d1='/d1/database/'+D1_ID+'/query';
 // This existing historical proof checks the 12 exact immutable Unknown Runs,
 // source/applied 20 Migration identities, native drain, admission gate and
 // zero active Sessions. It is NOT a generic D1 migration exception.
 await verifyWorkflowQuiet();
 const record=await api(d1,SQL);
 check(record.result?.length===1&&record.result[0]?.success===true&&
   record.result[0].results?.length===1,'D1 inventory missing');
 verifyUuSecretD1(record.result[0].results[0]);
 for(const status of ['queued','running','paused','waiting','waitingForPause','rollingBack']){
   const page=await api('/workflows/workflow-mcp-orchestrator/instances?status='+
     encodeURIComponent(status)+'&per_page=100');
   verifyUuSecretNative(page,status);
 }
 const deploy=await api(workerPath+'/deployments?per_page=1');
 const baseline=(await api(workerPath+'/versions/'+active)).result;
 check(baseline?.id===active,'reviewed active version not present');
 const prepared= candidateId?(await api(workerPath+'/versions/'+candidateId)).result:null;
 const [settings,secrets]=await Promise.all([
   api(workerPath+'/settings'),api(workerPath+'/secrets')]);
 if(restoring){
   verifyUuSecretRestoreInventory({current:baseline,target:prepared,deployment:deploy.result,
     settings:settings.result,inventory:secrets.result,after:stage==='restore-readback'});
 } else if(stage==='readback'){
   check(prepared?.id===candidateId,'published candidate not found');
   verifyUuSecretPostflight({baseline,candidate:prepared,deployment:deploy.result,
     settings:settings.result,inventory:secrets.result});
 } else {
   verifyUuSecretInventory({baseline,candidate:prepared,deployment:deploy.result,
     settings:settings.result,inventory:secrets.result,
     phase:candidateId?'publish':'prepare'});
 }
 console.log('Spec 774 scoped UU Secret '+stage+' PASS; no Secret values read; all 12 historical Unknown preserved');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error('UU Secret read-only gate blocked: '+e.message);process.exitCode=1;});
