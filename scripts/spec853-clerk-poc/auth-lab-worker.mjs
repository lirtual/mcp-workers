/**
 * Spec #853 T4: isolated public OAuth interoperability probe.
 * NO production tools, no upstream permissions, no persistent state.
 * Owner identity comes from the isolated Worker environment, never from email.
 */
import { createClerkClient } from "@clerk/backend";

const RESOURCE = "https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp";
const ISSUER = "https://warm-tadpole-1093.clerk.accounts.dev";
const PUBLISHABLE_KEY = "pk_test_d2FybS10YWRwb2xlLTEwOTMuY2xlcmsuYWNjb3VudHMuZGV2JA";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const METADATA_URL = new URL(METADATA_PATH, RESOURCE).href;
const REQUIRED_SCOPE = "profile";
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const metadata = JSON.stringify({
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  bearer_methods_supported: ["header"],
  scopes_supported: [REQUIRED_SCOPE],
});
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...HEADERS, ...extra },
  });
}
function unauthorized() {
  return json({ error: "unauthorized" }, 401, {
    "www-authenticate": 'Bearer resource_metadata="' + METADATA_URL + '", scope="' + REQUIRED_SCOPE + '"',
  });
}
function wrongScope() {
  return json({ error: "insufficient_scope" }, 403, {
    "www-authenticate": 'Bearer error="insufficient_scope", scope="' + REQUIRED_SCOPE + '", resource_metadata="' + METADATA_URL + '"',
  });
}
function jwtIssuerMatches(token) {
  // SDK authenticates token first. For opaque tokens the server-side online
  // verification uses this Clerk *development instance* secret and key.
  if (typeof token !== "string" || !token.includes(".")) return true;
  const chunks = token.split(".");
  if (chunks.length !== 3 || chunks[1].length > 8192) return false;
  try {
    const value = JSON.parse(atob(chunks[1].replace(/-/g, "+").replace(/_/g, "/")));
    return value?.iss === ISSUER;
  } catch { return false; }
}
const INFO = { name: "spec853-clerk-oauth-lab", version: "0.0.1" };
const TOOL = {
  name: "lab_status",
  description: "Returns a constant message; no credentials, user data, or upstream tools.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
function rpc(id, result) { return json({ jsonrpc: "2.0", id, result }); }
function rpcError(id, code, message) { return json({ jsonrpc: "2.0", id, error: { code, message } }); }
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== new URL(RESOURCE).origin) return json({ error: "not_found" }, 404);
    if (request.method === "GET" &&
        (url.pathname === METADATA_PATH || url.pathname === "/.well-known/oauth-protected-resource")) {
      return new Response(metadata, { status: 200, headers: HEADERS });
    }
    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);
    const bearer = request.headers.get("authorization");
    if (!bearer?.startsWith("Bearer ") || !env?.CLERK_SECRET_KEY) return unauthorized();
    // A verified token is insufficient without an exact configured Owner.
    // Empty or malformed bindings MUST never turn the lab into allow-all.
    const expectedOwner = env?.CLERK_OWNER_USER_ID;
    if (typeof expectedOwner !== "string" ||
        !/^user_[A-Za-z0-9]+$/.test(expectedOwner)) return unauthorized();
    try {
      const client = createClerkClient({
        secretKey: env.CLERK_SECRET_KEY,
        publishableKey: PUBLISHABLE_KEY,
      });
      const state = await client.authenticateRequest(request, {
        acceptsToken: "oauth_token",
        audience: RESOURCE,
      });
      if (!state.isAuthenticated || state.tokenType !== "oauth_token" ||
          !jwtIssuerMatches(state.token)) return unauthorized();
      const auth = state.toAuth();
      if (auth?.userId !== expectedOwner) return unauthorized();
      if (!Array.isArray(auth.scopes) || !auth.scopes.includes(REQUIRED_SCOPE)) return wrongScope();
      // This test tool never reads users or calls upstream services.
      // Real revocation and cross-resource enforcement need separate E2E proof.
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
      }
      let msg;
      try { msg = await request.json(); } catch { return rpcError(null, -32700, "Parse error"); }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(null, -32600, "Invalid Request");
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202, headers: HEADERS });
      if (!Object.prototype.hasOwnProperty.call(msg, "id") ||
          (typeof msg.id !== "number" && typeof msg.id !== "string")) return rpcError(null, -32600, "Invalid Request");
      if (msg.method === "initialize") {
        return rpc(msg.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: INFO,
        });
      }
      if (msg.method === "ping") return rpc(msg.id, {});
      if (msg.method === "tools/list") return rpc(msg.id, { tools: [TOOL] });
      if (msg.method === "tools/call") {
        if (msg.params?.name !== TOOL.name ||
            msg.params?.arguments == null || Array.isArray(msg.params.arguments) ||
            typeof msg.params.arguments !== "object" ||
            Object.keys(msg.params.arguments).length !== 0) {
          return rpcError(msg.id, -32602, "Invalid params");
        }
        return rpc(msg.id, { content: [{ type: "text", text: "Spec853 lab: authenticated no-op" }] });
      }
      return rpcError(msg.id, -32601, "Method not found");
    } catch {
      // Never log bearer, Clerk key, token claims or user identifiers.
      return unauthorized();
    }
  },
};
