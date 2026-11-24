import { clerkIssuer, pairingOrigin, clerkOwnerConfigured, verifyClerkOwner } from "./clerk-owner-session.ts";
import type { ClerkOwnerConfig } from "./clerk-owner-session.ts";
import { approvalArgs, pairingCode, lookupOwnerPairing, approveOwnerPairing } from "./pairing-owner.ts";

const pagePath = "/pair";
const lookupPath = pagePath + "/lookup";
const approvePath = pagePath + "/approve";

export function isBrowserPairingPath(path: string): boolean {
  return path === pagePath || path === lookupPath || path === approvePath;
}

function headers(): Record<string,string> {
  return {"cache-control":"no-store","referrer-policy":"no-referrer",
    "x-content-type-options":"nosniff","x-frame-options":"DENY"};
}
function result(status: number, body: object): Response {
  return Response.json(body,{status,headers:headers()});
}

function render(key: string): Response {
  const nonce=crypto.randomUUID().replaceAll("-","");
  const config=JSON.stringify({
    key,
    sdk:clerkIssuer+"/npm/@clerk/clerk-js@6.46.3/dist/clerk.browser.js",
    login:"https://accounts.lirtual.dpdns.org/sign-in?redirect_url="+encodeURIComponent(pairingOrigin+pagePath),
    lookup:lookupPath,approve:approvePath,
  });
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize RCA device</title></head><body>
<h1>Authorize RCA device</h1><p id="status" role="status">Preparing authorization…</p>
<button id="login" hidden>Sign in with Clerk</button>
<section id="details" hidden><dl><dt>Device</dt><dd id="name"></dd><dt>Fingerprint</dt><dd id="fingerprint"></dd><dt>Grant</dt><dd id="mode"></dd><dt>Expires</dt><dd id="expiry"></dd></dl>
<p>Remote operations run with the Agent's local OS permissions. Approve only a device you recognize. Compare the fingerprint shown by your installer.</p>
<label><input type="checkbox" id="match"> The fingerprint matches my terminal.</label>
<button id="approve" disabled>Approve device</button></section>
<button id="cancel">Cancel</button>
<script nonce="${nonce}">
const config=${config};
const el=id=>document.getElementById(id), status=el("status"), login=el("login"), details=el("details"), approve=el("approve"), match=el("match"), cancel=el("cancel");
const storageKey="rca-pairing", codePattern=/^[A-Z2-7]{10}$/;
let pending, reviewed, expiryTimer, stopped=false, submitted=false;
const clear=()=>{pending=undefined;sessionStorage.removeItem(storageKey);};
function finish(message){stopped=true;clearTimeout(expiryTimer);try{clear();}catch{}reviewed=undefined;details.hidden=true;login.hidden=true;cancel.disabled=true;status.textContent=message;}
function expireAt(time){clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>finish("Request expired. Check the installer."),Math.max(0,time-Date.now()));}
try{
  const fragment=location.hash.slice(1);
  if(location.hash||location.search)history.replaceState(null,"",location.pathname);
  if(fragment){clear();if(codePattern.test(fragment)){pending={code:fragment,expires:Date.now()+600000};sessionStorage.setItem(storageKey,JSON.stringify(pending));}}
  else pending=JSON.parse(sessionStorage.getItem(storageKey)||"null");
  if(!pending||!codePattern.test(pending.code)||!Number.isSafeInteger(pending.expires)||pending.expires<=Date.now()){
    finish("Open the authorization link printed by your installer.");
  }else expireAt(pending.expires);
}catch{finish("Browser storage unavailable. No device authorized.");}
cancel.onclick=()=>{if(!submitted)finish("Cancelled — no device authorized by this page.");};
match.onchange=()=>{approve.disabled=!match.checked||stopped||submitted;};
async function post(path,body){
  const token=await Clerk.session.getToken();
  if(!token||stopped)throw Error("unavailable");
  return fetch(path,{method:"POST",credentials:"omit",redirect:"manual",
    headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)});
}
approve.onclick=async()=>{
  if(!reviewed||!match.checked||stopped||submitted)return;
  if(Date.now()>=reviewed.expires_at){finish("Request expired. Check the installer.");return;}
  submitted=true;approve.disabled=true;match.disabled=true;cancel.disabled=true;clearTimeout(expiryTimer);
  try{clear();}catch{finish("Browser storage unavailable. No approval submitted.");return;}
  status.textContent="Submitting approval…";
  try{
    const r=await post(config.approve,{pairing_id:reviewed.pairing_id,expected_fingerprint:reviewed.fingerprint,expected_grant_type:reviewed.grant_type});
    const data=await r.json();
    if(r.ok&&data.status==="approved"&&data.grant_type===reviewed.grant_type){
      finish("Device approved. Check the Agent for connection status.");
    }else if([400,401,403,405,415,429].includes(r.status)){
      finish("Approval rejected. Check the installer.");
    }else{
      finish("Approval not confirmed. Check the Agent status before trying again.");
    }
  }catch{finish("Approval outcome unknown. Check the Agent status; do not repeat approval blindly.");}
};
if(!stopped){
  const script=document.createElement("script");script.src=config.sdk;script.crossOrigin="anonymous";script.setAttribute("data-clerk-publishable-key",config.key);
  script.onload=async()=>{try{
    await Clerk.load();if(stopped)return;
    if(!Clerk.isSignedIn){status.textContent="Sign in to review the pending device.";login.hidden=false;login.onclick=()=>location.assign(config.login);return;}
    const r=await post(config.lookup,{code:pending.code});if(stopped)return;
    if(!r.ok){finish("Pending device unavailable or expired. Check the installer.");return;}
    reviewed=await r.json();if(stopped)return;
    if(Date.now()>=reviewed.expires_at){finish("Request expired. Check the installer.");return;}
    el("name").textContent=reviewed.name;el("fingerprint").textContent=reviewed.fingerprint;
    el("mode").textContent=reviewed.grant_type;el("expiry").textContent=new Date(reviewed.expires_at).toLocaleString();
    details.hidden=false;status.textContent="Review this device before approving.";
    expireAt(reviewed.expires_at);
  }catch{if(!stopped)finish("Unable to verify identity or load pending device.");}};
  script.onerror=()=>{if(!stopped)finish("Clerk unavailable — no device authorized.");};
  document.head.appendChild(script);
}
</script></body></html>`;
  return new Response(html,{headers:{...headers(),"content-type":"text/html; charset=utf-8",
    "content-security-policy":"default-src 'none'; script-src 'nonce-"+nonce+"' "+clerkIssuer+
      "; connect-src 'self' "+clerkIssuer+"; frame-src "+clerkIssuer+
      "; style-src 'self' 'unsafe-inline'; img-src 'self' data: "+clerkIssuer+
      "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
}

export async function handleBrowserPairing(request: Request, config: ClerkOwnerConfig,
  getOwner: ()=>DurableObjectStub|null,
  readBounded:(request:Request,maxBytes:number)=>Promise<string|null>,
): Promise<Response> {
  const url=new URL(request.url);
  if(url.origin!==pairingOrigin||!clerkOwnerConfigured(config))return result(404,{error:"not_found"});
  if(url.pathname===pagePath){
    if(request.method!=="GET")return result(405,{error:"method_not_allowed"});
    return render(config.CLERK_PUBLISHABLE_KEY!);
  }
  if((url.pathname!==lookupPath&&url.pathname!==approvePath)||url.search)return result(404,{error:"not_found"});
  if(request.method!=="POST")return result(405,{error:"method_not_allowed"});
  if(request.headers.get("origin")!==pairingOrigin)return result(403,{error:"forbidden"});
  if(!await verifyClerkOwner(request,config))return result(401,{error:"unauthorized"});
  if(request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json")
    return result(415,{error:"invalid_request"});
  let input:unknown;
  try {const raw=await readBounded(request,4096);if(raw===null)throw Error("oversize");input=JSON.parse(raw);}
  catch{return result(400,{error:"invalid_request"});}
  const owner=getOwner();
  if(!owner)return result(503,{error:"unavailable"});
  try {
    if(url.pathname===lookupPath){
      const args=input as Record<string,unknown>|null;
      if(!args||typeof args!=="object"||Array.isArray(args)||Object.keys(args).length!==1||!pairingCode(args.code))
        return result(400,{error:"invalid_request"});
      const response=await lookupOwnerPairing(owner,args.code);
      return result(response.status,await response.json() as object);
    }
    const args=approvalArgs(input);
    if(!args)return result(400,{error:"invalid_request"});
    const response=await approveOwnerPairing(owner,args);
    return result(response.status,await response.json() as object);
  }catch{return result(503,{error:"unavailable"});}
}
