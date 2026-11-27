import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

export const pairingOrigin = "https://rca.lirtual.dpdns.org";
export const clerkOwnerOrigin = pairingOrigin;
export const clerkIssuer = "https://clerk.lirtual.dpdns.org";
export const clerkBrowserSdk = clerkIssuer + "/npm/@clerk/clerk-js@6.46.3/dist/clerk.browser.js";
/** Callers supply a fixed application route, not a browser-controlled return URL. */
export function clerkOwnerSignInUrl(path: string): string {
  return "https://accounts.lirtual.dpdns.org/sign-in?redirect_url=" + encodeURIComponent(clerkOwnerOrigin + path);
}
const jwks = createRemoteJWKSet(new URL(clerkIssuer + "/.well-known/jwks.json"), {
  [customFetch]: (input, init) => fetch(input, {...init, redirect:"manual"}),
});

export interface ClerkOwnerConfig {
  CLERK_PUBLISHABLE_KEY?: string;
  CLERK_OWNER_USER_ID?: string;
}

export function clerkOwnerConfigured(config: ClerkOwnerConfig): boolean {
  if (!config.CLERK_OWNER_USER_ID || !/^user_[A-Za-z0-9]+$/.test(config.CLERK_OWNER_USER_ID)) return false;
  const key = config.CLERK_PUBLISHABLE_KEY;
  if (!key || !/^pk_live_[A-Za-z0-9+/=]+$/.test(key)) return false;
  try { return atob(key.slice("pk_live_".length)) === new URL(clerkIssuer).hostname + "$"; }
  catch { return false; }
}

/** Only the verified short-lived Clerk Owner browser session, not OAuth or Agent authority. */
export async function verifyClerkOwner(request: Request, config: ClerkOwnerConfig): Promise<boolean> {
  if (!clerkOwnerConfigured(config)) return false;
  const header = request.headers.get("authorization") ?? "";
  if (header.length > 8192) return false;
  const token = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header)?.[1];
  if (!token) return false;
  try {
    const {payload:p,protectedHeader:h} = await jwtVerify(token,jwks,{
      issuer:clerkIssuer, algorithms:["RS256"],clockTolerance:5,
      requiredClaims:["exp","iat","nbf","sub"],
    });
    const now = Math.floor(Date.now()/1000);
    const lifetime = p.exp! - p.iat!;
    // jti is optional and does not protect against replay merely by being present.
    return p.sub === config.CLERK_OWNER_USER_ID && p.azp === pairingOrigin &&
      h.typ === "JWT" && typeof h.kid === "string" && h.kid.length > 0 &&
      p.v === 2 && typeof p.sid === "string" && p.sid.startsWith("sess_") &&
      (p.sts === undefined || p.sts === "active") && p.act === undefined &&
      ["aud","client_id","scope","scp","token_type"].every(k=>p[k] === undefined) &&
      Number.isSafeInteger(p.iat) && Number.isSafeInteger(p.exp) && p.iat! <= now+5 &&
      lifetime > 0 && lifetime <= 60;
  } catch { return false; }
}
