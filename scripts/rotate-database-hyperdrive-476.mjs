// Owner-confirmed password-only rotation of an already isolated, unbound Hyperdrive.
// An accepted PATCH cannot prove the write-only password or successful new SQL.
// Never auto-enable, replay ambiguous mutations, or touch an existing CA.
import {readFile} from 'node:fs/promises';
import {createDecipheriv} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readConfiguration} from './manual-worker-release.mjs';
import {checkDatabaseHyperdriveRotation} from './check-database-hyperdrive-rotation-476.mjs';
import {verifyCloudflareHyperdriveConfig} from './verify-database-hyperdrive.mjs';
import {verifyOriginSql476} from './probe-database-origin-476.mjs';

const REGISTRY='cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail=reason=>{throw Error('Hyperdrive credential update blocked: '+reason)};
const validSha=x=>/^[a-f0-9]{40}$/.test(x??'');
const cleanBase64=x=>typeof x==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x)&&Buffer.from(x,'base64').toString('base64')===x;

function passwordFromOperation(row,keyValue,keyId){
 if(row?.key_id!==keyId||!cleanBase64(keyValue)||Buffer.from(keyValue,'base64').length!==32||
    typeof row.ciphertext!=='string')fail('encrypted_payload_unavailable');
 const fields=row.ciphertext.split('.');
 if(fields.length!==2||!fields.every(cleanBase64))fail('encrypted_payload_unavailable');
 const iv=Buffer.from(fields[0],'base64'),encrypted=Buffer.from(fields[1],'base64');
 if(iv.length!==12||encrypted.length<17)fail('encrypted_payload_unavailable');
 try{
  const decipher=createDecipheriv('aes-256-gcm',Buffer.from(keyValue,'base64'),iv);
  decipher.setAAD(Buffer.from('database-mcp:hyperdrive-operation:v1:'+row.operation_id+
   ':rotate_credentials:'+row.logical_id+':'+row.expected_revision));
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain=Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]);
  const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));
  if(!payload||Object.keys(payload).length!==1||typeof payload.password!=='string'||
    Buffer.byteLength(payload.password,'utf8')<1||Buffer.byteLength(payload.password,'utf8')>2048)
    fail('encrypted_payload_invalid');
  return payload.password;
 }catch{fail('encrypted_payload_invalid')}
}

/** All remote I/O is observed at the protected Runner boundary; no secret in outputs. */
export async function runHyperdriveCredentialRotation({
 operationId,runId,actor,ref,repo,event,sourceSha,accountId,token,
 encryptionKey,keyId,source,manifest,request=fetch,preflight=checkDatabaseHyperdriveRotation,
 probeOrigin=verifyOriginSql476
}){
 if(!UUID.test(operationId??'')||!/^[1-9][0-9]*$/.test(String(runId??''))||
  !Number.isSafeInteger(Number(runId))||actor!=='lirtual'||repo!=='lirtual/mcp-workers'||
  event!=='workflow_dispatch'||ref!=='refs/heads/main'||!validSha(sourceSha)||
  !/^[a-f0-9]{32}$/i.test(accountId??'')||!token||
  !/^[A-Za-z0-9_-]{1,32}$/.test(keyId??'')||!encryptionKey)
  fail('owner_or_identity');
 const base='https://api.cloudflare.com/client/v4/accounts/'+accountId;
 async function api(path,method='GET',body){
  let res;
  try{res=await request(base+path,{method,headers:{authorization:'Bearer '+token,accept:'application/json',
   ...(body?{'content-type':'application/json'}:{})},
   ...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)})}
  catch{fail('api_outcome_unknown')}
  if(!res?.ok)fail('api_outcome_unknown');
  let result;try{result=await res.json()}catch{fail('api_outcome_unknown')}
  if(result?.success!==true||result.result==null)fail('api_outcome_unknown');
  return result.result;
 }
 async function sql(statement,params=[]){
  const answer=await api('/d1/database/'+REGISTRY+'/query','POST',
   {sql:statement,params:params.map(String)});
  if(!Array.isArray(answer)||answer.length!==1||answer[0]?.success!==true||
    !Array.isArray(answer[0].results))fail('registry_unavailable');
  return answer[0];
 }
 const rows=await sql('SELECT operation_id,logical_id,action,phase,expected_revision,config_id,binding_name,ciphertext,key_id,prepare_run_id,resource_write_started_at,expires_at FROM hyperdrive_operations WHERE operation_id=?',[operationId]);
 const op=rows.results?.[0];
 if(rows.results?.length!==1||op.operation_id!==operationId||op.action!=='rotate_credentials'||
  op.phase!=='running'||op.resource_write_started_at!==null||op.expires_at<=Date.now()||
  (op.prepare_run_id!==null&&op.prepare_run_id!==Number(runId))||
  !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(op.logical_id??'')||
  !Number.isSafeInteger(op.expected_revision)||op.expected_revision<1||
  !/^[a-f0-9]{32}$/i.test(op.config_id??'')||
  !/^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(op.binding_name??''))
  fail('operation_invalid');
 const password=passwordFromOperation(op,encryptionKey,keyId);
 // The protected Runner may win the race with the dispatcher's HTTP receipt.
 // Record one immutable Run ID so the slower Owner response cannot misreport a conflict.
 const receipt=await sql("UPDATE hyperdrive_operations SET prepare_run_id=? WHERE operation_id=? AND action='rotate_credentials' AND phase='running' AND resource_write_started_at IS NULL AND expires_at>? AND (prepare_run_id IS NULL OR prepare_run_id=?)",
  [runId,operationId,Date.now(),runId]);
 if(receipt.meta?.changes!==1)fail('run_receipt_conflict');
 let claimed=false;
 async function finish(phase,code){
  // Only scrub this exact claimed operation. A newer state must not be overwritten.
  const result=await sql("UPDATE hyperdrive_operations SET phase=?,error_class=?,ciphertext=NULL,key_id=NULL,updated_at=?,expires_at=? WHERE operation_id=? AND action='rotate_credentials' AND phase='running' AND resource_write_started_at "+(claimed?'IS NOT NULL':'IS NULL'),
   [phase,code,Date.now(),Date.now()+7*24*60*60_000,operationId]);
  if(result.meta?.changes!==1)fail('operation_receipt_unknown');
 }
 try{
  await preflight({mode:'credentials',connectionId:op.logical_id,
   expectedRevision:String(op.expected_revision),actor,ref,sourceSha,accountId,token,
   source,manifest,operationId,request});
 }catch{
  await finish('failed','credential_isolation_blocked');
  fail('isolation_unproven');
 }
 const records=await sql('SELECT id,transport,dialect,status,revision,config_id,binding_name,in_flight_count,target_metadata FROM database_connections WHERE id=?',[op.logical_id]);
 const row=records.results?.[0];
 if(records.results?.length!==1||row.id!==op.logical_id||row.transport!=='hyperdrive'||
  row.status!=='disabled'||row.revision!==op.expected_revision||row.in_flight_count!==0||
  row.config_id!==op.config_id||row.binding_name!==op.binding_name){
  await finish('failed','credential_isolation_blocked');
  fail('registry_changed');
 }
 let target;try{target=JSON.parse(row.target_metadata)}catch{
  await finish('failed','credential_isolation_blocked');fail('target_unconfirmed');
 }
 const now=Date.now();
 const claim=await sql("UPDATE hyperdrive_operations SET resource_write_started_at=?,updated_at=? WHERE operation_id=? AND phase='running' AND action='rotate_credentials' AND resource_write_started_at IS NULL AND expires_at>? AND expected_revision=? AND config_id=? AND binding_name=? AND EXISTS (SELECT 1 FROM database_connections WHERE id=? AND revision=? AND status='disabled' AND transport='hyperdrive' AND in_flight_count=0 AND config_id=? AND binding_name=?) AND NOT EXISTS (SELECT 1 FROM database_connections WHERE id<>? AND (config_id=? OR binding_name=?))",
  [now,now,operationId,now,op.expected_revision,op.config_id,op.binding_name,
   op.logical_id,op.expected_revision,op.config_id,op.binding_name,
   op.logical_id,op.config_id,op.binding_name]);
 if(claim.meta?.changes!==1){await finish('failed','credential_isolation_blocked');fail('write_claim_failed');}
 claimed=true;
 try{
  await api('/hyperdrive/configs/'+op.config_id,'PATCH',{origin:{password}});
  const updated=await api('/hyperdrive/configs/'+op.config_id);
  if(!verifyCloudflareHyperdriveConfig(target,updated))fail('config_readback_failed');
  await api('/hyperdrive/configs/'+op.config_id+'/restart','POST');
 }catch{
  try{await finish('unknown','credential_outcome_unknown')}catch{}
  fail('write_outcome_unknown');
 }
 // Only the write's result is known. Probe the existing immutable origin with
 // the write-only password while the protected Runner still holds it in memory.
 // Even successful direct origin SQL is NOT Hyperdrive/Worker E2E verification.
 let originSqlVerified=false;
 try{
  const cert=await api('/mtls_certificates/'+target.ca_certificate_id);
  if(cert?.id!==target.ca_certificate_id||cert.ca!==true||
     typeof cert.certificates!=='string')fail('ca_probe_unavailable');
  const proof=await probeOrigin({target,password,caPem:cert.certificates});
  originSqlVerified=proof?.originSqlVerified===true &&
    proof?.hyperdriveWorkerVerified===false;
 }catch{/* Read-only probe failure cannot be mistaken for a failed/unknown PATCH. */}
 if(originSqlVerified){
  await finish('completed','credential_origin_sql_verified');
  return {phase:'completed',operationId,sqlVerified:true,hyperdriveWorkerVerified:false};
 }
 await finish('awaiting_confirmation','credential_health_unverified');
 return {phase:'awaiting_confirmation',operationId,sqlVerified:false,hyperdriveWorkerVerified:false};
}

export async function main(){
 const source=readConfiguration('database-mcp-worker',
  await readFile(new URL('../apps/database-mcp-worker/wrangler.jsonc',import.meta.url),'utf8'));
 const manifest=JSON.parse(await readFile(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json',import.meta.url),'utf8'));
 const result=await runHyperdriveCredentialRotation({
  operationId:process.env.DATABASE_HYPERDRIVE_OPERATION_ID,
  runId:process.env.GITHUB_RUN_ID,actor:process.env.GITHUB_ACTOR,
  ref:process.env.GITHUB_REF,repo:process.env.GITHUB_REPOSITORY,
  event:process.env.GITHUB_EVENT_NAME,sourceSha:process.env.GITHUB_SHA,
  accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,
  encryptionKey:process.env.DATABASE_ENCRYPTION_KEY,keyId:process.env.DATABASE_KEY_ID,
  source,manifest
 });
 process.stdout.write('Password update attempted; connection disabled, inspect sanitized origin SQL probe result. Operation '+result.operationId+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(()=>{process.stderr.write('Hyperdrive credential update blocked; review sanitized D1 operation state.\n');process.exitCode=1});
}
