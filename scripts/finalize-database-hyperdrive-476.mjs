// Protected release reconciliation. No deployment, activation or secret decryption.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeVersion } from './manual-worker-release.mjs';
import { verifyDatabaseHyperdriveCloudReadback } from './verify-database-hyperdrive.mjs';
const REPO='lirtual/mcp-workers', D1='cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/, SHA=/^[a-f0-9]{40}$/;
const gate=(ok,reason)=>{if(!ok)throw Object.assign(new Error('Hyperdrive reconciliation blocked'),{reason});};
export function verifyFinalizeIdentity(env) {
  gate(env.GITHUB_REPOSITORY===REPO && env.GITHUB_ACTOR==='lirtual' &&
    env.GITHUB_EVENT_NAME==='workflow_dispatch' && env.GITHUB_REF==='refs/heads/main' &&
    env.GITHUB_JOB==='database-hyperdrive-finalize' &&
    env.GITHUB_WORKFLOW_REF===REPO+'/.github/workflows/release.yml@refs/heads/main' &&
    env.DATABASE_RELEASE_ENVIRONMENT==='database-mcp-worker' &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'') && Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) &&
    SHA.test(env.GITHUB_SHA??'') && env.GITHUB_SHA===env.DATABASE_EXPECTED_RELEASE_SHA &&
    UUID.test(env.EXPECTED_VERSION_ID??'') && UUID.test(env.DATABASE_HYPERDRIVE_OPERATION_ID??''), 'finalize_identity_invalid');
  gate(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??'') &&
    ['GITHUB_TOKEN','CLOUDFLARE_API_TOKEN'].every(k=>typeof env[k]==='string' && env[k].length>0), 'finalize_credentials_unavailable');
}
export async function finalizeDatabaseHyperdrive(env=process.env,request=fetch) {
  verifyFinalizeIdentity(env);
  const id=env.DATABASE_HYPERDRIVE_OPERATION_ID, sha=env.GITHUB_SHA, runId=Number(env.GITHUB_RUN_ID);
  async function json(url,token,method='GET',body) {
    let response;
    try { response=await request(url,{method,redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{authorization:'Bearer '+token,accept:'application/json','content-type':'application/json',
        'user-agent':'lirtual-database-hyperdrive-476','x-github-api-version':'2022-11-28'},
      ...(body?{body:JSON.stringify(body)}:{})}); }
    catch {gate(false,'finalize_outcome_unknown');}
    gate(response?.ok===true,'finalize_read_or_write_rejected');
    try{return await response.json();}catch{gate(false,'finalize_outcome_unknown');}
  }
  const github=path=>json('https://api.github.com/repos/'+REPO+path,env.GITHUB_TOKEN);
  const cloud=async(path,method='GET',body)=>{
    const r=await json('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+path,
      env.CLOUDFLARE_API_TOKEN,method,body);
    gate(r?.success===true && r.result!=null,'finalize_cloud_unavailable');return r.result;
  };
  const sql=async(query,params=[])=>{
    const r=await cloud('/d1/database/'+D1+'/query','POST',{sql:query,params});
    gate(r.length===1 && r[0].success===true,'finalize_d1_unavailable');return r[0];
  };
  const operation=async()=>{
    const r=await sql('SELECT * FROM hyperdrive_operations WHERE operation_id=?',[id]);
    gate(r.results?.length===1,'finalize_operation_missing');return r.results[0];
  };
  const current=async()=>gate((await github('/git/ref/heads/main'))?.object?.sha===sha,'finalize_main_advanced');
  let row=await operation();
  const initial={...row};
  const valid=op=>op.operation_id===id && op.logical_id===initial.logical_id && op.action==='create' &&
    op.expected_revision===0 && op.ciphertext===null && op.key_id===null &&
    op.merged_sha===sha && op.release_run_id===runId && op.apply_run_id===initial.apply_run_id &&
    Number.isSafeInteger(op.apply_run_id) && op.apply_run_id>0 &&
    op.config_id===initial.config_id && op.binding_name===initial.binding_name &&
    op.expected_source_sha===initial.expected_source_sha && op.head_sha===initial.head_sha &&
    op.expires_at===initial.expires_at && op.expires_at>Date.now() &&
    ['running','completed'].includes(op.phase) &&
    ['apply_release_pending','postrelease_verified','postrelease_disabled'].includes(op.error_class);
  gate(valid(row) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.logical_id??'') &&
    /^[a-f0-9]{32}$/.test(row.config_id??'') && row.binding_name===
    'HYPERDRIVE_'+row.logical_id.replace(/-/g,'_').toUpperCase().slice(0,38)+'_'+id.slice(0,8).toUpperCase(),
    'finalize_operation_not_current');
  await current();
  const run=await github('/actions/runs/'+runId);
  gate(run.id===runId && run.head_sha===sha && run.head_branch==='main' && run.actor?.login==='lirtual' &&
    run.triggering_actor?.login==='lirtual' && run.event==='workflow_dispatch' &&
    run.path==='.github/workflows/release.yml' && ['in_progress','completed'].includes(run.status) &&
    (run.status!=='completed'||run.conclusion==='success'), 'finalize_release_mismatch');
  const jobs=await github('/actions/runs/'+runId+'/jobs?per_page=100');
  gate(Array.isArray(jobs.jobs) && jobs.total_count===jobs.jobs.length && jobs.total_count<100,
    'finalize_deploy_unproven');
  const deploy=jobs.jobs.filter(j=>j.name==='Manual selected Worker release');
  gate(deploy.length===1 && deploy[0].run_id===runId && deploy[0].head_sha===sha &&
    deploy[0].status==='completed' && deploy[0].conclusion==='success','finalize_deploy_unproven');
  async function sourceFile(path) {
    const r=await github('/contents/apps/database-mcp-worker/'+path+'?ref='+sha);
    gate(r.type==='file' && r.path==='apps/database-mcp-worker/'+path && r.encoding==='base64' &&
      typeof r.content==='string','finalize_source_invalid');
    return Buffer.from(r.content,'base64').toString('utf8');
  }
  const source=JSON.parse((await sourceFile('wrangler.jsonc')).replace(/^\s*\/\/.*$/gm,''));
  const manifest=JSON.parse(await sourceFile('hyperdrive-bindings.json'));
  gate(source.name==='database-mcp-worker' && source.d1_databases?.length===1 &&
    source.d1_databases[0].binding==='DB' && source.d1_databases[0].database_id===D1,'finalize_source_invalid');
  const entries=manifest.filter(e=>e.binding===row.binding_name && e.id===row.config_id);
  gate(entries.length===1,'finalize_binding_mismatch');
  const fields=['binding','id','dialect','origin_host','origin_port','origin_database','origin_user','ca_certificate_id'];
  gate(manifest.every(e=>Object.keys(e).length===fields.length && fields.every(k=>Object.hasOwn(e,k))),
    'finalize_source_invalid');
  const metadata=JSON.stringify(Object.fromEntries(fields.map(k=>[k,entries[0][k]])));
  const worker='/workers/scripts/database-mcp-worker';
  async function published() {
    const observed=activeVersion(await cloud(worker+'/deployments?per_page=1'));
    gate(observed.version_id===env.EXPECTED_VERSION_ID,'finalize_version_mismatch');
  }
  function bindings(settings) {
    gate(Array.isArray(settings?.bindings),'finalize_binding_mismatch');
    const db=settings.bindings.filter(b=>b.name==='DB');
    gate(db.length===1 && db[0].type==='d1' && db[0].id===D1,'finalize_binding_mismatch');
    const hd=settings.bindings.filter(b=>b.type==='hyperdrive');
    gate(hd.length===manifest.length && manifest.every(e=>
      hd.filter(b=>b.name===e.binding && b.id===e.id).length===1),'finalize_binding_mismatch');
  }
  await published();
  bindings(await cloud(worker+'/settings'));
  const version=await cloud(worker+'/versions/'+env.EXPECTED_VERSION_ID);
  gate(version.id===env.EXPECTED_VERSION_ID,'finalize_version_mismatch');
  bindings(version.resources);
  await verifyDatabaseHyperdriveCloudReadback({source,manifest,accountId:env.CLOUDFLARE_ACCOUNT_ID,
    token:env.CLOUDFLARE_API_TOKEN,request:(url,init)=>request(url,{...init,redirect:'manual'})});
  await current();await published();
  // Persist deterministic proof before insertion. Lost acknowledgements are read,
  // never retried blindly. A changed/unknown operation cannot consume this proof.
  if(row.error_class==='apply_release_pending' && row.phase==='running') {
    const at=Date.now();
    try {await sql(`UPDATE hyperdrive_operations SET published_version_id=?,verified_metadata=?,verified_at=?,
      error_class='postrelease_verified',updated_at=? WHERE operation_id=? AND action='create'
      AND phase='running' AND error_class='apply_release_pending' AND merged_sha=? AND release_run_id=?
      AND config_id=? AND binding_name=? AND expires_at>?`,
      [env.EXPECTED_VERSION_ID,metadata,at,at,id,sha,runId,row.config_id,row.binding_name,at]);}catch{/* Read proof below. */}
    row=await operation();
  }
  gate(valid(row) && row.published_version_id===env.EXPECTED_VERSION_ID && row.verified_metadata===metadata &&
    Number.isSafeInteger(row.verified_at) && ['postrelease_verified','postrelease_disabled'].includes(row.error_class),
    'finalize_proof_missing');
  const exact=c=>c && c.id===row.logical_id && c.dialect===entries[0].dialect &&
    c.transport==='hyperdrive' && c.status==='disabled' && c.revision===1 && c.ciphertext===null &&
    c.key_id===null && c.config_id===row.config_id && c.binding_name===row.binding_name &&
    c.target_metadata===metadata && c.created_at===row.verified_at && c.updated_at===row.verified_at;
  async function reference() {
    const r=await sql('SELECT * FROM database_connections WHERE id=? OR config_id=? OR binding_name=?',
      [row.logical_id,row.config_id,row.binding_name]);
    gate(Array.isArray(r.results) && r.results.length<=1 && (r.results.length===0||exact(r.results[0])),
      'finalize_d1_conflict');return r.results[0];
  }
  const retired=await sql('SELECT id FROM retired_connection_ids WHERE id=?',[row.logical_id]);
  gate(retired.results?.length===0,'finalize_retired_id');
  if(!await reference()) {
    gate(row.phase==='running','finalize_proof_missing');
    try {await sql(`INSERT INTO database_connections
      (id,dialect,transport,status,ciphertext,key_id,config_id,binding_name,revision,created_at,updated_at,target_metadata)
      SELECT logical_id,?,'hyperdrive','disabled',NULL,NULL,config_id,binding_name,1,verified_at,verified_at,verified_metadata
      FROM hyperdrive_operations WHERE operation_id=? AND phase='running' AND error_class='postrelease_verified'
      AND merged_sha=? AND release_run_id=? AND published_version_id=? AND verified_metadata=? AND expires_at>?`,
      [entries[0].dialect,id,sha,runId,env.EXPECTED_VERSION_ID,metadata,Date.now()]);}catch{/* No retry: reconcile exact row and operation. */}
  }
  gate(exact(await reference()) && valid(await operation()),'finalize_insert_unconfirmed');
  try {await sql(`UPDATE hyperdrive_operations SET phase='completed',ciphertext=NULL,key_id=NULL,
    error_class='postrelease_disabled',updated_at=? WHERE operation_id=? AND phase='running'
    AND error_class='postrelease_verified' AND merged_sha=? AND release_run_id=? AND published_version_id=?
    AND verified_metadata=? AND expires_at>? AND EXISTS (SELECT 1 FROM database_connections
      WHERE id=? AND status='disabled' AND revision=1 AND target_metadata=?)`,
    [Date.now(),id,sha,runId,env.EXPECTED_VERSION_ID,metadata,Date.now(),row.logical_id,metadata]);}catch{/* Read exact final state below. */}
  const done=await operation();
  gate(valid(done) && done.phase==='completed' && done.error_class==='postrelease_disabled' &&
    done.published_version_id===env.EXPECTED_VERSION_ID && done.verified_metadata===metadata &&
    done.verified_at===row.verified_at && done.ciphertext===null && done.key_id===null && exact(await reference()),'finalize_completion_unconfirmed');
  return {operationId:id,phase:'completed',status:'disabled',revision:1};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  finalizeDatabaseHyperdrive().then(()=>process.stdout.write(
    'Hyperdrive published reference verified and stored disabled (revision 1). Use protected /setup activation; SQL is not enabled.\n'
  )).catch(()=>{process.stderr.write('Hyperdrive post-release reconciliation BLOCKED. Preserve deployment; reconcile evidence before retry.\n');process.exitCode=1;});
}
