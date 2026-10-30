// Read-only credential/CA rotation isolation check; never PATCH/restart/delete.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfiguration,verifyDatabaseHyperdriveSource} from './manual-worker-release.mjs';
import {verifyCloudflareHyperdriveConfig} from './verify-database-hyperdrive.mjs';
const REGISTRY='cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail=code=>{throw Error('Hyperdrive rotation preflight blocked: '+code)};
export async function checkDatabaseHyperdriveRotation({mode,connectionId,expectedRevision,actor,ref,sourceSha,accountId,token,source,manifest,request=fetch}){
 if(!['credentials','ca'].includes(mode)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(connectionId??'')||
 !/^[1-9][0-9]{0,12}$/.test(expectedRevision??'')||!Number.isSafeInteger(Number(expectedRevision))||
 actor!=='lirtual'||ref!=='refs/heads/main'||!/^[a-f0-9]{40}$/.test(sourceSha??'')||
 !/^[a-f0-9]{32}$/i.test(accountId??'')||!token)fail('identity');
 if(source?.name!=='database-mcp-worker'||source.main!=='src/index.ts'||source.d1_databases?.length!==1||
 source.d1_databases[0].binding!=='DB'||source.d1_databases[0].database_id!==REGISTRY||
 source.d1_databases[0].database_name!=='database-mcp-registry')fail('source');
 verifyDatabaseHyperdriveSource(source,manifest);
 const root='https://api.cloudflare.com/client/v4/accounts/'+accountId;
 async function read(path,sql){
  let response;
  try{response=await request(root+path,{method:sql?'POST':'GET',headers:{authorization:'Bearer '+token,accept:'application/json',
    ...(sql?{'content-type':'application/json'}:{})},...(sql?{body:JSON.stringify(sql)}:{}),
    redirect:'manual',signal:AbortSignal.timeout(15000)})}catch{fail('api_unavailable')}
  if(!response?.ok)fail('api_unavailable');
  let data;try{data=await response.json()}catch{fail('api_unavailable')}
  if(data?.success!==true||data.result==null)fail('api_unavailable');
  return data;
 }
 async function query(sql,params=[]){
  const {result}=await read('/d1/database/'+REGISTRY+'/query',{sql,params:params.map(String)});
  if(!Array.isArray(result)||result.length!==1||result[0]?.success!==true||
    !Array.isArray(result[0].results))fail('registry_unavailable');
  return result[0].results;
 }
 const migrations=await query("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0003_hyperdrive_operations.sql'");
 if(migrations.length!==1||migrations[0].n!==1)fail('drain_schema_unavailable');
 const rows=await query('SELECT id,dialect,transport,status,revision,config_id,binding_name,in_flight_count,target_metadata FROM database_connections WHERE id=?',[connectionId]);
 const row=rows.length===1?rows[0]:null;
 if(row?.id!==connectionId||row.transport!=='hyperdrive'||row.status!=='disabled'||
 row.revision!==Number(expectedRevision)||row.in_flight_count!==0||
 !/^[a-f0-9]{32}$/i.test(row.config_id??'')||
 !/^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(row.binding_name??'')||
 !['mysql','postgres'].includes(row.dialect))fail('disabled_drain_unproven');
 const shared=await query('SELECT COUNT(*) AS n FROM database_connections WHERE id<>? AND (config_id=? OR binding_name=?)',[connectionId,row.config_id,row.binding_name]);
 if(shared.length!==1||shared[0].n!==0)fail('shared_registry_reference');
 const ops=await query("SELECT COUNT(*) AS n FROM hyperdrive_operations WHERE logical_id=? AND phase IN ('pending','running','awaiting_confirmation','unknown')",[connectionId]);
 if(ops.length!==1||ops[0].n!==0)fail('unfinished_operation');
 if((source.hyperdrive??[]).some(x=>x.id===row.config_id||x.binding===row.binding_name)||
   manifest.some(x=>x.id===row.config_id||x.binding===row.binding_name))fail('reviewed_source_reference');
 const {result:config}=await read('/hyperdrive/configs/'+row.config_id);
 if(config?.id!==row.config_id||config.caching?.disabled!==true||
 config.origin?.scheme!==(row.dialect==='mysql'?'mysql':'postgres')||
 config.mtls?.sslmode!==(row.dialect==='mysql'?'VERIFY_IDENTITY':'verify-full')||
 typeof config.mtls.ca_certificate_id!=='string')fail('config_drift');
 // 0003 pins immutable nonsecret origin identity for new configurations.
 // A legacy row with no verified metadata cannot qualify for in-place rotation.
 let target;
 try { target=JSON.parse(row.target_metadata); }catch{fail('target_identity_unconfirmed')}
 const keys=['binding','id','dialect','origin_host','origin_port','origin_database',
  'origin_user','ca_certificate_id'];
 if(!target||typeof target!=='object'||Array.isArray(target)||
   Object.keys(target).length!==keys.length||keys.some(k=>!Object.hasOwn(target,k))||
   target.binding!==row.binding_name||target.id!==row.config_id||target.dialect!==row.dialect)
   fail('target_identity_unconfirmed');
 try{verifyCloudflareHyperdriveConfig(target,config)}catch{fail('target_identity_unconfirmed')}
 const scripts=await read('/workers/scripts');
 if(!Array.isArray(scripts.result)||scripts.result.length>100||scripts.result_info?.total_pages>1||
   (scripts.result.length===100&&scripts.result_info?.total_pages!==1))
  fail('worker_inventory_incomplete');
 const names=scripts.result.map(x=>x.id??x.name);
 if(new Set(names).size!==names.length||!names.includes('database-mcp-worker')||
  names.some(x=>typeof x!=='string'||!x))fail('worker_inventory_incomplete');
 const hasTarget=bindings=>bindings.some(x=>x.type==='hyperdrive'&&
  (x.id===row.config_id||x.name===row.binding_name));
 for(const name of names){
  const {result:settings}=await read('/workers/scripts/'+encodeURIComponent(name)+'/settings');
  if(!Array.isArray(settings?.bindings))fail('worker_settings_incomplete');
  if(hasTarget(settings.bindings))fail('current_worker_reference');
 }
 const deploymentPath='/workers/scripts/database-mcp-worker/deployments';
 const {result:deployed}=await read(deploymentPath);
 const live=deployed?.deployments?.[0]?.versions;
 if(!Array.isArray(live)||live.length!==1||live[0].percentage!==100||!UUID.test(live[0].version_id??''))
  fail('active_version_unconfirmed');
 const activeId=live[0].version_id;
 const {result:versions}=await read('/workers/scripts/database-mcp-worker/versions?deployable=true');
 if(!Array.isArray(versions?.items)||versions.items.length<1||versions.items.length>100||
  new Set(versions.items.map(x=>x.id)).size!==versions.items.length||
  versions.items.some(x=>!UUID.test(x.id??''))||!versions.items.some(x=>x.id===activeId))
  fail('rollback_inventory_incomplete');
 for(const version of versions.items){
  const {result:detail}=await read('/workers/scripts/database-mcp-worker/versions/'+version.id);
  if(detail?.id!==version.id||!Array.isArray(detail.resources?.bindings))fail('rollback_version_unavailable');
  if(hasTarget(detail.resources.bindings))fail('rollback_reference');
 }
 // Other Workers' *current* settings do not describe their rollback versions.
 // A stale deployable version can reintroduce the same Hyperdrive reference.
 // An inventory can advance while a long historical-version scan is in flight.
 // Reconcile every exact Worker/version set before claiming read-only eligibility.
 const versionSnapshots=new Map([['database-mcp-worker',versions.items.map(v=>v.id).sort()]]);
 let allVersions=versions.items.length;
 for(const name of names.filter(n=>n!=='database-mcp-worker')){
  const path='/workers/scripts/'+encodeURIComponent(name);
  const {result:otherLive}=await read(path+'/deployments');
  const active=otherLive?.deployments?.[0]?.versions;
  if(!Array.isArray(active)||active.length!==1||active[0].percentage!==100||
    !UUID.test(active[0].version_id??''))fail('other_worker_active_unconfirmed');
  const {result:other}=await read(path+'/versions?deployable=true');
  if(!Array.isArray(other?.items)||other.items.length<1||other.items.length>100||
    new Set(other.items.map(v=>v.id)).size!==other.items.length||
    other.items.some(v=>!UUID.test(v.id??''))||
    !other.items.some(v=>v.id===active[0].version_id))fail('other_worker_history_incomplete');
  versionSnapshots.set(name,other.items.map(v=>v.id).sort());
  allVersions+=other.items.length;
  for(const v of other.items){
    const {result:detail}=await read(path+'/versions/'+v.id);
    if(detail?.id!==v.id||!Array.isArray(detail.resources?.bindings))fail('other_worker_history_incomplete');
    if(hasTarget(detail.resources.bindings))fail('other_worker_rollback_reference');
  }
  const {result:againOther}=await read(path+'/deployments');
  if(againOther?.deployments?.[0]?.versions?.length!==1||
    againOther.deployments[0].versions[0].percentage!==100||
    againOther.deployments[0].versions[0].version_id!==active[0].version_id)
    fail('other_worker_deployment_changed');
 }
 const {result:latestScripts}=await read('/workers/scripts');
 if(!Array.isArray(latestScripts)||latestScripts.length!==names.length||
   latestScripts.result_info?.total_pages>1||
   latestScripts.map(x=>x.id??x.name).sort().some((name,i)=>name!==[...names].sort()[i]))
   fail('worker_inventory_changed');
 for(const [name,ids] of versionSnapshots){
   const {result:latestVersions}=await read('/workers/scripts/'+encodeURIComponent(name)+'/versions?deployable=true');
   if(!Array.isArray(latestVersions?.items)||latestVersions.items.length!==ids.length||
     latestVersions.items.some(v=>!UUID.test(v.id??''))||
     latestVersions.items.map(v=>v.id).sort().some((id,i)=>id!==ids[i]))
     fail('rollback_inventory_changed');
 }
 // Read the write-sensitive origin and strict TLS settings again: a
 // configuration edit during the rollback scan invalidates the observation.
 const {result:latestConfig}=await read('/hyperdrive/configs/'+row.config_id);
 const invariant=c=>[c?.id,c?.origin?.scheme,c?.origin?.host,c?.origin?.port,
   c?.origin?.database,c?.origin?.user,c?.mtls?.sslmode,c?.mtls?.ca_certificate_id,
   c?.caching?.disabled];
 if(JSON.stringify(invariant(latestConfig))!==JSON.stringify(invariant(config)))
   fail('config_changed_during_check');
 const {result:again}=await read(deploymentPath);
 if(again?.deployments?.[0]?.versions?.length!==1||again.deployments[0].versions[0].percentage!==100||
  again.deployments[0].versions[0].version_id!==activeId)fail('deployment_changed');
 // A long historical-version scan must not return a clean result if D1
 // status/revision or an unresolved execution changed while checking.
 const latest=await query('SELECT id,dialect,transport,status,revision,config_id,binding_name,in_flight_count,target_metadata FROM database_connections WHERE id=?',[connectionId]);
 if(latest.length!==1||latest[0].id!==row.id||latest[0].dialect!==row.dialect||
   latest[0].transport!==row.transport||latest[0].status!=='disabled'||
   latest[0].revision!==row.revision||latest[0].config_id!==row.config_id||
   latest[0].binding_name!==row.binding_name||latest[0].target_metadata!==row.target_metadata||
   latest[0].in_flight_count!==0)
   fail('registry_changed_during_check');
 const recentShared=await query('SELECT COUNT(*) AS n FROM database_connections WHERE id<>? AND (config_id=? OR binding_name=?)',[connectionId,row.config_id,row.binding_name]);
 if(recentShared.length!==1||recentShared[0].n!==0)fail('shared_registry_reference');
 const recentOps=await query("SELECT COUNT(*) AS n FROM hyperdrive_operations WHERE logical_id=? AND phase IN ('pending','running','awaiting_confirmation','unknown')",[connectionId]);
 if(recentOps.length!==1||recentOps[0].n!==0)fail('unfinished_operation');
 // An eligibility observation is neither an Owner mutation approval nor an
 // exclusive lock. Any future write must repeat the checks under approval.
 return {eligible:true,mode,logicalId:connectionId,revision:row.revision,
  verifiedVersions:allVersions,verifiedWorkers:names.length};
}
export async function main(){
 const source=readConfiguration('database-mcp-worker',await readFile(new URL('../apps/database-mcp-worker/wrangler.jsonc',import.meta.url),'utf8'));
 const manifest=JSON.parse(await readFile(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json',import.meta.url),'utf8'));
 const result=await checkDatabaseHyperdriveRotation({mode:process.env.DATABASE_ROTATION_MODE,
  connectionId:process.env.DATABASE_ROTATION_ID,expectedRevision:process.env.DATABASE_ROTATION_REVISION,
  actor:process.env.GITHUB_ACTOR,ref:process.env.GITHUB_REF,sourceSha:process.env.GITHUB_SHA,
  accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,source,manifest});
 process.stdout.write('Read-only '+result.mode+' rotation eligibility verified; no resource changed.\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(error=>{
  const text=error instanceof Error&&/^Hyperdrive rotation preflight blocked: [a-z_]+$/.test(error.message)
   ?error.message:'Hyperdrive rotation preflight blocked: unknown';
  process.stderr.write(text+'\n');process.exitCode=1;
 });
}
