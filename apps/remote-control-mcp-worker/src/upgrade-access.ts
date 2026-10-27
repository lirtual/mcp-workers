/** Cloudflare Access identity boundary for the independent Agent-upgrade page.
 * A Portal bearer or tool confirmation must never call the owner-approved
 * transition. Missing Access configuration fails closed.
 */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

export const UPGRADE_APPROVAL_ORIGIN = "https://rca.lirtual.dpdns.org";
export interface UpgradeAccessConfig {
  teamDomain?: string;
  audience?: string;
  ownerEmail?: string;
}
export async function verifyUpgradeOwnerAccess(
  request: Request, config: UpgradeAccessConfig, fetchCerts: typeof fetch = fetch,
): Promise<boolean> {
  const { teamDomain, audience, ownerEmail } = config;
  if (!teamDomain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) ||
      !audience || !/^[a-f0-9]{64}$/.test(audience) ||
      !ownerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) return false;
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.origin !== UPGRADE_APPROVAL_ORIGIN ||
      !url.pathname.startsWith("/upgrade-approve/")) return false;
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt || jwt.length > 10_000) return false;
  try {
    const result = await fetchCerts("https://" + teamDomain + "/cdn-cgi/access/certs", {
      redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    if (!result.ok) return false;
    const set = await result.json() as JSONWebKeySet;
    if (!Array.isArray(set?.keys) || set.keys.length < 1 || set.keys.length > 16 ||
        set.keys.some(k => k.kty !== "RSA")) return false;
    const { payload, protectedHeader } = await jwtVerify(jwt, createLocalJWKSet(set), {
      issuer: "https://" + teamDomain, audience, algorithms: ["RS256"],
      clockTolerance: 5,
    });
    if (protectedHeader.alg !== "RS256" || typeof protectedHeader.kid !== "string" ||
        typeof payload.exp !== "number" || typeof payload.sub !== "string" ||
        !payload.sub || typeof payload.email !== "string" ||
        payload.email.toLowerCase() !== ownerEmail.toLowerCase() ||
        // Service-token app assertions are NOT interactive human identity.
        payload.service_token_id !== undefined || payload.service_token_status === true) return false;
    return true;
  } catch {
    // Invalid issuer/audience/signature/expiry/key/service are indistinguishable.
    return false;
  }
}

/** A form POST, same-origin request and matching one-use cookie are all needed.
 * Durable Object consumes the form token atomically separately.
 */
export function validUpgradeFormOrigin(request: Request, formToken: string): boolean {
  if (request.method !== "POST" || request.headers.get("origin") !== UPGRADE_APPROVAL_ORIGIN ||
      !/^[a-f0-9]{64}$/.test(formToken)) return false;
  const cookies = request.headers.get("cookie") ?? "";
  const values = cookies.split(";").map(s => s.trim()).filter(s => s.startsWith("rca_upgrade_csrf="));
  return values.length === 1 && values[0]!.slice("rca_upgrade_csrf=".length) === formToken;
}
export function upgradeFormCookie(formToken: string): string {
  if (!/^[a-f0-9]{64}$/.test(formToken)) throw Error("Invalid upgrade form token.");
  return "rca_upgrade_csrf=" + formToken +
    "; Path=/upgrade-approve/; Max-Age=300; Secure; HttpOnly; SameSite=Strict";
}
