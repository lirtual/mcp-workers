import {canonical} from './cloudflare-action-contract.ts';
import {StateError} from './store.ts';
const ABC='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=(v:Uint8Array)=>{let n=0n,s='';for(const b of v)n=n*256n+BigInt(b);while(n){s=ABC[Number(n%58n)]+s;n/=58n;}for(const b of v){if(b!==0)break;s='1'+s;}return s||'1';};
function decode(s:string){
 if(!s||s.length>40)throw new StateError('invalid_envshare_key');
 let n=0n;for(const c of s){const d=ABC.indexOf(c);if(d<0)throw new StateError('invalid_envshare_key');n=n*58n+BigInt(d);}
 const out:number[]=[];while(n){out.unshift(Number(n%256n));n/=256n;}
 for(const c of s){if(c!=='1')break;out.unshift(0);}return Uint8Array.from(out);
}
const sha=async(v:Uint8Array|string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof v==='string'?new TextEncoder().encode(v):Uint8Array.from(v))),b=>b.toString(16).padStart(2,'0')).join('');
export const isEnvsharePlan=(p:{steps:Array<{uses:string;with:Record<string,unknown>}>})=>
 p.steps.length===1&&p.steps[0]?.uses==='action.run'&&p.steps[0].with.provider==='envshare'&&p.steps[0].with.action==='envshare.share_text';
export async function encryptEnvshareAdmission(raw:Record<string,unknown>){
 if(Object.keys(raw).some(k=>!['text','ttl_seconds','max_reads'].includes(k))||
    typeof raw.text!=='string'||!raw.text||
    new TextEncoder().encode(raw.text).byteLength>16384||
    (raw.ttl_seconds!==undefined&&(!Number.isSafeInteger(raw.ttl_seconds)||Number(raw.ttl_seconds)<60||Number(raw.ttl_seconds)>604800))||
    (raw.max_reads!==undefined&&(!Number.isSafeInteger(raw.max_reads)||Number(raw.max_reads)<1||Number(raw.max_reads)>10)))
  throw new StateError('invalid_envshare_input');
 const key=crypto.getRandomValues(new Uint8Array(16));
 const iv=crypto.getRandomValues(new Uint8Array(16));
 const aes=await crypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt']);
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(raw.text)));
 const inputs={encrypted:b58(encrypted),iv:b58(iv),ttl:raw.ttl_seconds??86400,reads:raw.max_reads??1,key_digest:await sha(key)};
 return {inputs,delivery_key:b58(key),request_digest:await sha(JSON.stringify(canonical(inputs)))};
}
export async function buildEnvshareLink(inputs:unknown,idRaw:unknown,delivery_key:string){
 if(!inputs||typeof inputs!=='object'||Array.isArray(inputs)||typeof (inputs as {key_digest?:unknown}).key_digest!=='string')throw new StateError('envshare_not_available');
 const key=decode(delivery_key);
 if(key.length!==16||b58(key)!==delivery_key||await sha(key)!==(inputs as {key_digest:string}).key_digest)throw new StateError('invalid_envshare_key');
 if(typeof idRaw!=='string'||idRaw.length<16||idRaw.length>32)throw new StateError('envshare_result_unavailable');
 const id=decode(idRaw);if(id.length!==16||b58(id)!==idRaw)throw new StateError('envshare_result_unavailable');
 return 'https://envshare.dev/unseal#'+b58(new Uint8Array([2,...id,...key]));
}
