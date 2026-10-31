/** EnvShare v2 crypto boundary: secret key lives only in the request stack.
 * Never pass key, plaintext, or the URL fragment to D1 or a Provider RPC.
 */
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes:Uint8Array):string{
 let n=0n;
 for(const b of bytes)n=n*256n+BigInt(b);
 let s='';
 while(n>0n){s=B58[Number(n%58n)]+s;n/=58n;}
 for(const b of bytes){if(b!==0)break;s='1'+s;}
 return s||'1';
}
export function fromBase58(raw:string,maximum=24000):Uint8Array|null{
 if(!raw||raw.length>maximum)return null;
 let n=0n;
 for(const c of raw){const d=B58.indexOf(c);if(d===-1)return null;n=n*58n+BigInt(d);}
 const out:number[]=[];
 while(n>0n){out.unshift(Number(n%256n));n/=256n;}
 for(const c of raw){if(c!=='1')break;out.unshift(0);}
 return Uint8Array.from(out);
}
export type SharePayload={encrypted:string;iv:string;ttl:number;reads:number};
export async function sealEnvshare(text:unknown,ttl:number,reads:number):Promise<{
 input:SharePayload;key_base58:string
}>{
 if(typeof text!=='string'||!text.trim()||new TextEncoder().encode(text).byteLength>16384||
    !Number.isSafeInteger(ttl)||ttl<60||ttl>604800||
    !Number.isSafeInteger(reads)||reads<1||reads>10)
   throw Error('envshare_invalid_input');
 const key=crypto.getRandomValues(new Uint8Array(16));
 const iv=crypto.getRandomValues(new Uint8Array(16));
 const imported=await crypto.subtle.importKey('raw',key,{name:'AES-GCM'},false,['encrypt']);
 const encrypted=new Uint8Array(await crypto.subtle.encrypt(
  {name:'AES-GCM',iv},imported,new TextEncoder().encode(text)));
 return {input:{encrypted:base58(encrypted),iv:base58(iv),ttl,reads},key_base58:base58(key)};
}
export async function composeEnvshareUrl(key_base58:string,share_id:string,input:SharePayload):Promise<string>{
 const key=fromBase58(key_base58,30);
 const id=fromBase58(share_id,32);
 const iv=fromBase58(input.iv,32);
 const encrypted=fromBase58(input.encrypted,24000);
 if(!key||key.length!==16||!id||id.length!==16||
    !iv||iv.length!==16||!encrypted||encrypted.length<17||encrypted.length>16400)
   throw Error('envshare_invalid_key_or_result');
 // GCM authenticates the supplied one-shot key against the saved ciphertext.
 // Never return, log or persist the decrypted bytes.
 try{
  const imported=await crypto.subtle.importKey('raw',new Uint8Array(key),{name:'AES-GCM'},false,['decrypt']);
  await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(iv)},imported,new Uint8Array(encrypted));
 }catch{throw Error('envshare_invalid_key_or_result');}
 return 'https://envshare.dev/unseal#'+base58(new Uint8Array([2,...id,...key]));
}
export function checkedSharePayload(raw:unknown):raw is SharePayload{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const v=raw as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!=='encrypted,iv,reads,ttl')return false;
 const encrypted=typeof v.encrypted==='string'?fromBase58(v.encrypted):null;
 const iv=typeof v.iv==='string'?fromBase58(v.iv,32):null;
 return !!encrypted&&encrypted.length>=17&&encrypted.length<=16400&&
    !!iv&&iv.length===16&&Number.isSafeInteger(v.ttl)&&
    Number(v.ttl)>=60&&Number(v.ttl)<=604800&&Number.isSafeInteger(v.reads)&&
    Number(v.reads)>=1&&Number(v.reads)<=10;
}
