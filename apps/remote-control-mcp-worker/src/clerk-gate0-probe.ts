// Spec #1018 Gate 0 only: temporary, no-effect browser authentication probe.
// Not an enrollment route; no access to the DeviceCoordinator or Agent.
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

const origin = "https://rca.lirtual.dpdns.org";
const issuer = "https://clerk.lirtual.dpdns.org";
const path = "/__spec1018_probe";
const login = "https://accounts.lirtual.dpdns.org/sign-in?redirect_url=" + encodeURIComponent(origin + path);
const sdk = issuer + "/npm/@clerk/clerk-js@6.46.3/dist/clerk.browser.js";
const jwks = createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"), {
  [customFetch]: (input, init) => fetch(input, {...init, redirect:"manual"}),
});

export interface ClerkProbeConfig {
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_OWNER_USER_ID?: string;
  RCA_CLERK_PROBE_EXPIRES_AT?: string;
}

export function isClerkProbePath(pathname: string): boolean {
  return pathname === path || pathname === path + "/check";
}

function enabled(config: ClerkProbeConfig): boolean {
  const expiry = config.RCA_CLERK_PROBE_EXPIRES_AT;
  const now = Math.floor(Date.now() / 1000);
  if (!expiry || !/^\d{10}$/.test(expiry) || Number(expiry) <= now || Number(expiry) > now + 1800) return false;
  if (!config.CLERK_OWNER_USER_ID || !/^user_[A-Za-z0-9]+$/.test(config.CLERK_OWNER_USER_ID)) return false;
  const key = config.CLERK_PUBLISHABLE_KEY;
  if (!key || !/^pk_live_[A-Za-z0-9+/=]+$/.test(key)) return false;
  try { return atob(key.slice("pk_live_".length)) === new URL(issuer).hostname + "$"; }
  catch { return false; }
}

function commonHeaders(): HeadersInit {
  return {
    "cache-control":"no-store",
    "referrer-policy":"no-referrer",
    "x-content-type-options":"nosniff",
    "x-frame-options":"DENY",
  };
}
function result(status: number, body: Record<string, unknown> = {verified:false}): Response {
  return Response.json(body, {status, headers:commonHeaders()});
}

function render(key: string): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const config = JSON.stringify({key,sdk,login,check:path+"/check"});
  const body = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RCA Gate 0 — identity check only</title>'+
    '<h1>RCA Clerk feasibility check</h1><p>No device will be paired or authorized. Sign in only on the official Clerk page.</p>'+
    '<p id="status" role="status">Loading…</p><button id="login" hidden>Sign in with Clerk</button><button id="cancel">Cancel</button>'+
    '<script nonce="'+nonce+'">const config='+config+';'+
    'const status=document.getElementById("status"),button=document.getElementById("login"),cancel=document.getElementById("cancel");'+
    'const stateKey="rca-spec1018-probe-return";let returning=false,cancelled=false;'+
    'try{if(location.hash||location.search){history.replaceState(null,"",location.pathname);}returning=sessionStorage.getItem(stateKey)==="pending";}catch{status.textContent="Browser storage unavailable";throw new Error("Storage unavailable");}'+
    'const clear=()=>{sessionStorage.removeItem(stateKey);};'+
    'cancel.onclick=()=>{cancelled=true;clear();button.hidden=true;status.textContent="Cancelled — no authorization";};'+
    'const script=document.createElement("script");script.src=config.sdk;script.crossOrigin="anonymous";script.setAttribute("data-clerk-publishable-key",config.key);'+
    'script.onload=async()=>{try{await Clerk.load();if(cancelled)return;'+
    'if(!Clerk.isSignedIn){status.textContent="Sign in to verify your identity";button.hidden=false;button.onclick=()=>{sessionStorage.setItem(stateKey,"pending");location.assign(config.login);};return;}'+
    'const token=await Clerk.session.getToken();if(cancelled)return;if(!token)throw new Error("Missing session");'+
    'const response=await fetch(config.check,{method:"POST",credentials:"omit",redirect:"manual",headers:{Authorization:"Bearer "+token}});'+
    'const data=await response.json();if(cancelled)return;clear();'+
    'status.textContent=response.ok&&data.verified===true?"Verified — "+data.lifetime_seconds+" second token; "+(returning?"returned from login":"existing session")+". No device authorized.":"Session profile rejected (HTTP "+response.status+(Array.isArray(data.checks)?"; "+data.checks.join(", "):"")+") — no device authorized.";'+
    '}catch{if(!cancelled){clear();status.textContent="Identity check failed — no device authorized.";}}};'+
    'script.onerror=()=>{if(!cancelled){clear();status.textContent="Clerk unavailable — no device authorized.";}};document.head.appendChild(script);</script></html>';
  return new Response(body,{status:200,headers:{
    ...commonHeaders(),
    "content-type":"text/html; charset=utf-8",
    "content-security-policy":"default-src 'none'; script-src 'nonce-"+nonce+"' "+issuer+
      "; connect-src 'self' "+issuer+"; frame-src "+issuer+"; style-src 'self' 'unsafe-inline'; img-src 'self' data: "+issuer+
      "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  }});
}

export async function handleClerkProbe(request: Request, config: ClerkProbeConfig): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== origin || !enabled(config)) return result(404);
  if (url.pathname === path) {
    if (request.method !== "GET") return result(405);
    return render(config.CLERK_PUBLISHABLE_KEY!);
  }
  if (url.pathname !== path + "/check" || url.search) return result(404);
  if (request.method !== "POST") return result(405);
  if (request.headers.get("origin") !== origin) return result(403);
  const header = request.headers.get("authorization") ?? "";
  if (header.length > 8192) return result(401);
  const token = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header)?.[1];
  if (!token) return result(401);
  try {
    const {payload:p,protectedHeader:h} = await jwtVerify(token,jwks,{
      issuer, algorithms:["RS256"],clockTolerance:5,
      requiredClaims:["exp","iat","nbf","sub"],
    });
    const now = Math.floor(Date.now()/1000);
    const lifetime = p.exp! - p.iat!;
    // Clerk reserves sid and v for session-bound tokens. The additional
    // checks preserve the intended browser/owner/freshness boundary.
    // Do not disclose profile diagnostics until the signature, issuer,
    // time claims and exact Owner identity have been verified.
    if (p.sub !== config.CLERK_OWNER_USER_ID) return result(403);
    const checks: string[] = [];
    if (p.azp !== origin) checks.push(p.azp === undefined ? "azp_missing" : "azp_mismatch");
    if (h.typ !== "JWT") checks.push("header_type");
    if (typeof h.kid !== "string" || !h.kid.length) checks.push("key_id");
    if (p.v !== 2) checks.push("session_version");
    if (typeof p.sid !== "string" || !p.sid.startsWith("sess_")) checks.push("session_id");
    // jti is optional (RFC 7519 §4.1.7); RCA does not track token IDs for replay.
    if (p.sts !== undefined && p.sts !== "active") checks.push("session_status");
    if (p.act !== undefined) checks.push("impersonation");
    if (["aud","client_id","scope","scp","token_type"].some(k=>p[k] !== undefined)) checks.push("additional_token_claims");
    if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) ||
        p.iat! > now+5 || lifetime <= 0 || lifetime > 60) checks.push("freshness");
    if (checks.length) return result(403,{verified:false,checks});
    return result(200,{verified:true,lifetime_seconds:lifetime});
  } catch { return result(401); }
}
