// Spec #775：仅用于受保护 Release Worker 的只读 Version 143 恢复门禁。
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{40}$/;
const TARGET='3f27e9ca-790c-4ec9-914e-cb4204a736e6';
const D1='a4a477cd-6339-478c-ab7c-f7d87bb0d772';
const OPENLIST='0015e2e9-431d-4465-9adf-03191cb382f9';
const OLD_PLAN='88071284-b7f3-4553-afe4-1ed3fc47972e';
const expected=new Map([
 ['ACTIONS','service'],['DB','d1'],['WORKFLOW','workflow'],
 ['MCP_ACCESS_TOKEN','secret_text'],['WORKFLOW_GITHUB_DISPATCH_TOKEN','secret_text'],
 ['WORKFLOW_MCP_PORTAL_CLIENT_SECRET','secret_text'],
 ['WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES','plain_text'],
 ['WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE','plain_text'],
 ['WORKFLOW_MCP_PORTAL_CLIENT_ID','plain_text'],['WORKFLOW_MCP_PORTAL_ENDPOINT','plain_text'],
]);
const check=(v,m)=>{if(!v)throw Error('Workflow restore blocked: '+m);};
const stable=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)
 ?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const bindingIndex=bs=>{
 check(Array.isArray(bs),'binding list unavailable');
 const m=new Map();
 for(const b of bs){check(typeof b?.name==='string'&&typeof b.type==='string'&&!m.has(b.name),
   'duplicate or invalid binding');m.set(b.name,b);}
 return m;
};
const resourceSignature=r=>{
 check(r&&typeof r==='object'&&r.script&&r.script_runtime&&Array.isArray(r.bindings),
   'incomplete version resources');
 // 代码允许不同；运行资源与 Secret 引用不得变更。
 const {script:_code,bindings,...rest}=r;
 return stable({...rest,bindings:bindings.map(b=>b.type==='secret_text'
  ?{name:b.name,type:b.type}:b).sort((a,b)=>a.name.localeCompare(b.name))});
};
export function verifyRestoreRequest({worker,mode,codeOnly,uuCleanup,sourceSha,expectedSha,activeVersion,targetVersion}){
 check(worker==='workflow-mcp-worker'&&mode==='restore'&&codeOnly==='true'&&uuCleanup==='false',
  'only code-only Workflow restore is allowed');
 check(SHA.test(expectedSha??'')&&sourceSha===expectedSha,'reviewed main SHA mismatch');
 check(UUID.test(activeVersion??'')&&activeVersion!==TARGET,'expected active version invalid');
 check(targetVersion===TARGET,'only immutable Version 143 can be restored');
 return true;
}
export function verifyRestoreVersions({current,target,deployment,settings,secrets,after=false}){
 check(current?.id&&UUID.test(current.id)&&current.id!==TARGET&&
   Number.isInteger(current.number)&&current.number>143,'new Worker version invalid');
 check(target?.id===TARGET&&target.number===143,'Version 143 identity drift');
 const targetBindings=bindingIndex(target.resources?.bindings);
 const currentBindings=bindingIndex(current.resources?.bindings);
 check(targetBindings.size===expected.size&&currentBindings.size===expected.size,
   'unexpected Worker binding count');
 for(const [name,type] of expected)check(targetBindings.get(name)?.type===type&&
  currentBindings.get(name)?.type===type,'binding name/type drift: '+name);
 check((targetBindings.get('DB').id||targetBindings.get('DB').database_id)===D1,'D1 binding drift');
 check(targetBindings.get('ACTIONS').service==='cloudflare-actions'&&
   targetBindings.get('ACTIONS').entrypoint==='ActionsEntrypoint','Provider binding drift');
 check(targetBindings.get('WORKFLOW').workflow_name==='workflow-mcp-orchestrator'&&
   targetBindings.get('WORKFLOW').class_name==='WorkflowOrchestrator','native Workflow binding drift');
 check(resourceSignature(current.resources)===resourceSignature(target.resources),
  'new Worker changed non-code runtime resources');
 const versions=deployment?.deployments;
 check(Array.isArray(versions)&&versions.length===1&&versions[0]?.versions?.length===1&&
  versions[0].versions[0].percentage===100&&
  versions[0].versions[0].version_id===(after?TARGET:current.id),
  'unique 100% active Worker version differs');
 const settingsBindings=bindingIndex(settings?.bindings);
 const names=secrets?.map(s=>s.name);
 check(Array.isArray(names)&&new Set(names).size===names.length,'Secret inventory unavailable or duplicate');
 const secretNames=[...expected].filter(([_n,t])=>t==='secret_text').map(([n])=>n).sort();
 check(stable([...names].sort())===stable(secretNames),'Secret-name inventory drift');
 // Settings 可能报告最近创建的版本，而不是重新部署的旧版本。
 const matched=[current,target].some(v=>stable([...bindingIndex(v.resources.bindings).values()]
  .sort((a,b)=>a.name.localeCompare(b.name)))===
  stable([...settingsBindings.values()].sort((a,b)=>a.name.localeCompare(b.name))));
 check(matched,'Worker Settings drift');
 return true;
}
export function verifyRestoreD1(row){
 const fixed={migration_count:21,migration_v21:1,old_table:0,unresolved_runs:0,
   unknown_runs:12,active_sessions:0,openlist_state:'paused',openlist_version:OLD_PLAN,original_plan:1};
 for(const [name,v] of Object.entries(fixed))check(row?.[name]===v,'D1 or old Published Plan drift: '+name);
 return true;
}
export function verifyRestoreNative(response,status){
 check(['queued','running','paused','waiting','waitingForPause','rollingBack'].includes(status),'unknown native state');
 const rows=Array.isArray(response?.result)?response.result:response?.result?.instances;
 const page=response?.result_info;
 check(Array.isArray(rows)&&rows.length===0&&page?.count===0&&page?.total_count===0&&
  page?.per_page===100&&!page.cursor&&!page.next_cursor&&
  !response?.result?.cursor&&!response?.result?.next_cursor,
  'native instances not drained: '+status);
 return true;
}
const SQL=`SELECT
 (SELECT COUNT(*) FROM d1_migrations) AS migration_count,
 (SELECT COUNT(*) FROM d1_migrations WHERE name='0021_retire_uu_session_data.sql') AS migration_v21,
 (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_runtime_data') AS old_table,
 (SELECT COUNT(*) FROM runs WHERE outcome IS NULL) AS unresolved_runs,
 (SELECT COUNT(*) FROM runs WHERE outcome='indeterminate') AS unknown_runs,
 (SELECT COUNT(*) FROM session_executions WHERE state!='terminated') AS active_sessions,
 (SELECT state FROM workflows WHERE id='${OPENLIST}' AND deleted_at IS NULL) AS openlist_state,
 (SELECT active_version_id FROM workflows WHERE id='${OPENLIST}' AND deleted_at IS NULL) AS openlist_version,
 (SELECT COUNT(*) FROM workflow_versions WHERE id='${OLD_PLAN}' AND workflow_id='${OPENLIST}') AS original_plan`;
async function main(){
 const [phase,worker]=process.argv.slice(2);
 check(['preflight','readback'].includes(phase),'unsupported readonly phase');
 const e=process.env;
 check(e.GITHUB_ACTOR==='lirtual'&&e.GITHUB_REPOSITORY==='lirtual/mcp-workers'&&
  e.GITHUB_REF==='refs/heads/main','protected Owner main required');
 verifyRestoreRequest({worker,mode:e.LEGACY_CLEANUP_MODE,codeOnly:e.WORKFLOW_CODE_ONLY,
  uuCleanup:e.UU_SESSION_SECRET_CLEANUP,sourceSha:e.GITHUB_SHA,
  expectedSha:e.EXPECTED_SOURCE_SHA,activeVersion:e.EXPECTED_ACTIVE_VERSION,
  targetVersion:e.CANDIDATE_VERSION_ID});
 const account=e.CLOUDFLARE_ACCOUNT_ID,token=e.CLOUDFLARE_API_TOKEN;
 check(/^[a-f0-9]{32}$/.test(account??'')&&token?.length>0,'Cloudflare credentials missing');
 const api=async(path,sql)=>{
  const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+path,{
   method:sql?'POST':'GET',headers:{Authorization:'Bearer '+token,
    ...(sql?{'Content-Type':'application/json'}:{})},redirect:'manual',
   signal:AbortSignal.timeout(15000),...(sql?{body:JSON.stringify({sql})}:{})});
  check(response.status===200,'Cloudflare HTTP '+response.status);
  const body=await response.json();
  check(body?.success===true&&Array.isArray(body.errors)&&body.errors.length===0,
   'Cloudflare read-only API failed');
  return body;
 };
 const q=await api('/d1/database/'+D1+'/query',SQL);
 check(q.result?.length===1&&q.result[0]?.success===true&&
  q.result[0]?.meta?.changes===0&&q.result[0]?.results?.length===1,
  'D1 SELECT incomplete or changes not zero');
 verifyRestoreD1(q.result[0].results[0]);
 for(const state of ['queued','running','paused','waiting','waitingForPause','rollingBack']){
  const p=await api('/workflows/workflow-mcp-orchestrator/instances?status='+state+'&per_page=100');
  verifyRestoreNative(p,state);
 }
 const path='/workers/scripts/workflow-mcp-worker';
 const [deploy,current,target,settings,secrets]=await Promise.all([
  api(path+'/deployments?per_page=1'),
  api(path+'/versions/'+e.EXPECTED_ACTIVE_VERSION),api(path+'/versions/'+TARGET),
  api(path+'/settings'),api(path+'/secrets'),
 ]);
 check(current.result?.id===e.EXPECTED_ACTIVE_VERSION,'reviewed active version changed');
 verifyRestoreVersions({current:current.result,target:target.result,
  deployment:deploy.result,settings:settings.result,secrets:secrets.result,
  after:phase==='readback'});
 console.log('Spec #775 Version 143 restore '+phase+' PASS (read-only; historical Plan and 12 Unknown unchanged)');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e.message);process.exitCode=1;});
