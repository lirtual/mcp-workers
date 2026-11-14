import { createClerkClient } from "@clerk/backend";
import {
  parseGatewayResource,
  authorizeGatewayMessage,
  filterGatewayToolList,
} from "@mcp-workers/portal-auth";

export interface Env {
  CLERK_SECRET_KEY: string;
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_OWNER_USER_ID: string;
  CLERK_ISSUER: string;
  GATEWAY_ORIGIN: string;
  PORTAL_MCP_URL: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
}

interface Dependencies {
  verifyOAuth?: (request: Request, resource: string, env: Env) => Promise<boolean>;
  sendPortal?: typeof fetch;
}

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_DISCOVERY_BYTES = 2_097_152;
const JSON_MCP = "application/json";
const SSE_MCP = "text/event-stream";

function error(status: number, code: string, challenge?: string): Response {
  return Response.json(
    { error: code },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(challenge ? { "www-authenticate": challenge } : {}),
      },
    },
  );
}

function configured(env: Env): boolean {
  const values = [
    env.CLERK_SECRET_KEY, env.CLERK_PUBLISHABLE_KEY, env.CLERK_OWNER_USER_ID,
    env.CLERK_ISSUER, env.GATEWAY_ORIGIN, env.PORTAL_MCP_URL,
    env.CF_ACCESS_CLIENT_ID, env.CF_ACCESS_CLIENT_SECRET,
  ];
  if (values.some((v) => typeof v !== "string" || !v.trim())) return false;
  if (!/^user_[a-zA-Z0-9]+$/.test(env.CLERK_OWNER_USER_ID)) return false;
  try {
    const gateway = new URL(env.GATEWAY_ORIGIN);
    const issuer = new URL(env.CLERK_ISSUER);
    const portal = new URL(env.PORTAL_MCP_URL);
    return gateway.protocol === "https:" && issuer.protocol === "https:" &&
      portal.protocol === "https:" &&
      gateway.origin === env.GATEWAY_ORIGIN &&
      issuer.origin === env.CLERK_ISSUER &&
      portal.pathname === "/mcp" && !portal.search && !portal.hash &&
      !portal.username && !portal.password;
  } catch {
    return false;
  }
}

function resourceFromMetadataPath(pathname: string): string | null {
  const prefix = "/.well-known/oauth-protected-resource";
  if (!pathname.startsWith(prefix + "/")) return null;
  return pathname.slice(prefix.length);
}

function issuerMatches(token: unknown, issuer: string): boolean {
  if (typeof token !== "string" || !token.includes(".")) return true;
  const sections = token.split(".");
  if (sections.length !== 3 || !sections[1] || sections[1].length > 8192) return false;
  try {
    const parsed = JSON.parse(atob(sections[1].replace(/-/g, "+").replace(/_/g, "/")));
    return parsed?.iss === issuer;
  } catch {
    return false;
  }
}

async function verifyOAuth(request: Request, resource: string, env: Env): Promise<boolean> {
  const client = createClerkClient({
    secretKey: env.CLERK_SECRET_KEY,
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
  });
  const state = await client.authenticateRequest(request, {
    acceptsToken: "oauth_token",
    audience: resource,
  });
  return state.isAuthenticated &&
    state.tokenType === "oauth_token" &&
    state.toAuth()?.userId === env.CLERK_OWNER_USER_ID &&
    issuerMatches(state.token, env.CLERK_ISSUER);
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function filterDiscovery(body: string, mediaType: string, serverId: string): { body: string; contentType: string } | null {
  if (mediaType.includes(JSON_MCP)) {
    try {
      const safe = filterGatewayToolList(JSON.parse(body), serverId);
      return safe ? { body: JSON.stringify(safe), contentType: JSON_MCP } : null;
    } catch {
      return null;
    }
  }
  if (!mediaType.includes(SSE_MCP)) return null;
  const events: string[] = [];
  let found = false;
  for (const raw of body.replace(/\r\n/g, "\n").split("\n\n")) {
    if (!raw.trim()) continue;
    const lines = raw.split("\n");
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return null; }
    const filtered = filterGatewayToolList(parsed, serverId);
    if (filtered === null) return null;
    found = true;
    // Recreate a minimal event: discard untrusted metadata and annotations.
    events.push("event: message\ndata: " + JSON.stringify(filtered) + "\n\n");
  }
  return found ? { body: events.join(""), contentType: SSE_MCP } : null;
}

function upstreamHeaders(request: Request, env: Env): Headers | null {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
  });
  const version = request.headers.get("Mcp-Protocol-Version");
  if (version !== null) {
    if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(version)) return null;
    headers.set("Mcp-Protocol-Version", version);
  }
  // Do not accept a client-provided Portal session or forwarding credentials.
  if (request.headers.has("Mcp-Session-Id") || request.headers.has("cookie")) return null;
  return headers;
}

export async function gatewayFetch(
  request: Request,
  env: Env,
  dependencies: Dependencies = {},
): Promise<Response> {
  if (!configured(env)) return error(503, "gateway_not_configured");
  const url = new URL(request.url);
  if (url.origin !== env.GATEWAY_ORIGIN || url.search || url.hash) return error(404, "not_found");
  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ status: "healthy", service: "mcp-gateway-worker" }, { headers: { "cache-control": "no-store" } });
  }
  const metadataPath = resourceFromMetadataPath(url.pathname);
  if (metadataPath !== null && request.method === "GET") {
    const id = parseGatewayResource(env.GATEWAY_ORIGIN + metadataPath, env.GATEWAY_ORIGIN);
    if (!id) return error(404, "not_found");
    return Response.json({
      resource: env.GATEWAY_ORIGIN + "/mcp/" + id,
      authorization_servers: [env.CLERK_ISSUER],
      bearer_methods_supported: ["header"],
    }, { headers: { "cache-control": "no-store" } });
  }
  const serverId = parseGatewayResource(request.url, env.GATEWAY_ORIGIN);
  if (!serverId) return error(404, "not_found");
  const metadataUrl = env.GATEWAY_ORIGIN + "/.well-known/oauth-protected-resource/mcp/" + serverId;
  const challenge = 'Bearer resource_metadata="' + metadataUrl + '"';
  if (request.headers.has("origin")) return error(403, "invalid_origin");
  const bearer = request.headers.get("authorization");
  if (!bearer || !/^Bearer [^\s]+$/.test(bearer)) return error(401, "unauthorized", challenge);
  const resource = env.GATEWAY_ORIGIN + "/mcp/" + serverId;
  try {
    if (!(await (dependencies.verifyOAuth ?? verifyOAuth)(request, resource, env))) {
      return error(401, "unauthorized", challenge);
    }
  } catch {
    return error(401, "unauthorized", challenge);
  }
  if (request.method !== "POST") return error(405, "method_not_allowed");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
    return error(413, "request_too_large");
  }
  let raw: string;
  try {
    raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_REQUEST_BYTES) {
      return error(413, "request_too_large");
    }
  } catch {
    return error(400, "invalid_json");
  }
  let message: unknown;
  try { message = JSON.parse(raw); } catch { return error(400, "invalid_json"); }
  const decision = authorizeGatewayMessage(message, serverId, request.headers);
  if (!decision.ok) return error(403, decision.reason);
  const headers = upstreamHeaders(request, env);
  if (!headers) return error(400, "invalid_mcp_headers");
  let upstream: Response;
  try {
    upstream = await (dependencies.sendPortal ?? fetch)(env.PORTAL_MCP_URL, {
      method: "POST",
      redirect: "manual",
      headers,
      body: raw,
    });
  } catch {
    return error(502, "portal_unavailable");
  }
  if (upstream.status >= 300 && upstream.status < 400) return error(502, "portal_redirect_rejected");
  if (decision.method !== "tools/list") {
    // No Portal authorization headers or cookies are ever returned to the client.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? JSON_MCP,
        "cache-control": "no-store",
      },
    });
  }
  if (!upstream.ok) return error(502, "portal_tools_unavailable");
  let text: string | null;
  try { text = await readLimited(upstream, MAX_DISCOVERY_BYTES); } catch { return error(502, "portal_invalid_tools"); }
  if (text === null) return error(502, "portal_invalid_tools");
  const safe = filterDiscovery(text, upstream.headers.get("content-type") ?? "", serverId);
  if (!safe) return error(502, "portal_invalid_tools");
  return new Response(safe.body, {
    status: 200,
    headers: { "content-type": safe.contentType, "cache-control": "no-store" },
  });
}

export default { fetch: (request: Request, env: Env) => gatewayFetch(request, env) };
