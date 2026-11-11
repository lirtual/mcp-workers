/**
 * Spec #853: NON-PRODUCTION security contract probe.
 * Synthetic tokens, in-memory JWKS, fake tools, no Cloudflare/Clerk/ChatGPT calls.
 * This is neither production authentication code nor a complete MCP implementation.
 */
const decoder = new TextDecoder();

function decodePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("bad-base64url");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  return bytes;
}
function readJsonPart(value) {
  return JSON.parse(decoder.decode(decodePart(value)));
}

export async function verifySyntheticJwt(token, { jwks, issuer, now = Date.now() / 1000 }) {
  if (typeof token !== "string" || token.length > 8192) throw Error("invalid-token");
  const parts = token.split(".");
  if (parts.length !== 3) throw Error("invalid-token");
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = readJsonPart(headerPart);
  // Pinned trusted JWKS only; never honor token-provided jku/jwk/x5u/alg changes.
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw Error("invalid-alg");
  const key = jwks.keys.find(key => key.kid === header.kid && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig");
  if (!key) throw Error("unknown-kid");
  const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signature = decodePart(signaturePart);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, new TextEncoder().encode(headerPart + "." + payloadPart));
  if (!valid) throw Error("bad-signature");
  const claims = readJsonPart(payloadPart);
  if (claims.iss !== issuer || typeof claims.sub !== "string" || !claims.sub || !Number.isFinite(claims.exp) || now >= claims.exp || !Number.isFinite(claims.iat) || claims.iat > now + 60 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || now < claims.nbf))) {
    throw Error("invalid-claims");
  }
  return claims;
}

const noStore = { "cache-control": "no-store", "content-type": "application/json" };
const fail = (status, error, extras = {}) => new Response(JSON.stringify({ error }), { status, headers: { ...noStore, ...extras } });

function bearer(request) {
  const input = request.headers.get("Authorization") || "";
  const match = /^Bearer[ \t]+([^ \t]+)$/.exec(input);
  return match?.[1] || null;
}

function isScopeAllowed(scope, required) {
  return typeof scope === "string" && scope.split(" ").includes(required);
}

function hasAudience(aud, expected) {
  return typeof aud === "string" ? aud === expected : Array.isArray(aud) && aud.includes(expected);
}

export function createSyntheticMcpProbe({ resources, issuer, verify, dispatch }) {
  if (!issuer.startsWith("https://")) throw Error("unsafe-issuer");
  const routes = new Map(resources.map(r => [new URL(r.url).origin, r]));
  if (routes.size !== resources.length) throw Error("duplicate-host");
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const resource = routes.get(url.origin);
      if (!resource) return fail(404, "unknown-resource");
      const metadataPath = "/.well-known/oauth-protected-resource" + new URL(resource.url).pathname;
      const metadataUrl = url.origin + metadataPath;
      if (request.method === "GET" && url.pathname === metadataPath) {
        return new Response(JSON.stringify({ resource: resource.url, authorization_servers: [issuer], scopes_supported: [resource.scope] }), { status: 200, headers: noStore });
      }
      if (url.href !== resource.url || request.method !== "POST") return fail(404, "unknown-path");
      const challenge = { "www-authenticate": 'Bearer resource_metadata="' + metadataUrl + '"' };
      const accessToken = bearer(request);
      if (!accessToken) return fail(401, "unauthorized", challenge);
      let verified;
      try {
        verified = await verify(accessToken);
      } catch {
        // Also fail closed for provider timeouts and unexpected verification errors.
        return fail(401, "unauthorized", challenge);
      }
      if (!verified || verified.sub !== resource.ownerSub || !hasAudience(verified.aud, resource.url) || !isScopeAllowed(verified.scope, resource.scope)) {
        return fail(403, "forbidden", { ...challenge, "www-authenticate": challenge["www-authenticate"] + ', error="insufficient_scope"' });
      }
      let msg;
      try { msg = await request.json(); } catch { return fail(400, "invalid-json"); }
      if (msg?.method !== "tools/call" || !resource.allowedTools.includes(msg.params?.name)) return fail(403, "forbidden");
      try {
        // Only an already validated principal and fixed target reach the tool; raw bearer is never passed to dispatch.
        const result = await dispatch({ principal: verified.sub, resourceId: resource.id, toolName: msg.params.name });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: noStore });
      } catch {
        return fail(502, "tool-failure");
      }
    },
  };
}
