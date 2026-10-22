/** Remote owner confirmation over Cloudflare Access, not MCP credentials.
 * This module never creates approvals, dispatches browser effects, or trusts
 * caller-supplied subjects. A protected Access application MUST be configured
 * over the exact /browser-approve/* Worker path before enabling this route.
 */
import {createRemoteJWKSet,jwtVerify,type JWTVerifyGetKey} from "jose";
import type {BrowserApprovalIntent} from "./browser-approval.ts";

export interface BrowserApprovalAccessConfig {
  BROWSER_APPROVAL_ENABLED?: string;
  BROWSER_APPROVAL_ACCESS_ISSUER?: string;
  BROWSER_APPROVAL_ACCESS_AUD?: string;
  BROWSER_APPROVAL_ALLOWED_EMAIL?: string;
}

const jwksCache=new Map<string,JWTVerifyGetKey>();
function validated(config:BrowserApprovalAccessConfig):
  {issuer:string;audience:string;email:string}|null{
  if(config.BROWSER_APPROVAL_ENABLED!=="true")return null;
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

export function validBrowserApprovalRequest(request:Request,approvalId:string):boolean{
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(approvalId))return false;
  const url=new URL(request.url);
  // Access browser callbacks may retain query parameters or omit/alter
  // Origin and Sec-Fetch-Site on an ordinary mobile form POST. Those
  // advisory headers are not owner authorization. POST additionally needs
  // the signed Access JWT and matching CSRF form/cookie before any write.
  if(url.hash||url.pathname!=="/browser-approve/"+approvalId)return false;
  return request.method==="GET"||request.method==="POST";
}

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,c=>
  ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]??c));

const CSRF_COOKIE="__Host-rca-approval-csrf";
const CSRF_PATTERN=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** The token can only be read from the Access-verified, same-origin page.
 * SameSite=Lax+HttpOnly+Secure host-only cookie and hidden token guard form CSRF.
 * Do not trust it as owner identity: signed Access JWT is always required.
 */
export function validBrowserApprovalForm(request:Request,body:string):boolean{
  if(request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    !=="application/x-www-form-urlencoded")return false;
  const params=new URLSearchParams(body);
  const fields=[...params.keys()];
  if(fields.length!==2||params.getAll("decision").length!==1||
      params.getAll("csrf").length!==1||
      fields.some(f=>f!=="decision"&&f!=="csrf")||
      params.get("decision")!=="approve")return false;
  const token=params.get("csrf");
  if(typeof token!=="string"||!CSRF_PATTERN.test(token))return false;
  const cookies=request.headers.get("cookie")?.split(";").map(x=>x.trim())??[];
  const same=cookies.filter(c=>c.startsWith(CSRF_COOKIE+"="));
  if(same.length!==1)return false;
  const cookieToken=same[0]!.slice(CSRF_COOKIE.length+1);
  if(!CSRF_PATTERN.test(cookieToken))return false;
  // Both same-origin page token and host-only cookie must match.
  let mismatch=0;
  for(let i=0;i<token.length;i++)mismatch|=token.charCodeAt(i)^cookieToken.charCodeAt(i);
  return mismatch===0;
}

export function browserApprovalPage(
  approvalId:string,record:{status:"pending"|"approved";intent:BrowserApprovalIntent;expires_at:number},
):Response{
  const {intent}=record;
  const valid=record.status==="pending";
  const csrfToken=crypto.randomUUID();
  const title="Remote Control · Confirm browser action";
  const form=valid?`<form method="POST" action="/browser-approve/${approvalId}">
<input type="hidden" name="csrf" value="${csrfToken}">
<button type="submit" name="decision" value="approve">Approve this action once</button>
</form>`:"<p>Already approved. Return to ChatGPT to continue.</p>";
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:6vh auto;max-width:660px;padding:22px;color:#202c43}
main{padding:28px;border:1px solid #dce2eb;border-radius:14px}
h1{font-size:25px}dl{display:grid;grid-template-columns:110px 1fr;gap:8px;overflow-wrap:anywhere}
dt{font-weight:600}dd{margin:0}button{background:#174ca8;color:white;border:0;border-radius:8px;padding:14px 18px;font-size:17px;cursor:pointer}</style>
</head><body><main><h1>Confirm one browser action</h1>
<p>Review the destination and exact action before approving. This consent expires automatically.</p>
<dl><dt>Device</dt><dd>${escapeHtml(intent.device_id)}</dd>
<dt>Website</dt><dd>${escapeHtml(intent.origin)}</dd>
<dt>Page</dt><dd>${escapeHtml(intent.page_path)}</dd>
<dt>Tab</dt><dd>${escapeHtml(intent.tab_id)}</dd>
<dt>Action</dt><dd>${escapeHtml(intent.display)}</dd>
<dt>Expires</dt><dd>${escapeHtml(new Date(record.expires_at).toISOString())}</dd></dl>
${form}<p>Closing this page means you have not approved this operation.</p>
</main></body></html>`;
  return new Response(html,{status:200,headers:{
    "content-type":"text/html; charset=utf-8",
    "cache-control":"no-store",
    "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options":"nosniff","referrer-policy":"no-referrer",
    "x-frame-options":"DENY",
    "set-cookie":`${CSRF_COOKIE}=${csrfToken}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
  }});
}
