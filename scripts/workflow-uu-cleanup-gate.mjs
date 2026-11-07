// #774: deliberately isolated one-table cleanup, not an exception to generic migrations.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {REVIEWED_HISTORICAL_RUN_IDS} from './legacy-secret-cleanup.mjs';
const check=(ok,msg)=>{if(!ok)throw Error('UU DROP gate: '+msg);};
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{40}$/;
const VERSION='3f27e9ca-790c-4ec9-914e-cb4204a736e6';
const DB='a4a477cd-6339-478c-ab7c-f7d87bb0d772';
const FILE='0021_retire_uu_session_data.sql';
const kinds=new Map([['ACTIONS','service'],['DB','d1'],['WORKFLOW','workflow'],
 ['MCP_ACCESS_TOKEN','secret_text'],['WORKFLOW_GITHUB_DISPATCH_TOKEN','secret_text'],
 ['WORKFLOW_MCP_PORTAL_CLIENT_SECRET','secret_text'],
 ['WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES','plain_text'],
 ['WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE','plain_text'],
 ['WORKFLOW_MCP_PORTAL_CLIENT_ID','plain_text'],['WORKFLOW_MCP_PORTAL_ENDPOINT','plain_text']]);
const states=['queued','running','paused','waiting','waitingForPause','rollingBack'];
const priorMigrations=readdirSync('apps/workflow-mcp-worker/migrations')
 .filter(x=>/^\d{4}_[a-z0-9_]+\.sql$/.test(x)&&x!==FILE).sort();
check(priorMigrations.length===20,'expected twenty immutable source migrations');
const quotedMigrations=priorMigrations.map(x=>"'"+x+"'").join(',');
const ids=REVIEWED_HISTORICAL_RUN_IDS.map(id=>{check(UUID.test(id),'history ID');return "'"+id+"'";}).join(',');
const unknown="(outcome IS NULL OR outcome NOT IN ('succeeded','failed','cancelled'))";
const step="(status IS NULL OR status NOT IN ('succeeded','failed','skipped','cancelled'))";
const attempt="(state IS NULL OR state NOT IN ('rejected','succeeded','failed','cancelled'))";
const footprint=[
 `(SELECT group_concat(line,'|') FROM (SELECT id||':'||outcome||':'||coalesce(error_code,'') line FROM runs WHERE ${unknown} ORDER BY id)) AS run_proof`,
 `(SELECT group_concat(line,'|') FROM (SELECT run_id||':'||step_id||':'||status||':'||coalesce(error_code,'') line FROM run_steps WHERE ${step} ORDER BY run_id,step_id)) AS step_proof`,
 `(SELECT group_concat(line,'|') FROM (SELECT run_id||':'||step_id||':'||state||':'||coalesce(owner_run_id,'') line FROM step_attempts WHERE ${attempt} ORDER BY run_id,step_id)) AS attempt_proof`,
];
export function uuReadinessSql(stage){
 check(['before','after'].includes(stage),'phase');
 return `SELECT
 (SELECT count(*) FROM d1_migrations) migration_count,
 (SELECT count(*) FROM d1_migrations WHERE name IN (${quotedMigrations})) reviewed_migrations,
 (SELECT count(*) FROM d1_migrations WHERE name='0010_session_runtime_data.sql') migration_v10,
 (SELECT count(*) FROM d1_migrations WHERE name='0020_github_action_main_sha.sql') migration_v20,
 (SELECT count(*) FROM d1_migrations WHERE name='${FILE}') migration_v21,
 (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session_runtime_data') table_present,
 ${stage==='before'?'(SELECT count(*) FROM session_runtime_data)':'0'} table_rows,
 (SELECT count(*) FROM runs WHERE ${unknown}) unknown_runs,
 (SELECT count(*) FROM runs WHERE id IN (${ids}) AND outcome='indeterminate') reviewed_unknown_runs,
 (SELECT count(*) FROM runs WHERE ${unknown} AND id NOT IN (${ids})) unreviewed_runs,
 (SELECT count(*) FROM runs WHERE outcome IN ('queued','running')) active_runs,
 (SELECT count(*) FROM run_steps WHERE ${step}) unresolved_steps,
 (SELECT count(*) FROM run_steps WHERE ${step} AND status='indeterminate') indeterminate_steps,
 (SELECT count(*) FROM run_steps WHERE ${step} AND status='running' AND run_id='391e075f-3d5c-449e-ad88-fa13c6d4eb6d') reviewed_ima_running,
 (SELECT count(*) FROM run_steps WHERE ${step} AND run_id NOT IN (${ids})) unreviewed_steps,
 (SELECT count(*) FROM step_attempts WHERE ${attempt}) unresolved_attempts,
 (SELECT count(*) FROM step_attempts WHERE ${attempt} AND state='claimed' AND run_id='f99bb918-2909-46df-b196-d07faa64df27') reviewed_claimed_attempt,
 (SELECT count(*) FROM step_attempts WHERE ${attempt} AND run_id!='f99bb918-2909-46df-b196-d07faa64df27') unreviewed_attempts,
 (SELECT count(*) FROM session_executions WHERE state!='terminated') active_sessions,
 (SELECT count(*) FROM step_attempts WHERE workflow_ref LIKE '%windows.yml%' AND ${attempt}) pending_windows_attempts,
 (SELECT count(*) FROM callback_receipts WHERE notification_delivered IS NULL OR notification_delivered!=1) undelivered_callbacks,
 (SELECT state FROM workflows WHERE id='00b1e052-f383-4d26-bef2-db49a97c72b9') windows_state,
 (SELECT deleted_at IS NOT NULL FROM workflows WHERE id='8a698bd3-838b-4c05-88b7-12b1d4ec38d5') old_rca_retired,
 (SELECT count(*) FROM workflow_versions WHERE id='c9a00b47-521e-43f5-b6a6-a06dffcf98ac') old_rca_version,
 (SELECT state FROM cloudflare_action_gate WHERE id=1) action_gate,
 ${footprint.join(',\n ')}`;
}
export function verifyUuNativeQuiet(payload,state){
 check(states.includes(state),'unknown native status');
 const list=Array.isArray(payload?.result)?payload.result:payload?.result?.instances;
 const page=payload?.result_info;
 check(Array.isArray(list)&&list.length===0&&page?.count===0&&page?.total_count===0&&
   page?.per_page===100&&!page?.cursor&&!page?.next_cursor&&
   !payload?.result?.cursor&&!payload?.result?.next_cursor,'native pagination/active '+state);
}
export function verifyUuCleanupGuard({stage,expectedSha,sourceSha,expectedVersion,live,version,row,previous}){
 check(['before','after'].includes(stage),'phase');
 check(sha.test(expectedSha??'')&&sourceSha===expectedSha,'main SHA mismatch');
 check(expectedVersion===VERSION&&version?.id===VERSION&&version?.number===143,'Version143 mismatch');
 check(live?.deployments?.length===1&&live.deployments[0].versions?.length===1&&
   live.deployments[0].versions[0].percentage===100&&
   live.deployments[0].versions[0].version_id===VERSION,'100% active version mismatch');
 const bs=version.resources?.bindings;
 check(Array.isArray(bs)&&bs.length===kinds.size,'exact ten bindings required');
 const seen=new Set();
 for(const b of bs){
   check(b?.name&&kinds.get(b.name)===b.type&&!seen.has(b.name),'unreviewed binding');
   seen.add(b.name);
   if(b.name==='DB')check((b.id||b.database_id)===DB,'D1 binding mismatch');
 }
 const required={migration_count:stage==='before'?20:21,migration_v10:1,migration_v20:1,
   migration_v21:stage==='before'?0:1,reviewed_migrations:20,table_present:stage==='before'?1:0,table_rows:0,
   unknown_runs:12,reviewed_unknown_runs:12,unreviewed_runs:0,active_runs:0,unresolved_steps:12,indeterminate_steps:11,reviewed_ima_running:1,
   unreviewed_steps:0,unresolved_attempts:1,reviewed_claimed_attempt:1,unreviewed_attempts:0,
   active_sessions:0,pending_windows_attempts:0,undelivered_callbacks:0,
   windows_state:'paused',old_rca_retired:1,old_rca_version:1,action_gate:'open'};
 for(const [key,value] of Object.entries(required))check(row?.[key]===value,'unsafe D1 '+key);
 const fingerprint={};
 for(const field of ['run_proof','step_proof','attempt_proof']){
   check(typeof row[field]==='string'&&row[field].length>0,'missing '+field);
   check(row[field].split('|').length==={run_proof:12,step_proof:12,attempt_proof:1}[field],'unexpected fingerprint size');
   if(stage==='after')check(previous?.[field]===row[field],'historical data drift '+field);
   fingerprint[field]=row[field];
 }
 return fingerprint;
}
async function main(){
 const stage=process.argv[2],e=process.env;
 check(['before','after'].includes(stage),'stage');
 check(e.GITHUB_REPOSITORY==='lirtual/mcp-workers'&&e.GITHUB_REF==='refs/heads/main'&&
   e.GITHUB_ACTOR==='lirtual'&&e.UU_CLEANUP_APPROVED==='true'&&
   e.WORKFLOW_CODE_ONLY!=='true','explicit owner approval required');
 check(sha.test(e.UU_CLEANUP_EXPECTED_SHA??'')&&e.GITHUB_SHA===e.UU_CLEANUP_EXPECTED_SHA&&
   e.UU_CLEANUP_EXPECTED_ACTIVE_VERSION===VERSION,'exact SHA/version approval required');
 const migrations=readdirSync('apps/workflow-mcp-worker/migrations')
   .filter(x=>/^\d{4}_[a-z0-9_]+\.sql$/.test(x));
 check(migrations.length===21&&migrations.includes(FILE),'exact source migrations required');
 const script=readFileSync('apps/workflow-mcp-worker/migrations/'+FILE,'utf8');
 check(script.includes('DROP TABLE session_runtime_data;')&&
   (script.match(/^DROP TABLE /gm)||[]).length===1&&
   !/^\s*(DELETE|UPDATE|INSERT|ALTER|REPLACE|CREATE)\s/mi.test(script),
   'destructive migration must target one exact table');
 check(/^[a-f0-9]{32}$/.test(e.CLOUDFLARE_ACCOUNT_ID??'')&&!!e.CLOUDFLARE_API_TOKEN,
   'Cloudflare credentials unavailable');
 const base='/accounts/'+e.CLOUDFLARE_ACCOUNT_ID;
 const api=async(tail,sql)=>{
   const response=await fetch('https://api.cloudflare.com/client/v4'+base+tail,{
     method:sql?'POST':'GET',redirect:'manual',signal:AbortSignal.timeout(15000),
     headers:{Authorization:'Bearer '+e.CLOUDFLARE_API_TOKEN,
       ...(sql?{'Content-Type':'application/json'}:{})},
     ...(sql?{body:JSON.stringify({sql})}:{})});
   check(response.status===200,'Cloudflare read response');
   const data=await response.json();
   check(data?.success===true&&Array.isArray(data.errors)&&data.errors.length===0,
     'Cloudflare read-only API error');
   return data;
 };
 const [d1,deployment,version]=await Promise.all([
   api('/d1/database/'+DB+'/query',uuReadinessSql(stage)),
   api('/workers/scripts/workflow-mcp-worker/deployments?per_page=1'),
   api('/workers/scripts/workflow-mcp-worker/versions/'+VERSION)]);
 check(d1.result?.length===1&&d1.result[0].success===true&&
   d1.result[0].meta?.changed_db===false&&d1.result[0].results?.length===1,
   'D1 readback unavailable');
 const snapshot=e.RUNNER_TEMP+'/spec774-uu-before.json';
 const fingerprint=verifyUuCleanupGuard({stage,expectedSha:e.UU_CLEANUP_EXPECTED_SHA,
   sourceSha:e.GITHUB_SHA,expectedVersion:e.UU_CLEANUP_EXPECTED_ACTIVE_VERSION,
   live:deployment.result,version:version.result,row:d1.result[0].results[0],
   ...(stage==='after'?{previous:JSON.parse(readFileSync(snapshot,'utf8'))}:{})});
 const native=await Promise.all(states.map(async state=>({state,result:
   await api('/workflows/workflow-mcp-orchestrator/instances?status='+
     encodeURIComponent(state)+'&per_page=100')})));
 for(const x of native)verifyUuNativeQuiet(x.result,x.state);
 if(stage==='before')writeFileSync(snapshot,JSON.stringify(fingerprint),{mode:0o600});
 console.log('Spec774 isolated table '+stage+' strict gate PASS (history unchanged)');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(error=>{console.error(error.message);process.exitCode=1;});
