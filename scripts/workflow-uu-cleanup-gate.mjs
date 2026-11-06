// #774: extra, read-only UU retirement gate. Never replaces normal migration checks.
import {readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {verifyWorkflowMigrationReadiness,WORKFLOW_MIGRATION_READINESS_SQL} from './manual-worker-release.mjs';
const assert=(ok,msg)=>{if(!ok)throw Error('UU cleanup: '+msg);};
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{40}$/;
const SECRET='WORKFLOW_SESSION_RUNTIME_DATA_KEY';
const NAMES=new Map([
 ['ACTIONS','service'],['DB','d1'],['WORKFLOW','workflow'],
 ['MCP_ACCESS_TOKEN','secret_text'],['WORKFLOW_GITHUB_DISPATCH_TOKEN','secret_text'],
 ['WORKFLOW_MCP_PORTAL_CLIENT_SECRET','secret_text'],[SECRET,'secret_text'],
 ['WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES','plain_text'],
 ['WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE','plain_text'],
 ['WORKFLOW_MCP_PORTAL_CLIENT_ID','plain_text'],['WORKFLOW_MCP_PORTAL_ENDPOINT','plain_text']
]);
export const UU_READINESS_SQL=`SELECT
 (SELECT count(*) FROM d1_migrations) AS migration_count,
 (SELECT count(*) FROM d1_migrations WHERE name='0010_session_runtime_data.sql') AS migration_v10,
 (SELECT count(*) FROM d1_migrations WHERE name='0020_github_action_main_sha.sql') AS migration_v20,
 (SELECT count(*) FROM d1_migrations WHERE name='0021_retire_uu_session_data.sql') AS migration_v21,
 (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session_runtime_data') AS table_present,
 (SELECT count(*) FROM session_runtime_data) AS table_rows,
 (SELECT count(*) FROM session_executions WHERE state!='terminated') AS active_sessions,
 (SELECT count(*) FROM step_attempts WHERE workflow_ref LIKE '%windows.yml%'
   AND state NOT IN ('succeeded','failed','cancelled','rejected')) AS pending_windows_attempts,
 (SELECT state FROM workflows WHERE id='00b1e052-f383-4d26-bef2-db49a97c72b9') AS windows_state,
 (SELECT deleted_at IS NOT NULL FROM workflows
   WHERE id='8a698bd3-838b-4c05-88b7-12b1d4ec38d5') AS retired_rca_tombstoned,
 (SELECT count(*) FROM workflow_versions
   WHERE id='c9a00b47-521e-43f5-b6a6-a06dffcf98ac') AS retired_rca_version_exists`;
const indexed=bindings=>{
 assert(Array.isArray(bindings),'binding inventory missing');
 const m=new Map();
 for(const b of bindings){assert(b?.name&&b?.type&&!m.has(b.name),'duplicate/invalid binding');m.set(b.name,b);}
 return m;
};
export function verifyUuCleanupGuard({expectedSha,sourceSha,expectedVersion,deployment,version,cleanupRow,migrationResponse}){
 assert(SHA.test(expectedSha??'')&&expectedSha===sourceSha,'main SHA mismatch');
 assert(UUID.test(expectedVersion??'')&&version?.id===expectedVersion,'Worker version mismatch');
 assert(deployment?.deployments?.length===1&&deployment.deployments[0].versions?.length===1&&
   deployment.deployments[0].versions[0].percentage===100&&
   deployment.deployments[0].versions[0].version_id===expectedVersion,'100% active version mismatch');
 const bindings=indexed(version.resources?.bindings);
 assert(bindings.size===NAMES.size,'binding count drift');
 for(const [name,type] of NAMES)assert(bindings.get(name)?.type===type,'binding drift: '+name);
 const db=bindings.get('DB');
 assert((db?.id||db?.database_id)==='a4a477cd-6339-478c-ab7c-f7d87bb0d772','D1 identity drift');
 const required={migration_count:20,migration_v10:1,migration_v20:1,migration_v21:0,
   table_present:1,table_rows:0,active_sessions:0,pending_windows_attempts:0,
   windows_state:'paused',retired_rca_tombstoned:1,retired_rca_version_exists:1};
 for(const [key,value] of Object.entries(required))
   assert(cleanupRow?.[key]===value,'unsafe D1 / old Plan: '+key);
 // This standard gate still blocks ALL historical Unknown and indeterminate runs.
 verifyWorkflowMigrationReadiness(migrationResponse);
 return true;
}
export function verifyUuSecretCandidate(baseline,candidate){
 assert(UUID.test(baseline?.id??'')&&UUID.test(candidate?.id??'')&&baseline.id!==candidate.id&&
   Number.isInteger(baseline.number)&&Number.isInteger(candidate.number)&&
   candidate.number>baseline.number,'UU Secret candidate identity drift');
 assert(baseline.resources?.script?.etag&&candidate.resources?.script?.etag===
   baseline.resources.script.etag,'UU Secret candidate code drift');
 const stableValue=value=>JSON.stringify(value??null);
 for(const key of ['script_runtime']){
   assert(stableValue(candidate.resources?.[key])===stableValue(baseline.resources?.[key]),
     'UU Secret candidate runtime drift: '+key);
 }
 for(const key of ['handlers','named_handlers']){
   assert(stableValue(candidate.resources?.script?.[key])===stableValue(baseline.resources?.script?.[key]),
     'UU Secret candidate handler drift: '+key);
 }
 const before=indexed(baseline.resources.bindings),after=indexed(candidate.resources.bindings);
 assert(before.size===NAMES.size&&after.size===before.size-1&&!after.has(SECRET),
   'UU Secret candidate deletion set drift');
 for(const [name,type] of NAMES)assert(before.get(name)?.type===type,'UU Secret candidate baseline drift');
 const normal=b=>JSON.stringify(Object.fromEntries(Object.entries(b)
   .filter(([key])=>!(key==='text'&&b.type==='secret_text')).sort(([a],[b])=>a.localeCompare(b))));
 for(const [name,b] of before)if(name!==SECRET)
   assert(after.get(name)&&normal(after.get(name))===normal(b),
     'UU Secret candidate changed retained binding: '+name);
 return true;
}
async function main(){
 const env=process.env;
 assert(env.GITHUB_REPOSITORY==='lirtual/mcp-workers'&&env.GITHUB_REF==='refs/heads/main'&&
   env.GITHUB_ACTOR==='lirtual'&&env.WORKFLOW_CODE_ONLY!=='true',
   'protected Owner main release required');
 const expectedSha=env.UU_CLEANUP_EXPECTED_SHA,expectedVersion=env.UU_CLEANUP_EXPECTED_ACTIVE_VERSION;
 assert(SHA.test(expectedSha??'')&&UUID.test(expectedVersion??'')&&env.GITHUB_SHA===expectedSha,
   'Owner-reviewed exact SHA and active version required');
 const files=readdirSync('apps/workflow-mcp-worker/migrations').filter(x=>/^\d{4}_[a-z0-9_]+\.sql$/.test(x));
 assert(files.length===21&&files.includes('0010_session_runtime_data.sql')&&
   files.includes('0021_retire_uu_session_data.sql'),'exact source migration inventory required');
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 assert(/^[a-f0-9]{32}$/.test(account??'')&&token?.length,'Cloudflare auth missing');
 const api=async(tail,sql)=>{
   const res=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+tail,{
     method:sql?'POST':'GET',redirect:'manual',signal:AbortSignal.timeout(15000),
     headers:{Authorization:'Bearer '+token,...(sql?{'Content-Type':'application/json'}:{})},
     ...(sql?{body:JSON.stringify({sql})}:{})});
   assert(res.status===200,'Cloudflare read-only HTTP error');
   const data=await res.json();
   assert(data?.success===true&&Array.isArray(data.errors)&&data.errors.length===0,
     'Cloudflare read-only inventory unavailable');
   return data.result;
 };
 const d1='/d1/database/a4a477cd-6339-478c-ab7c-f7d87bb0d772/query';
 const migrationResponse=await api(d1,WORKFLOW_MIGRATION_READINESS_SQL);
 const rows=await api(d1,UU_READINESS_SQL);
 assert(rows?.length===1&&rows[0].success===true&&rows[0].results?.length===1,
   'UU D1 row unavailable');
 const worker='/workers/scripts/workflow-mcp-worker';
 const deployment=await api(worker+'/deployments?per_page=1');
 const version=await api(worker+'/versions/'+expectedVersion);
 verifyUuCleanupGuard({expectedSha,sourceSha:env.GITHUB_SHA,expectedVersion,
   deployment,version,cleanupRow:rows[0].results[0],migrationResponse});
 console.log('UU cleanup strict read-only gate PASS; existing migration gate unchanged');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error('UU cleanup gate BLOCKED: '+e.message);process.exitCode=1;});
