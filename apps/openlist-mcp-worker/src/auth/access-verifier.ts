import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig } from "../types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccessRequest(request: Request, config: AppConfig): Promise<void> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Response("Unauthorized", { status: 401 });

  const issuer = `https://${config.accessTeamDomain}`;
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }

  try {
    await jwtVerify(token, jwks, {
      issuer,
      audience: config.accessAudience,
    });
  } catch {
    throw new Response("Unauthorized", { status: 401 });
  }
}
