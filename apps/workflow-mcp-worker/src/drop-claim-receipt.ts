/** Spec #87: GitHub seals a bearer claim to the Owner-only Worker public key.
 * Ordinary Task callback, Run and Step JSON contain only a reference.
 * This module never logs, persists or exposes the plaintext outside Owner result.
 */
import {DROP_UUID} from './drop-file-contract.ts';

const PREVIEW=/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+workers\.dev\/?$/;
const B64=/^[A-Za-z0-9_-]+$/;
const TOKEN=/^[A-Za-z0-9_-]{16,1024}$/;
export type DropClaimCallback={drop_claim_v:1;preview_url:string;expires_at:number;sealed_claim:string};
export type DropClaimPublic={preview_url:string;expires_at:number;claim_receipt_ref:string};

export function isDropClaimCallback(value:unknown,now=Date.now()):value is DropClaimCallback{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const x=value as Record<string,unknown>;
 return Object.keys(x).sort().join(',')==='drop_claim_v,expires_at,preview_url,sealed_claim'&&
  x.drop_claim_v===1&&typeof x.preview_url==='string'&&x.preview_url.length<=240&&
  PREVIEW.test(x.preview_url)&&Number.isSafeInteger(x.expires_at)&&
  (x.expires_at as number)>now&&(x.expires_at as number)<=now+3600000&&
  typeof x.sealed_claim==='string'&&x.sealed_claim.length>=250&&
  x.sealed_claim.length<=3600&&B64.test(x.sealed_claim);
}
function decode64(value:string):ArrayBuffer{
 if(!B64.test(value)||value.length>8000)throw Error('drop_claim_unavailable');
 const data=atob(value.replace(/-/g,'+').replace(/_/g,'/'));
 const result=Uint8Array.from(data,c=>c.charCodeAt(0));
 if(result.length===0)throw Error('drop_claim_unavailable');
 return result.buffer as ArrayBuffer;
}
function pemKey(value:string):ArrayBuffer{
 if(!value||value.length>8000)throw Error('drop_claim_unavailable');
 const match=/^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----\s*$/.exec(value);
 if(!match)throw Error('drop_claim_unavailable');
 const data=atob(match[1]!.replace(/\s/g,''));
 return Uint8Array.from(data,c=>c.charCodeAt(0)).buffer as ArrayBuffer;
}
export async function openDropClaim(
 sealed:DropClaimCallback,attemptId:string,privateKey:string,now=Date.now(),
):Promise<string>{
 try{
  if(!DROP_UUID.test(attemptId)||!isDropClaimCallback(sealed,now))throw Error();
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(decode64(sealed.sealed_claim));
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(',')!=='ciphertext,nonce,v,wrapped_key'||v.v!==1||
     typeof v.wrapped_key!=='string'||typeof v.nonce!=='string'||
     typeof v.ciphertext!=='string')throw Error();
  const key=await crypto.subtle.importKey('pkcs8',pemKey(privateKey),{
    name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
  const aes=await crypto.subtle.decrypt({name:'RSA-OAEP'},key,decode64(v.wrapped_key));
  const secret=await crypto.subtle.importKey('raw',aes,{name:'AES-GCM'},false,['decrypt']);
  const aad=new TextEncoder().encode('drop-receipt-v1\n'+attemptId.toLowerCase()+
    '\n'+sealed.preview_url+'\n'+sealed.expires_at);
  const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(v.nonce),
    additionalData:aad,tagLength:128},secret,decode64(v.ciphertext));
  const opened:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decoded));
  if(!opened||typeof opened!=='object'||Array.isArray(opened))throw Error();
  const x=opened as Record<string,unknown>;
  if(Object.keys(x).sort().join(',')!=='attemptId,claimUrl,expiresAt,previewUrl'||
     x.attemptId!==attemptId.toLowerCase()||x.expiresAt!==sealed.expires_at||
     x.previewUrl!==sealed.preview_url||typeof x.claimUrl!=='string')throw Error();
  const url=new URL(x.claimUrl);
  if(url.protocol!=='https:'||url.hostname!=='dash.cloudflare.com'||url.port||
     url.username||url.password||url.pathname!=='/claim-preview'||url.hash||
     [...url.searchParams.keys()].join(',')!=='claimToken'||
     !TOKEN.test(url.searchParams.get('claimToken')||''))throw Error();
  return x.claimUrl;
 }catch{throw Error('drop_claim_unavailable');}
}
export async function expireDropClaimReceipts(db:Pick<D1Database,'prepare'>,at=Date.now()):Promise<number>{
 const result=await db.prepare('DELETE FROM drop_claim_receipts WHERE expires_at<=?')
  .bind(at).run();
 return result.meta.changes||0;
}
