import {verifyAccess,csrfCookie,validateCsrf} from './access.ts';
import {nonce} from './crypto.ts';
import {unbindLocal} from './lease.ts';
import {bindingStatus} from './state.ts';
import {WeixinError,fail} from './types.ts';
import type {Env} from './types.ts';

const CSP="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "+
  "base-uri 'none'; frame-ancestors 'none'";
function html(body:string,csrf?:string,status=200):Response{
  const headers=new Headers({
    'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':CSP,'x-content-type-options':'nosniff',
    'x-frame-options':'DENY','referrer-policy':'no-referrer',
  });
  if(csrf)headers.set('set-cookie',csrfCookie(csrf));
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8">'+
    '<title>Weixin owner management</title><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<style>body{font:16px/1.5 system-ui;max-width:700px;margin:40px auto;padding:0 18px}'+
    'button{padding:10px;cursor:pointer}fieldset{padding:18px;border:1px solid #999}</style>'+
    '<main>'+body+'</main></html>',{status,headers});
}
function escape(value:unknown):string{
  return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}
async function form(request:Request):Promise<URLSearchParams>{
  if((request.headers.get('content-type')??'').split(';')[0]!=='application/x-www-form-urlencoded')
    fail('invalid_content_type');
  const declaredSize=Number(request.headers.get('content-length')??'0');
  if(declaredSize>2048)fail('request_too_large');
  const reader=request.body?.getReader();
  if(!reader)fail('invalid_content_type');
  let size=0;
  const parts:Uint8Array[]=[];
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>2048)fail('request_too_large');
      parts.push(value);
    }
  }finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  try{return new URLSearchParams(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{return fail('invalid_content_type');}
}
export async function handleAdmin(request:Request,env:Env,requestFetch:typeof fetch=fetch):Promise<Response>{
  const url=new URL(request.url);
  if(url.protocol!=='https:'||url.hostname!==env.ADMIN_HOST||url.port||
    !['/setup','/setup/unbind'].includes(url.pathname)||url.search)
    return html('<h1>Not found</h1>',undefined,404);
  try{
    // Cloudflare Access JWT: RSA signature, key ID, issuer, audience,
    // expiry and exact OWNER_EMAIL, not merely a trusted request header.
    await verifyAccess(request,env,requestFetch);
    if(url.pathname==='/setup'&&request.method==='GET'){
      const state=await bindingStatus(env),csrf=nonce();
      return html('<h1>Weixin owner management</h1>'+
        '<p>Current state: <strong>'+escape(state.binding_state)+'</strong></p>'+
        '<p>Last verified context (Unix seconds): '+escape(state.last_verified_context_at)+'</p>'+
        '<p>QR pairing is not yet enabled in this Draft implementation.</p>'+
        '<fieldset><legend>Local unbind</legend>'+
        '<p>This removes the local credential reference only. It does NOT revoke credentials at Tencent.</p>'+
        '<form method="post" action="/setup/unbind">'+
        '<input type="hidden" name="csrf" value="'+csrf+'">'+
        '<label><input type="checkbox" name="confirm" value="local_unbind" required>'+
        ' Confirm local unbind and generation increment</label> '+
        '<button type="submit">Unbind local account</button></form></fieldset>',csrf);
    }
    if(url.pathname==='/setup/unbind'&&request.method==='POST'){
      const data=await form(request);
      validateCsrf(request,data.get('csrf')??'',env);
      if(data.get('confirm')!=='local_unbind')fail('confirmation_required');
      await unbindLocal(env);
      return html('<h1>Local unbind completed</h1>'+
        '<p>New binding generation is active. No upstream Tencent revocation was attempted.</p>'+
        '<a href="/setup">Back to owner management</a>');
    }
    return html('<h1>Not found</h1>',undefined,404);
  }catch(err){
    const code=err instanceof WeixinError?err.code:'admin_unavailable';
    const status=code==='not_found'?404:code==='unauthorized'?403:
      code==='auth_misconfigured'||code==='auth_unavailable'?503:
      code==='binding_busy'?409:400;
    return html('<h1>Request blocked</h1><p>'+escape(code)+'</p>'+
      '<p><a href="/setup">Return to owner management</a></p>',undefined,status);
  }
}
