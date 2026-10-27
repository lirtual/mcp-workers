import qrcode from 'qrcode-generator';
import {verifyAccess,csrfCookie,validateCsrf} from './access.ts';
import {nonce} from './crypto.ts';
import {unbindLocal} from './lease.ts';
import {bindingStatus} from './state.ts';
import {livePairClient,pairingView,pollPairing,startPairing,verifyPairing} from './pairing.ts';
import type {PairClient} from './pairing.ts';
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
    'button{padding:10px;cursor:pointer}fieldset{padding:18px;border:1px solid #999}'+
    'svg{width:min(90vw,360px);height:auto}pre{overflow-wrap:anywhere;white-space:pre-wrap}</style>'+
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
const hidden=(csrf:string)=>'<input type="hidden" name="csrf" value="'+escape(csrf)+'">';
function qrSvg(url:string):string{
  // SVG is locally generated from an allowlisted Tencent QR URL, never fetched
  // from an untrusted QR service. This emits static geometry, not scripts.
  if(url.length>16000||!url.startsWith('https://liteapp.weixin.qq.com/'))fail('pairing_invalid');
  const qr=qrcode(0,'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({cellSize:5,margin:3,scalable:true});
}
async function setupPage(env:Env,sub:string):Promise<Response>{
  const state=await bindingStatus(env);
  const pair=await pairingView(env,sub);
  const csrf=nonce();
  let body='<h1>Weixin owner management</h1>'+
    '<p>Current active state: <strong>'+escape(state.binding_state)+'</strong></p>'+
    '<p>Last verified context (Unix seconds): '+escape(state.last_verified_context_at)+'</p>'+
    '<p>Starting a replacement QR never switches the active account. The new session activates only after a unique owner message is verified.</p>';
  if(pair.phase==='qr_pending'&&pair.qrUrl){
    body+='<fieldset><legend>Scan your private QR</legend>'+
      '<p>Scan in Weixin on your own device. Do not forward this QR.</p>'+qrSvg(pair.qrUrl)+
      '<form method="post" action="/setup/poll">'+hidden(csrf)+
      '<label>Optional verification code (only if prompted): <input name="verify_code" type="text" inputmode="numeric" autocomplete="off" pattern="[0-9]{4,8}" maxlength="8"></label>'+
      '<button type="submit">Check scan status</button></form></fieldset>';
  }
  if(pair.phase==='bound_unverified'){
    body+='<fieldset><legend>Verify who scanned</legend>'+
      '<p>Send the following unique one-time text to your Weixin ClawBot conversation, as one message:</p>'+
      '<pre>'+escape(pair.proof)+'</pre>'+
      '<form method="post" action="/setup/verify">'+hidden(csrf)+
      '<button type="submit">Verify inbound message and activate binding</button></form></fieldset>';
  }
  body+='<fieldset><legend>Pair / rebind</legend>'+
    '<p>New QR attempts are limited. Replacing an active session requires explicit confirmation.</p>'+
    '<form method="post" action="/setup/start">'+hidden(csrf)+
    '<label><input type="checkbox" name="confirm" value="start_pairing" required> '+
    'I am pairing my own Weixin account (replace current binding after verification)</label> '+
    '<button type="submit">Create new QR</button></form></fieldset>'+
    '<fieldset><legend>Local unbind</legend>'+
    '<p>Removes the local credential reference only. It does NOT revoke credentials at Tencent.</p>'+
    '<form method="post" action="/setup/unbind">'+hidden(csrf)+
    '<label><input type="checkbox" name="confirm" value="local_unbind" required>'+
    ' Confirm local unbind and generation increment</label> '+
    '<button type="submit">Unbind local account</button></form></fieldset>';
  return html(body,csrf);
}
const allowedPaths=['/setup','/setup/start','/setup/poll','/setup/verify','/setup/unbind'];
export async function handleAdmin(
  request:Request,env:Env,requestFetch:typeof fetch=fetch,
  pairClient:PairClient=livePairClient()
):Promise<Response>{
  const url=new URL(request.url);
  if(url.protocol!=='https:'||url.hostname!==env.ADMIN_HOST||url.port||
    !allowedPaths.includes(url.pathname)||url.search)
    return html('<h1>Not found</h1>',undefined,404);
  try{
    const owner=await verifyAccess(request,env,requestFetch);
    if(url.pathname==='/setup'&&request.method==='GET')
      return setupPage(env,owner.sub);
    if(request.method!=='POST'||url.pathname==='/setup')fail('not_found');
    const data=await form(request);
    validateCsrf(request,data.get('csrf')??'',env);
    if(url.pathname==='/setup/unbind'){
      if(data.get('confirm')!=='local_unbind')fail('confirmation_required');
      await unbindLocal(env);
      // Failed cleanup cannot reactivate an old pairing: generation has changed.
      await env.DB.prepare('DELETE FROM weixin_pairing WHERE id=1').run().catch(()=>{});
      return html('<h1>Local unbind completed</h1><p>No upstream Tencent revocation was attempted.</p>'+
        '<a href="/setup">Back to owner management</a>');
    }
    if(url.pathname==='/setup/start'){
      if(data.get('confirm')!=='start_pairing')fail('confirmation_required');
      await startPairing(env,owner.sub,pairClient);
      return setupPage(env,owner.sub);
    }
    if(url.pathname==='/setup/poll'){
      const code=data.get('verify_code')?.trim();
      const result=await pollPairing(env,owner.sub,pairClient,code||undefined);
      const message=result==='confirmed'?'QR confirmed. Send the owner proof shown below.':
        result==='expired'?'QR expired; request another after the rate limit allows.':
        result==='need_verifycode'?'Verification code required. Enter the code above.':
        'No confirmed QR yet; try again after a few seconds.';
      const page=await setupPage(env,owner.sub);
      return html('<p>'+escape(message)+'</p><p><a href="/setup">Refresh owner management</a></p>',undefined,
        page.status);
    }
    if(url.pathname==='/setup/verify'){
      const result=await verifyPairing(env,owner.sub,pairClient);
      return html('<h1>'+escape(result==='ready'?'Owner verified and local binding activated':
        'Waiting for the exact owner proof message')+'</h1>'+
        '<p>Provider delivery and long-term context validity are not guaranteed.</p>'+
        '<a href="/setup">Back to owner management</a>');
    }
    fail('not_found');
  }catch(err){
    const code=err instanceof WeixinError?err.code:
      typeof err==='object'&&err!==null&&'code' in err&&
      ['UNSAFE_REDIRECT','INVALID_RESPONSE','UPSTREAM_UNAVAILABLE','UPSTREAM_HTTP_FAILURE',
        'STALE_SESSION','UPSTREAM_REJECTED'].includes(String(err.code))
        ?'upstream_unavailable':'admin_unavailable';
    const status=code==='not_found'?404:code==='unauthorized'?403:
      code==='auth_misconfigured'||code==='auth_unavailable'||code==='upstream_unavailable'||
      code==='admin_unavailable'?503:
      code==='binding_busy'||code==='binding_busy_or_changed'||code==='binding_changed'||
      code==='pairing_poll_throttled'||code==='pairing_changed'?409:400;
    return html('<h1>Request blocked</h1><p>'+escape(code)+'</p>'+
      '<p><a href="/setup">Return to owner management</a></p>',undefined,status);
  }
}
