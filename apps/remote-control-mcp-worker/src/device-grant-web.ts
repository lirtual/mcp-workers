/** Independent Cloudflare Access owner verification for changing a temporary device
 * grant into a permanent grant. Normal paired-device operations do not use this page.
 */
import {createRemoteJWKSet,jwtVerify,type JWTVerifyGetKey} from "jose";

export interface BrowserApprovalAccessConfig {
  BROWSER_APPROVAL_ACCESS_ISSUER?: string;
  BROWSER_APPROVAL_ACCESS_AUD?: string;
  BROWSER_APPROVAL_ALLOWED_EMAIL?: string;
}

const jwksCache=new Map<string,JWTVerifyGetKey>();
function validated(config:BrowserApprovalAccessConfig):
  {issuer:string;audience:string;email:string}|null{
  const issuer=config.BROWSER_APPROVAL_ACCESS_ISSUER;
  const audience=config.BROWSER_APPROVAL_ACCESS_AUD;
  const email=config.BROWSER_APPROVAL_ALLOWED_EMAIL;
  if(!issuer||!audience||!email||
    !/^[a-f0-9]{32,128}$/i.test(audience)||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return null;
  try{
    const url=new URL(issuer);
    // Canonical origin-only URL rejects credentials, ports, paths and fragments.
    if(url.protocol!=="https:"||!url.hostname.endsWith(".cloudflareaccess.com")||
      url.href!==url.origin+"/")return null;
    return {issuer:url.origin,audience,email:email.toLowerCase()};
  }catch{return null;}
}

/** The key override is test-only and never passed by the Worker entrypoint. */
export async function verifyAccessApprovalOwner(
  request:Request,config:BrowserApprovalAccessConfig,testKeys?:JWTVerifyGetKey,
):Promise<string|null>{
  const settings=validated(config);
  const jwt=request.headers.get("cf-access-jwt-assertion");
  if(!settings||!jwt||jwt.length>8192)return null;
  try {
    let keySet=testKeys??jwksCache.get(settings.issuer);
    if(!keySet){
      keySet=createRemoteJWKSet(new URL(settings.issuer+"/cdn-cgi/access/certs"));
      jwksCache.set(settings.issuer,keySet);
    }
    const {payload}=await jwtVerify(jwt,keySet,{
      issuer:settings.issuer,audience:settings.audience,algorithms:["RS256"],
      clockTolerance:5,requiredClaims:["sub","email","exp","iat"],
    });
    // Cloudflare's application-token type "app" is required; organization-wide
    // sessions and service-token credentials cannot stand in for a human.
    if(payload.type!=="app"||typeof payload.email!=="string"||
      payload.email.toLowerCase()!==settings.email||
      typeof payload.sub!=="string"||!payload.sub)return null;
    return payload.sub;
  }catch{return null;}
}

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>
  ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]??c));

const CSRF_COOKIE="__Host-rca-approval-csrf";
const CSRF_PATTERN=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Owner-session CSRF defense for the rare temporary-to-permanent grant change. */
function sameOriginCsrf(request:Request,token:string|null):boolean{
  if(typeof token!=="string"||!CSRF_PATTERN.test(token))return false;
  const cookies=request.headers.get("cookie")?.split(";").map(x=>x.trim())??[];
  const same=cookies.filter(c=>c.startsWith(CSRF_COOKIE+"="));
  if(same.length!==1)return false;
  const cookieToken=same[0]!.slice(CSRF_COOKIE.length+1);
  if(!CSRF_PATTERN.test(cookieToken))return false;
  let mismatch=0;
  for(let i=0;i<token.length;i++)mismatch|=token.charCodeAt(i)^cookieToken.charCodeAt(i);
  return mismatch===0;
}

/** Existing Cloudflare Access-protected owner path, never Agent/MCP authority.
 * The browser form reviews and confirms the exact original temporary grant.
 */
export function validPermanentGrantForm(request:Request,body:string):
  {fingerprint:string;expires_at:number}|null{
  if(request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
      !=="application/x-www-form-urlencoded")return null;
  const params=new URLSearchParams(body);
  const keys=[...params.keys()];
  const wanted=["decision","csrf","fingerprint","expires_at"];
  if(keys.length!==wanted.length||wanted.some(k=>params.getAll(k).length!==1)||
      keys.some(k=>!wanted.includes(k))||params.get("decision")!=="make_permanent")return null;
  const fingerprint=params.get("fingerprint");
  const expiry=params.get("expires_at");
  if(!fingerprint||!/^[a-f0-9]{24}$/.test(fingerprint)||
      !expiry||!/^[1-9][0-9]{0,15}$/.test(expiry))return null;
  const expires_at=Number(expiry);
  if(!sameOriginCsrf(request,params.get("csrf"))||!Number.isSafeInteger(expires_at))return null;
  return {fingerprint,expires_at};
}

export function permanentGrantApprovalPage(record:{
  device_id:string;name:string;fingerprint:string;expires_at:number;
}):Response{
  if(!CSRF_PATTERN.test(record.device_id)||
      !/^[a-f0-9]{24}$/.test(record.fingerprint)||
      !Number.isSafeInteger(record.expires_at)||
      record.expires_at<=Date.now())throw Error("Invalid temporary device grant");
  const csrfToken=crypto.randomUUID();
  const path="/browser-approve/grant/"+record.device_id;
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remote Control - Make device permanent</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:6vh auto;max-width:650px;padding:22px;color:#202c43}
main{padding:28px;border:1px solid #dce2eb;border-radius:14px}
h1{font-size:25px}dl{display:grid;grid-template-columns:120px 1fr;gap:8px;overflow-wrap:anywhere}
dt{font-weight:600}dd{margin:0}
button{background:#174ca8;color:white;border:0;border-radius:8px;padding:14px 18px;font-size:17px;cursor:pointer}</style>
</head><body><main><h1>Make this device permanently authorized?</h1>
<p><strong>Permanent grants do not expire automatically.</strong> The device will retain
access until explicitly revoked. Review the device and expiry below before approving.</p>
<dl><dt>Name</dt><dd>${escapeHtml(record.name)}</dd>
<dt>Device ID</dt><dd>${record.device_id}</dd>
<dt>Key fingerprint</dt><dd>${record.fingerprint}</dd>
<dt>Temporary expiry</dt><dd>${escapeHtml(new Date(record.expires_at).toISOString())}</dd></dl>
<form method="POST" action="${path}">
<input type="hidden" name="csrf" value="${csrfToken}">
<input type="hidden" name="fingerprint" value="${record.fingerprint}">
<input type="hidden" name="expires_at" value="${record.expires_at}">
<button type="submit" name="decision" value="make_permanent">Authorize permanently</button>
</form><p>Closing this page leaves the existing temporary grant unchanged.</p>
</main></body></html>`;
  return new Response(html,{status:200,headers:{
    "content-type":"text/html; charset=utf-8","cache-control":"no-store",
    "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"DENY",
    "set-cookie":`${CSRF_COOKIE}=${csrfToken}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
  }});
}
