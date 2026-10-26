import type {Env} from './store.ts';
import {verifyPinnedGitHubActionIdentity,type GithubActionKeys} from './github-action-oidc-claim.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';

type Db=Pick<D1Database,'prepare'>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ACTION_REPO='lirtual/session-actions';
const ACTION_PATH='.github/workflows/windows.yml';
const KEY='uu.credentials';
const TTL_MS=90_000;
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
const base64=(bytes:Uint8Array)=>btoa(Array.from(bytes,x=>String.fromCharCode(x)).join(''));
const unbase64=(value:string)=>Uint8Array.from(atob(value),x=>x.charCodeAt(0));

export type SessionRuntimeDataResult=
 |{status:'ready';data:{device_id:string;verification_code:string;share_url?:string};expires_at:string}
 |{status:'unavailable';reason:'not_ready'|'expired'|'capture_unavailable'|'physical_unverified'|'unavailable'};
type Value={device_id:string;verification_code:string;share_url?:string};
type Report={attemptId:string;key:typeof KEY;sequence:number;status:'ready'|'unavailable';value?:Value};
type DataRow={run_id:string;step_id:string;attempt_id:string;key:string;sequence:number;
 status:string;ciphertext:string|null;iv:string|null;expires_at:number};
const unavailable=(reason:'not_ready'|'expired'|'capture_unavailable'|'physical_unverified'|'unavailable'):SessionRuntimeDataResult=>
 ({status:'unavailable',reason});

function validValue(value:unknown):value is Value{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const raw=value as Record<string,unknown>;
 const keys=Object.keys(raw).sort().join(',');
 return (keys==='device_id,verification_code' ||
         keys==='device_id,share_url,verification_code') &&
  typeof raw.device_id==='string' && /^[0-9]{9}$/.test(raw.device_id) &&
  typeof raw.verification_code==='string' &&
  /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8}$/.test(raw.verification_code) &&
  (!('share_url' in raw) ||
   (typeof raw.share_url==='string' &&
    /^https:\/\/uuyc\.163\.com\/invite\/[0-9a-fA-F]{32}$/.test(raw.share_url)));
}
function parseReport(raw:unknown):Report|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const value=raw as Record<string,unknown>;
 if(value.key!==KEY||typeof value.attemptId!=='string'||!UUID.test(value.attemptId)||
    !Number.isSafeInteger(value.sequence)||(value.sequence as number)<=0||
    !['ready','unavailable'].includes(String(value.status)))return null;
 const ready=value.status==='ready';
 if(Object.keys(value).sort().join(',')!==(ready?
  'attemptId,key,sequence,status,value':'attemptId,key,sequence,status'))return null;
 if(ready && (!validValue(value.value)||
   encoder.encode(JSON.stringify(value.value)).byteLength>4096))return null;
 return value as Report;
}
function secretKey(env:Env):string{
 const value=env.SESSION_RUNTIME_DATA_KEY;
 // One 256-bit key, canonical base64. No fallback key or plaintext storage.
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw Error('key_missing');
 const decoded=unbase64(value);
 if(decoded.byteLength!==32||base64(decoded)!==value)throw Error('key_invalid');
 return value;
}
async function aesKey(env:Env):Promise<CryptoKey>{
 return crypto.subtle.importKey('raw',unbase64(secretKey(env)),'AES-GCM',false,['encrypt','decrypt']);
}
function aad(row:Pick<DataRow,'run_id'|'step_id'|'attempt_id'|'key'|'sequence'>):ArrayBuffer{
 return encoder.encode(JSON.stringify([row.run_id,row.step_id,row.attempt_id,row.key,row.sequence])).buffer as ArrayBuffer;
}
async function encrypt(env:Env,row:DataRow,value:Value):Promise<Pick<DataRow,'iv'|'ciphertext'>>{
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(row)},
  await aesKey(env),encoder.encode(JSON.stringify(value)));
 return {iv:base64(iv),ciphertext:base64(new Uint8Array(cipher))};
}
async function decrypt(env:Env,row:DataRow):Promise<Value>{
 if(!row.iv||!row.ciphertext)throw Error('missing_ciphertext');
 const iv=unbase64(row.iv);
 if(iv.byteLength!==12)throw Error('invalid_iv');
 const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad(row)},
  await aesKey(env),unbase64(row.ciphertext));
 const result:unknown=JSON.parse(decoder.decode(plaintext));
 if(!validValue(result))throw Error('invalid_value');
 return result;
}

// The SQL condition is repeated INSIDE the write statement: a prior SELECT
// is never the authorization gate against a concurrent cancellation.
const admission=`EXISTS (
 SELECT 1 FROM session_executions s JOIN step_attempts a
  ON a.run_id=s.run_id AND a.step_id=s.step_id
 WHERE s.run_id=? AND s.step_id=? AND s.state='ready'
  AND a.attempt_id=? AND a.capability_id='github.action' AND a.state='claimed'
  AND a.repository=? AND instr(a.workflow_ref, ?) = 1
  AND a.owner_run_id=a.candidate_run_id
  AND a.owner_run_attempt=a.candidate_run_attempt
  AND a.owner_run_id IS NOT NULL AND a.owner_run_attempt IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c
    WHERE c.attempt_id=a.attempt_id)
)`;
// Cloudflare D1 caps LIKE patterns at 50 characters; this bound
// anchored prefix retains the same approved Action path restriction.
const pathPrefix=ACTION_REPO+'/'+ACTION_PATH+'@';
async function current(db:Db,runId:string,stepId:string,key:string):Promise<DataRow|null>{
 return db.prepare(`SELECT d.run_id,d.step_id,d.attempt_id,d.key,d.sequence,
   d.status,d.ciphertext,d.iv,d.expires_at
  FROM session_runtime_data d
  JOIN session_executions s ON s.run_id=d.run_id AND s.step_id=d.step_id
  JOIN step_attempts a ON a.run_id=d.run_id AND a.step_id=d.step_id
  WHERE d.run_id=? AND d.step_id=? AND d.key=?
    AND s.state='ready' AND a.attempt_id=d.attempt_id
    AND a.capability_id='github.action' AND a.state='claimed'
    AND a.repository=? AND instr(a.workflow_ref, ?) = 1
    AND a.owner_run_id=a.candidate_run_id
    AND a.owner_run_attempt=a.candidate_run_attempt
    AND a.owner_run_id IS NOT NULL AND a.owner_run_attempt IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c
       WHERE c.attempt_id=a.attempt_id)`)
  .bind(runId,stepId,key,ACTION_REPO,pathPrefix).first<DataRow>();
}
async function record(db:Db,env:Env,report:Report,runId:string,stepId:string):Promise<'recorded'|'already_recorded'|'denied'>{
 const timestamp=Date.now();
 const next:DataRow={run_id:runId,step_id:stepId,attempt_id:report.attemptId,
  key:report.key,sequence:report.sequence,status:report.status,
  ciphertext:null,iv:null,expires_at:timestamp+TTL_MS};
 if(report.status==='ready')Object.assign(next,await encrypt(env,next,report.value!));
 else secretKey(env); // A broken/missing encryption key is a closed gate even for tombstones.
 const written=await db.prepare(`INSERT INTO session_runtime_data
   (run_id,step_id,key,attempt_id,sequence,status,ciphertext,iv,expires_at,updated_at)
   SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${admission}
   ON CONFLICT(run_id,step_id,key) DO UPDATE SET
     sequence=excluded.sequence,status=excluded.status,
     ciphertext=excluded.ciphertext,iv=excluded.iv,
     expires_at=excluded.expires_at,updated_at=excluded.updated_at
   WHERE session_runtime_data.attempt_id=excluded.attempt_id
     AND excluded.sequence>session_runtime_data.sequence
     AND ${admission}`)
   .bind(runId,stepId,report.key,report.attemptId,report.sequence,
     report.status,next.ciphertext,next.iv,next.expires_at,timestamp,
     runId,stepId,report.attemptId,ACTION_REPO,pathPrefix,
     runId,stepId,report.attemptId,ACTION_REPO,pathPrefix).run();
 if(written.meta.changes===1)return 'recorded';
 // Only an exact replay of the current sequence/content is idempotent.
 // No TTL extension on replay and no resurrection after a tombstone.
 const existing=await current(db,runId,stepId,report.key);
 if(!existing||existing.attempt_id!==report.attemptId ||
    existing.sequence!==report.sequence||existing.status!==report.status)
   return 'denied';
 if(report.status==='unavailable')return 'already_recorded';
 try{
  const previous=await decrypt(env,existing);
  return JSON.stringify(previous)===JSON.stringify(report.value)?'already_recorded':'denied';
 }catch{return 'denied';}
}

const httpResult=(status:number,code:string)=>Response.json({result:code},
 {status,headers:{'cache-control':'no-store'}});
/** GitHub OIDC producer only; never expose on the MCP Bearer route. */
export async function handleSignedSessionDataReport(request:Request,env:Env,
 keys?:GithubActionKeys):Promise<Response>{
 if(request.method!=='POST')return httpResult(405,'method_not_allowed');
 if(!env.DB||!env.GITHUB_ACTION_OIDC_AUDIENCE)return httpResult(503,'unavailable');
 const auth=request.headers.get('authorization')||'';
 if(!auth.startsWith('Bearer ')||auth.length>8300)return httpResult(401,'unauthorized');
 const jwt=auth.slice(7);
 if(!jwt||jwt.length>8192||jwt.includes(' '))return httpResult(401,'unauthorized');
 if(Number(request.headers.get('content-length'))>8192)return httpResult(413,'too_large');
 let report:Report|null=null;
 try{
  const reader=request.body?.getReader();
  if(!reader)return httpResult(400,'invalid_request');
  const parts:Uint8Array[]=[];
  let bytes=0;
  try{
   while(true){
    const chunk=await reader.read();
    if(chunk.done)break;
    bytes+=chunk.value.byteLength;
    if(bytes>8192)return httpResult(413,'too_large');
    parts.push(chunk.value);
   }
  }finally{reader.releaseLock();}
  const buffer=new Uint8Array(bytes);
  let offset=0;
  for(const part of parts){buffer.set(part,offset);offset+=part.length;}
  report=parseReport(JSON.parse(decoder.decode(buffer)));
 }catch{return httpResult(400,'invalid_request');}
 if(!report)return httpResult(400,'invalid_request');
 try{
  const verified=await verifyPinnedGitHubActionIdentity(env.DB,report.attemptId,jwt,
   env.GITHUB_ACTION_OIDC_AUDIENCE,keys, true);
  if(!verified||verified.action.type!=='session'||
     verified.action.repository!==ACTION_REPO||
     verified.action.workflowPath!==ACTION_PATH||
     verified.row.state!=='claimed'||
     verified.row.owner_run_id!==verified.row.candidate_run_id||
     verified.row.owner_run_attempt!==verified.row.candidate_run_attempt)
    return httpResult(403,'denied');
  const outcome=await record(env.DB,env,report,verified.row.run_id,verified.row.step_id);
  return outcome==='denied'?httpResult(403,'denied'):httpResult(200,outcome);
 }catch{return httpResult(503,'unavailable');}
}

/** Owner's one explicit, fail-closed sensitive read. Run/Step are locators, not ACLs. */
export async function getSessionRuntimeData(env:Env,runId:string,stepId:string,key:string,
 inspect:typeof inspectPersistedGitHubActionAttempt=inspectPersistedGitHubActionAttempt,
 now:()=>number=Date.now):Promise<SessionRuntimeDataResult>{
 if(!UUID.test(runId)||!STEP.test(stepId)||key!==KEY)return unavailable('unavailable');
 if(!env.DB)return unavailable('unavailable');
 try{
  // Fail closed even when ciphertext is missing; the Worker must have its key.
  secretKey(env);
  const first=await current(env.DB,runId,stepId,key);
  if(!first)return unavailable('not_ready');
  if(first.status==='unavailable')return unavailable('capture_unavailable');
  if(first.status!=='ready')return unavailable('unavailable');
  if(first.expires_at<=now())return unavailable('expired');
  if(!env.WORKFLOW_GITHUB_DISPATCH_TOKEN)return unavailable('physical_unverified');
  let physical;
  try{
   physical=await inspect(env.DB,first.attempt_id,env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
  }catch{return unavailable('physical_unverified');}
  if(physical.state!=='running')return unavailable('physical_unverified');
  const latest=await current(env.DB,runId,stepId,key);
  if(!latest||latest.attempt_id!==first.attempt_id ||
     latest.sequence!==first.sequence||latest.status!=='ready')
    return unavailable('not_ready');
  if(latest.expires_at<=now())return unavailable('expired');
  const data=await decrypt(env,latest);
  // Final durable cancellation/rotation check after decryption, before returning.
  const last=await current(env.DB,runId,stepId,key);
  if(!last||last.attempt_id!==latest.attempt_id||
     last.sequence!==latest.sequence||last.status!=='ready'||
     last.expires_at<=now())return unavailable('not_ready');
  return {status:'ready',data,expires_at:new Date(latest.expires_at).toISOString()};
 }catch{return unavailable('unavailable');}
}
