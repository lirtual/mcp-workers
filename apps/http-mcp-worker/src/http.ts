export interface Env { MCP_ACCESS_TOKEN?: string; HTTP_CREDENTIALS_JSON?: string }
export type Input = {
 url: string; method?: 'GET'|'HEAD'|'POST'|'PUT'|'PATCH'|'DELETE'|'OPTIONS';
 headers?: Record<string,string>; json?: unknown; form?: Record<string,string>;
 text?: string; redirect?: 'manual'|'same-origin'; timeout_ms?: number; max_response_bytes?: number;
};
type Rule = { origin:string; prefix:string; headers:Record<string,string> };
export class HttpError extends Error { readonly code:string; constructor(code:string) { super(code); this.code=code; } }
const bytes = (s:string) => new TextEncoder().encode(s).length;
const forbidden = /^(?:host|content-length|connection|transfer-encoding|keep-alive|proxy-.*|te|trailer|upgrade|expect|accept-encoding|forwarded|x-forwarded-.*|cf-.*|sec-.*|set-cookie)$/i;
const credential = /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-.*|x-.*-token)$/i;
const responseSecret = /^(?:set-cookie|www-authenticate|proxy-authenticate|authentication-info|proxy-authentication-info|authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-.*|x-.*-token)$/i;
const headerPattern = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;
function fail(code:string): never { throw new HttpError(code); }
function record(value:unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function pairs(value:unknown, config=false):[string,string][] {
 const code = config ? 'credentials_misconfigured' : 'invalid_headers';
 if (!record(value) || Object.keys(value).length > 40) fail(code);
 let size=0; const seen=new Set<string>();
 for(const [k,v] of Object.entries(value)) {
  if (!headerPattern.test(k) || forbidden.test(k) || seen.has(k.toLowerCase()) ||
      typeof v !== 'string' || /[\u0000\r\n]/.test(v)) fail(code);
  seen.add(k.toLowerCase()); size += bytes(k+v);
 }
 if(size>16384) fail(code);
 return Object.entries(value) as [string,string][];
}
export function publicUrl(raw:string):URL {
 if(typeof raw!=='string' || raw.length>4096 || !/^https?:\/\//i.test(raw) || /[\u0000-\u0020\u007f]/.test(raw)) fail('invalid_url');
 let url:URL;
 try { url=new URL(raw); } catch { fail('invalid_url'); }
 const host=url.hostname;
 if(!['https:','http:'].includes(url.protocol) || url.username || url.password ||
   host.length>253 || host.endsWith('.') || host.includes('..') || host.includes('%') ||
   host.startsWith('[') || url.port === '0' || /^\d+(?:\.\d+)*$/.test(host) ||
   !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i.test(host) ||
   /(?:^|\.)(?:localhost|local|internal|lan|home|home\.arpa|test|invalid|onion)$/i.test(host))
   fail('unsafe_target');
 // Node URL normalizes unusual IPv4 spellings to IP literals. Cloudflare
 // strictly-public global fetch adds a platform boundary, not a DNS guarantee.
 return url;
}
const safeUrl=(u:URL)=>u.origin+u.pathname;
const inside=(path:string,prefix:string)=>prefix==='/' || path===prefix || path.startsWith(prefix+'/');
export function parseCredentials(raw?:string):Rule[] {
 if(raw==null||raw==='') return [];
 if(bytes(raw)>5120) fail('credentials_misconfigured');
 let list:unknown;
 try { list=JSON.parse(raw); } catch { fail('credentials_misconfigured'); }
 if(!Array.isArray(list)||list.length>16) fail('credentials_misconfigured');
 const rules:Rule[]=[];
 for(const item of list) {
  if(!record(item)||Object.keys(item).sort().join(',')!=='headers,origin,pathPrefix' ||
    typeof item.origin!=='string'||typeof item.pathPrefix!=='string') fail('credentials_misconfigured');
  let u:URL;
  try { u=publicUrl(item.origin); } catch { fail('credentials_misconfigured'); }
  if(u.protocol!=='https:'||item.origin!==u.origin||u.pathname!=='/'||u.search||u.hash) fail('credentials_misconfigured');
  const prefix=item.pathPrefix;
  if(!prefix.startsWith('/')||prefix.length>512||/[?#%\\]/.test(prefix) ||
    prefix.includes('//')||prefix.includes('/./')||prefix.includes('/../')||
    prefix.endsWith('/.')||prefix.endsWith('/..')||(prefix.length>1&&prefix.endsWith('/'))) fail('credentials_misconfigured');
  const headers=Object.fromEntries(pairs(item.headers,true));
  if(!Object.keys(headers).length||rules.some(r=>r.origin===u.origin&&
    (inside(prefix,r.prefix)||inside(r.prefix,prefix)))) fail('credentials_misconfigured');
  rules.push({origin:u.origin,prefix,headers});
 }
 return rules;
}
const redact=(s:string,secrets:string[])=>secrets.reduce((v,key)=>v.split(key).join('[REDACTED]'),s);
function requestHeaders(caller:[string,string][],u:URL,rules:Rule[]):Headers {
 if(u.protocol==='http:'&&caller.some(([k])=>credential.test(k))) fail('insecure_credentials');
 const h=new Headers(caller);
 for(const rule of rules) if(rule.origin===u.origin&&inside(u.pathname,rule.prefix)) {
   // Prevent upstream double-decoding from changing a credential's path scope.
   // An encoded-path request can still run without managed credentials.
   if(u.pathname.includes('%')) fail('unsafe_credential_path');
   for(const [k,v] of Object.entries(rule.headers)) {
     if(h.has(k)) fail('credential_conflict');
     h.set(k,v);
   }
 }
 return h;
}
function inputBody(input:Input,method:string):{body?:string;contentType?:string} {
 const forms=['json','form','text'].filter(k=>Object.prototype.hasOwnProperty.call(input,k));
 if(forms.length>1||(forms.length&&(method==='GET'||method==='HEAD'))) fail('invalid_body');
 let body:string|undefined,contentType:string|undefined;
 if(forms[0]==='json') {
   try { body=JSON.stringify(input.json); } catch { fail('invalid_body'); }
   if(typeof body!=='string') fail('invalid_body');
   contentType='application/json; charset=utf-8';
 } else if(forms[0]==='form') {
   if(!record(input.form)||Object.keys(input.form).length>100||
       Object.values(input.form).some(x=>typeof x!=='string')) fail('invalid_body');
   body=new URLSearchParams(input.form as Record<string,string>).toString();
   contentType='application/x-www-form-urlencoded; charset=utf-8';
 } else if(forms[0]==='text') {
   if(typeof input.text!=='string') fail('invalid_body');
   body=input.text; contentType='text/plain; charset=utf-8';
 }
 if(body!==undefined&&bytes(body)>1048576) fail('request_too_large');
 return {body,contentType};
}
async function readLimited(response:Response,max:number,signal:AbortSignal):Promise<{data:Uint8Array;truncated:boolean}> {
 if(!response.body) return {data:new Uint8Array(),truncated:false};
 const reader=response.body.getReader(),parts:Uint8Array[]=[];
 let size=0,truncated=false;
 try {
  while(true) {
   if(signal.aborted) fail('timeout');
   const p=await reader.read();
   if(p.done) break;
   if(size+p.value.length>max) {
     parts.push(p.value.subarray(0,max-size));size=max;truncated=true;break;
   }
   parts.push(p.value);size+=p.value.length;
  }
 } finally {
  if(truncated||signal.aborted) await reader.cancel().catch(()=>{});
  else reader.releaseLock();
 }
 const data=new Uint8Array(size);let offset=0;
 for(const p of parts){data.set(p,offset);offset+=p.length;}
 return {data,truncated};
}
function base64(data:Uint8Array):string {
 let binary='';
 for(let i=0;i<data.length;i+=32768) binary+=String.fromCharCode(...data.subarray(i,i+32768));
 return btoa(binary);
}
const textMime=(type:string)=>/^text\//i.test(type)||/(?:^|\/)(?:json|xml|javascript|x-www-form-urlencoded)(?:[;\s]|$)/i.test(type)||/\+(?:json|xml)(?:[;\s]|$)/i.test(type);
export async function executeHttp(input:Input,rules:Rule[],outbound:typeof fetch=fetch) {
 const requestId=crypto.randomUUID(),method=input.method??'GET',mode=input.redirect??'manual';
 const max=input.max_response_bytes??262144,timeout=input.timeout_ms??15000;
 if(!Number.isSafeInteger(max)||max<1||max>1048576||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000||
   !['manual','same-origin'].includes(mode)) fail('invalid_options');
 let url=publicUrl(input.url);
 const caller=input.headers===undefined?[]:pairs(input.headers);
 const {body,contentType}=inputBody(input,method);
 if(contentType&&!caller.some(([k])=>k.toLowerCase()==='content-type'))caller.push(['content-type',contentType]);
 const secrets=[...new Set([...rules.flatMap(r=>Object.values(r.headers)),
   ...caller.filter(([k])=>credential.test(k)).map(([,v])=>v)].filter(s=>s.length>=3))];
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 const start=Date.now(),seen=new Set<string>();let redirects=0;
 try {
  while(true) {
   if(controller.signal.aborted) fail('timeout');
   if(seen.has(url.href))fail('redirect_loop');
   seen.add(url.href);
   const headers=requestHeaders(caller,url,rules);
   const response=await outbound(url.href,{method,headers,body,redirect:'manual',signal:controller.signal});
   if(controller.signal.aborted) fail('timeout');
   const location=response.headers.get('location');
   if(mode==='same-origin'&&(method==='GET'||method==='HEAD')&&
     [301,302,303,307,308].includes(response.status)&&location) {
     let next:URL;
     try { next=new URL(location,url); }
     catch { await response.body?.cancel().catch(()=>{});fail('unsafe_redirect'); }
     if(next.origin===url.origin) {
       try { next=publicUrl(next.href); }
       catch { await response.body?.cancel().catch(()=>{});fail('unsafe_redirect'); }
       if(redirects>=5){await response.body?.cancel().catch(()=>{});fail('too_many_redirects');}
       await response.body?.cancel().catch(()=>{});
       url=next;redirects++;continue;
     }
   }
   const {data,truncated}=await readLimited(response,method==='HEAD'?1:max,controller.signal);
   if(controller.signal.aborted) fail('timeout');
   const contentType=response.headers.get('content-type')??'',safeHeaders:Record<string,string>={};
   let totalHeaderBytes=0,headerCount=0,headersTruncated=false;
   response.headers.forEach((v,k)=>{
     if(headerCount>=64 || totalHeaderBytes>=16384){headersTruncated=true;return;}
     headerCount++;
     totalHeaderBytes+=bytes(k+v);
     if(responseSecret.test(k)){safeHeaders[k]='[REDACTED]';return;}
     if(k==='location'){
       try{
         const target=new URL(v,url);
         safeHeaders[k]=['http:','https:'].includes(target.protocol)
           ? redact(safeUrl(target),secrets) : '[REDACTED]';
       }catch{safeHeaders[k]='[REDACTED]';}
       return;
     }
     safeHeaders[k]=redact(v,secrets).slice(0,4096);
   });
   let encoding='base64';const result:Record<string,unknown>={};
   if(textMime(contentType)) {
     const charset=/charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(contentType)?.[1]??'utf-8';
     let decoded:string;
     try{decoded=new TextDecoder(charset).decode(data);}catch{decoded=new TextDecoder().decode(data);}
     decoded=redact(decoded,secrets);encoding='text';
     if(/(?:^|\/|\+)json(?:[;\s]|$)/i.test(contentType)){
       try{result.json=JSON.parse(decoded);encoding='json';}catch{result.body=decoded;}
     }else result.body=decoded;
   }else result.body=base64(data);
   const elapsed=Date.now()-start;
   console.log(JSON.stringify({request_id:requestId,method,host:url.hostname,status:response.status,elapsed_ms:elapsed,bytes:data.length}));
   return {request_id:requestId,method,status:response.status,
    status_text:redact(response.statusText,secrets).slice(0,128),
    ok:response.ok,final_url:redact(safeUrl(url),secrets),headers:safeHeaders,
    headers_truncated:headersTruncated,encoding,bytes:data.length,
    truncated,elapsed_ms:elapsed,redirect_count:redirects,...result};
  }
 }catch(e) {
   if(e instanceof HttpError&&e.code!=='timeout')throw e;
   fail(['POST','PUT','PATCH','DELETE','OPTIONS'].includes(method)?'indeterminate':
     controller.signal.aborted?'timeout':'transport_error');
 }finally{clearTimeout(timer);}
}
