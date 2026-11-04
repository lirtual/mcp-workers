// Dedicated Access-backed Browser Activation. No independent Unknown Review ingress.
export interface BrowserAccessEnv {
  BROWSER_ACTIVATION_ORIGIN?:string;
  BROWSER_ACTIVATION_AUDIENCE?:string;
  BROWSER_ACCESS_ISSUER?:string;
  BROWSER_OWNER_EMAIL?:string;
}
// Independent activation Access audience; never derived from Portal or extension credentials.
export function activationConfig(env:BrowserAccessEnv) {
  try {
    const origin=new URL(env.BROWSER_ACTIVATION_ORIGIN!);
    const issuer=new URL(env.BROWSER_ACCESS_ISSUER!);
    if(origin.protocol!=="https:"||origin.origin!==env.BROWSER_ACTIVATION_ORIGIN||
       issuer.origin!==env.BROWSER_ACCESS_ISSUER||issuer.protocol!=="https:"||
       !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname)||
       !/^[a-f0-9]{64}$/.test(env.BROWSER_ACTIVATION_AUDIENCE??"")||
       !/^[^\s@]+@[^\s@]+$/.test(env.BROWSER_OWNER_EMAIL??""))return null;
    return {origin:origin.origin,issuer:issuer.origin,audience:env.BROWSER_ACTIVATION_AUDIENCE!,email:env.BROWSER_OWNER_EMAIL!};
  }catch{return null;}
}
function decode(s:string):Uint8Array<ArrayBuffer> {
  if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error();
  return Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
}
export async function verifyActivationOwner(request:Request,env:BrowserAccessEnv):Promise<boolean> {
  return verifyIdentity(request,activationConfig(env));
}
async function verifyIdentity(request:Request,config:ReturnType<typeof activationConfig>):Promise<boolean> {
  if(!config)return false;
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
