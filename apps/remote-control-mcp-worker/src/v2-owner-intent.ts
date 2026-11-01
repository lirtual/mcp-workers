/** Local physical owner intent, separate from the signed WSS protocol and MCP surface. */
import {deviceStillGranted,migratePermanentGrant,permanentDeadline,PERMANENT_IDLE_MS,type V2Device} from './v2-session.ts';
type Store=Pick<DurableObjectStorage,'get'|'put'|'delete'|'transaction'>;
type Action='stop'|'resume';
type Challenge={action:Action;nonce:string;generation:number;expires_at:number};
const ID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const NONCE=/^[A-Za-z0-9_-]{24}$/,SIG=/^[A-Za-z0-9_-]{86}$/;
const keyFor=(id:string)=>'owner:intent:nonce:'+id;
const permanent=(d:V2Device)=>d.grant_type===undefined||d.grant_type==='permanent';
const gen=(d:V2Device)=>d.owner_generation??0;
const safe=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<Number.MAX_SAFE_INTEGER;
const reject=(status:number,error:string)=>({status,body:{error}});
export function ownerIntentTranscript(action:Action,id:string,nonce:string,generation:number,publicKey:string):string {
 return `remote-control:v2:owner-intent:v1:${action}:${id}:${generation}:${nonce}:${publicKey}`;
}
export async function issueOwnerIntentChallenge(store:Store,input:unknown,idleMs=PERMANENT_IDLE_MS):Promise<{status:number;body:object}>{
 if(!input||typeof input!=='object'||Array.isArray(input))return reject(400,'bad_request');
 const p=input as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='action,device_id'||(p.action!=='stop'&&p.action!=='resume')||
    typeof p.device_id!=='string'||!ID.test(p.device_id))return reject(400,'bad_request');
 const d=await migratePermanentGrant(store,await store.get<V2Device>('device:'+p.device_id),Date.now(),idleMs);
 if(!d||!permanent(d)||!deviceStillGranted(d)||!safe(gen(d)))return reject(404,'not_found');
 if(p.action==='resume'&&d.owner_stopped!==true)return reject(409,'not_stopped');
 const bytes=new Uint8Array(18);crypto.getRandomValues(bytes);
 const nonce=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
 const rec:Challenge={nonce,action:p.action,generation:gen(d),expires_at:Date.now()+60_000};
 await store.put(keyFor(d.device_id),rec);
 return {status:200,body:{device_id:d.device_id,...rec}};
}
async function validSignature(device:V2Device,rec:Challenge,proof:unknown):Promise<boolean>{
 if(typeof proof!=='string'||!SIG.test(proof))return false;
 try{
  const der=Uint8Array.from(atob(device.public_key),c=>c.charCodeAt(0));
  const sig=Uint8Array.from(atob(proof.replace(/-/g,'+').replace(/_/g,'/')+'=='),c=>c.charCodeAt(0));
  if(sig.length!==64)return false;
  const key=await crypto.subtle.importKey('spki',der.buffer as ArrayBuffer,{name:'Ed25519'},false,['verify']);
  const value=new TextEncoder().encode(ownerIntentTranscript(rec.action,device.device_id,rec.nonce,rec.generation,device.public_key));
  return crypto.subtle.verify('Ed25519',key,sig.buffer as ArrayBuffer,value.buffer as ArrayBuffer);
 }catch{return false;}
}
/** Consume the signed one-time, current-generation intent in the same device transaction. */
export async function commitOwnerIntent(store:Store,input:unknown,idleMs=PERMANENT_IDLE_MS):Promise<{status:number;body:object}>{
 if(!input||typeof input!=='object'||Array.isArray(input))return reject(400,'bad_request');
 const p=input as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='action,device_id,generation,nonce,proof'||
    (p.action!=='stop'&&p.action!=='resume')||typeof p.device_id!=='string'||!ID.test(p.device_id)||
    typeof p.nonce!=='string'||!NONCE.test(p.nonce)||!safe(p.generation))return reject(400,'bad_request');
 const [device,rec]=await Promise.all([store.get<V2Device>('device:'+p.device_id),store.get<Challenge>(keyFor(p.device_id))]);
 if(!device||!permanent(device)||!deviceStillGranted(device)||!rec||
    rec.nonce!==p.nonce||rec.action!==p.action||rec.generation!==p.generation||
    rec.expires_at<=Date.now()||!await validSignature(device,rec,p.proof))return reject(401,'unauthorized');
 return store.transaction(async tx=>{
  const [current,nonce]=await Promise.all([tx.get<V2Device>('device:'+device.device_id),tx.get<Challenge>(keyFor(device.device_id))]);
  const now=Date.now();
  if(!current||!permanent(current)||current.public_key!==device.public_key||
     !deviceStillGranted(current,now)||gen(current)!==rec.generation||
     !nonce||nonce.nonce!==rec.nonce||nonce.action!==rec.action||nonce.expires_at<=now)
    return reject(401,'unauthorized');
  await tx.delete(keyFor(device.device_id));
  if(rec.action==='stop'){
   const prior=permanentDeadline(current,now);
   const expiry=current.owner_stopped?prior:Math.min(prior??now+idleMs,now+idleMs);
   if(!Number.isSafeInteger(expiry)||expiry!<=now)return reject(404,'expired');
   if(!current.owner_stopped)await tx.put('device:'+current.device_id,{
    ...current,owner_stopped:true,owner_resume_pending:false,owner_generation:rec.generation+1,
    idle_expires_at:expiry,idle_window_ms:current.idle_window_ms??idleMs,
   } satisfies V2Device);
   await tx.delete('session:epoch:'+current.device_id);
   await tx.delete('session:nonce:'+current.device_id);
   return {status:200,body:{status:'stopped',device_id:current.device_id,idle_expires_at:expiry}};
  }
  if(current.owner_stopped!==true)return reject(409,'not_stopped');
  const deadline=permanentDeadline(current,now);
  if(!Number.isSafeInteger(deadline)||deadline!<=now)return reject(404,'expired');
  await tx.put('device:'+current.device_id,{
   ...current,owner_stopped:false,owner_resume_pending:true,owner_generation:rec.generation+1,
  } satisfies V2Device);
  await tx.delete('session:epoch:'+current.device_id);
  return {status:200,body:{status:'resume_pending',device_id:current.device_id,idle_expires_at:deadline}};
 });
}
