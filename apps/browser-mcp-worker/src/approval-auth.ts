// Independent owner ingress. No MCP/Endpoint credential or bare identity header.
export interface ApprovalEnv {
  BROWSER_APPROVAL_ORIGIN?:string;
  BROWSER_ACCESS_ISSUER?:string;
  BROWSER_ACCESS_AUDIENCE?:string;
  BROWSER_OWNER_EMAIL?:string;
  // Operator assertion backed by separately recorded acceptance evidence; never
  // inferred from Access identity, an extension grant, or an Agent request.
  BROWSER_APPROVAL_ISOLATION?:string;
}
export function approvalConfig(env:ApprovalEnv) {
  try {
    const origin=new URL(env.BROWSER_APPROVAL_ORIGIN!);
    const issuer=new URL(env.BROWSER_ACCESS_ISSUER!);
    if(origin.protocol!=="https:"||origin.origin!==env.BROWSER_APPROVAL_ORIGIN||
       issuer.origin!==env.BROWSER_ACCESS_ISSUER||issuer.protocol!=="https:"||
       !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname)||
       !/^[a-f0-9]{64}$/.test(env.BROWSER_ACCESS_AUDIENCE??"")||
       !/^[^\s@]+@[^\s@]+$/.test(env.BROWSER_OWNER_EMAIL??"")||
       env.BROWSER_APPROVAL_ISOLATION!=="isolated-owner-profile-and-mailbox-v1")return null;
    return {origin:origin.origin,issuer:issuer.origin,audience:env.BROWSER_ACCESS_AUDIENCE!,email:env.BROWSER_OWNER_EMAIL!};
  }catch{return null;}
}
function decode(s:string):Uint8Array<ArrayBuffer> {
  if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error();
  return Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
}
export async function verifyOwner(request:Request,env:ApprovalEnv):Promise<boolean> {
  const config=approvalConfig(env);if(!config)return false;
  try {
    const token=request.headers.get("cf-access-jwt-assertion")??"";
    if(token.length>16384)return false;
    const parts=token.split(".");if(parts.length!==3)return false;
    const header=JSON.parse(new TextDecoder().decode(decode(parts[0]!)));
    const claims=JSON.parse(new TextDecoder().decode(decode(parts[1]!)));
    const now=Math.floor(Date.now()/1000);
    if(header.alg!=="RS256"||typeof header.kid!=="string"||header.kid.length>200||header.crit!==undefined||
       claims.iss!==config.issuer||!Array.isArray(claims.aud)||!claims.aud.includes(config.audience)||
       claims.email!==config.email||claims.type!=="app"||typeof claims.sub!=="string"||!claims.sub||
       !Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now||
       (claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now)))return false;
    // Workers does not implement Fetch redirect:error; manual plus explicit status
    // rejection fails closed without following an untrusted JWKS redirect.
    const response=await fetch(config.issuer+"/cdn-cgi/access/certs",{redirect:"manual",signal:AbortSignal.timeout(4000)});
    if(!response.ok)return false; // includes all 3xx without following Location
    const reader=response.body!.getReader();let raw="";
    while(true){const {value,done}=await reader.read();if(done)break;
      raw+=new TextDecoder().decode(value);if(raw.length>65536){await reader.cancel();return false;}}
    const jwks=JSON.parse(raw) as {keys:(JsonWebKey&{kid?:string})[]};
    const candidates=jwks.keys.filter(k=>k.kid===header.kid&&k.kty==="RSA"&&k.alg==="RS256"&&k.use==="sig");
    if(candidates.length!==1)return false;
    const key=await crypto.subtle.importKey("jwk",candidates[0]!,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,Uint8Array.from(decode(parts[2]!)),new TextEncoder().encode(parts[0]+"."+parts[1]));
  }catch{return false;}
}
export const ownerHeaders={"cache-control":"no-store","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'","x-frame-options":"DENY","referrer-policy":"no-referrer","x-content-type-options":"nosniff"};
const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function ownerPage(data:Record<string,unknown>,operation:string):Response {
  const form=data.nonce?`<form method="post" action="/owner/operations/${escape(operation)}"><input type="hidden" name="nonce" value="${escape(data.nonce)}"><button name="decision" value="approve">Approve this exact operation</button><button name="decision" value="deny">Deny</button></form>`:"";
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Browser owner approval</title><h1>Browser owner approval</h1><p>Review the exact target, action and arguments. Completion records browser dispatch, not website business success. This link grants no authority. Use an isolated owner Profile and mailbox.</p><pre>${escape(JSON.stringify({...data,nonce:undefined},null,2))}</pre>${form}</html>`,{headers:{...ownerHeaders,"content-type":"text/html; charset=utf-8"}});
}

// Unknown resolution is an owner observation, NEVER a browser execute permit.
export function ownerUnknownPage(data:Record<string,unknown>,operation:string):Response {
  const form=data.nonce?'<form method="post" action="/owner/unknown/'+escape(operation)+'"><input type="hidden" name="nonce" value="'+escape(data.nonce)+'"><button name="outcome" value="effect_seen">I observed an effect</button><button name="outcome" value="no_effect_seen">I verified no effect</button></form>':'';
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Review Unknown browser operation</title><h1>Review Unknown browser operation</h1><p>The website effect is unknown. Review it independently; do not retry this intent. Your report is not an observed completion and never grants execution. If uncertain, leave it Unknown.</p><pre>'+escape(JSON.stringify({...data,nonce:undefined},null,2))+'</pre>'+form+'</html>',{
    headers:{...ownerHeaders,"content-type":"text/html; charset=utf-8"}
  });
}
