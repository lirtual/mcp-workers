/** Session-only enrollment using existing Owner DO and Workflow's private authority. */
import { deviceIsAuthorized, listLiveGrants, type V2Device } from './v2-session.ts';
import type { WorkflowSessionAuthorization } from './session-workflow-authorization.ts';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const NONCE=/^[A-Za-z0-9_-]{16,128}$/;
const SPKI=/^(?:[A-Za-z0-9+/]{4}){14}[A-Za-z0-9+/]{3}=$/;
const SIG=/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;
const PREFIX='remote-control:github-session-enrollment:v1:';
type Store=Pick<DurableObjectStorage,'get'|'list'|'delete'|'transaction'>;
type Input={kind:'github_session';attempt_id:string;oidc_jwt:string;public_key:string;nonce:string;proof:string};
type Admission={allowed:true;attempt_id:string;github_run_id:number;github_run_attempt:number;workflow_name:'ubuntu'|'windows';expires_at:number};
type AttemptRecord={device_id:string;public_key:string;expires_at:number};
const denied=(status=403,reason='denied')=>({status,body:{error:reason}});
const exactInput=(raw:unknown):Input|null=>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const p=raw as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='attempt_id,kind,nonce,oidc_jwt,proof,public_key'||
   p.kind!=='github_session'||typeof p.attempt_id!=='string'||!UUID.test(p.attempt_id)||
   typeof p.oidc_jwt!=='string'||p.oidc_jwt.length<32||p.oidc_jwt.length>8192||
   typeof p.public_key!=='string'||!SPKI.test(p.public_key)||
   typeof p.nonce!=='string'||!NONCE.test(p.nonce)||
   typeof p.proof!=='string'||!SIG.test(p.proof))return null;
 return p as Input;
};
const bytes=(text:string)=>Uint8Array.from(atob(text),s=>s.charCodeAt(0));
async function possession(p:Input,decision:Admission):Promise<boolean>{
 try{
  const publicBytes=bytes(p.public_key),signature=bytes(p.proof);
  if(publicBytes.length!==44||signature.length!==64||
    btoa(String.fromCharCode(...publicBytes))!==p.public_key||
    btoa(String.fromCharCode(...signature))!==p.proof)return false;
  const key=await crypto.subtle.importKey('spki',publicBytes.buffer as ArrayBuffer,{name:'Ed25519'},false,['verify']);
  const transcript=PREFIX+[p.attempt_id,decision.github_run_id,decision.github_run_attempt,
    decision.workflow_name,p.public_key,p.nonce].join(':');
  return crypto.subtle.verify('Ed25519',key,signature.buffer as ArrayBuffer,
    new TextEncoder().encode(transcript).buffer as ArrayBuffer);
 }catch{return false;}
}
const approved=(candidate:unknown,attemptId:string):candidate is Admission=>{
 if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return false;
 const c=candidate as Record<string,unknown>;
 return c.allowed===true&&c.attempt_id===attemptId&&
   Number.isSafeInteger(c.github_run_id)&&Number(c.github_run_id)>0&&
   Number.isSafeInteger(c.github_run_attempt)&&Number(c.github_run_attempt)>0&&
   (c.workflow_name==='ubuntu'||c.workflow_name==='windows')&&
   Number.isSafeInteger(c.expires_at)&&Number(c.expires_at)>Date.now();
};

/** Trust the Workflow JWT check, not caller-supplied workflow/expiry fields. */
export async function registerSessionDevice(store:Store,raw:unknown,binding?:WorkflowSessionAuthorization):
 Promise<{status:number;body:object}>{
 const input=exactInput(raw);
 if(!input)return denied(400,'invalid_request');
 if(!binding)return denied(503,'unavailable');
 try{
  const result=await binding.authorizeSessionAttempt({attempt_id:input.attempt_id,oidc_jwt:input.oidc_jwt});
  if(!approved(result,input.attempt_id))return denied();
  if(!await possession(input,result))return denied();
  const index='session:attempt:'+input.attempt_id;
  const outcome=await store.transaction(async tx=>{
    const prev=await tx.get<AttemptRecord>(index);
    if(prev){
      if(prev.public_key!==input.public_key||prev.expires_at!==result.expires_at)return denied(409,'attempt_conflict');
      const device=await tx.get<V2Device>('device:'+prev.device_id);
      if(!device||!deviceIsAuthorized(device)||device.public_key!==input.public_key||
        device.session_attempt_id!==input.attempt_id||
        device.session_run_id!==result.github_run_id||
        device.session_run_attempt!==result.github_run_attempt||
        device.session_workflow_name!==result.workflow_name||
        device.expires_at!==result.expires_at)return denied(409,'attempt_conflict');
      return {status:200,body:{device_id:prev.device_id,expires_at:prev.expires_at,status:'already_registered'}};
    }
    const live=await listLiveGrants(tx);
    if(!live.complete||live.active.size>=64)return denied(503,'capacity');
    if([...live.active.values()].some(device=>device.public_key===input.public_key))return denied(409,'identity_already_used');
    const deviceId=crypto.randomUUID(),time=Date.now();
    if(time>=result.expires_at)return denied();
    const keyBytes=bytes(input.public_key);
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',keyBytes));
    const fingerprint=[...digest.slice(0,12)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const row:V2Device={device_id:deviceId,name:'session-'+result.workflow_name+'-'+result.github_run_id,
      public_key:input.public_key,fingerprint,approved_at:time,revoked:false,grant_type:'session',
      session_attempt_id:input.attempt_id,session_run_id:result.github_run_id,
      session_run_attempt:result.github_run_attempt,session_workflow_name:result.workflow_name,
      expires_at:result.expires_at};
    await tx.put('device:'+deviceId,row);
    await tx.put(index,{device_id:deviceId,public_key:input.public_key,expires_at:result.expires_at});
    return {status:201,body:{device_id:deviceId,expires_at:result.expires_at,status:'registered'}};
  });
  // Cancellation after DO commit does not revoke a prior operation atomically.
  // This last check prevents the enrollment response from claiming it is ready.
  const latest=await binding.authorizeSessionAttempt({attempt_id:input.attempt_id});
  if(!approved(latest,input.attempt_id)||latest.expires_at!==result.expires_at||
      latest.github_run_id!==result.github_run_id||
      latest.github_run_attempt!==result.github_run_attempt)return denied();
  return outcome;
 }catch{return denied(503,'unavailable');}
}
