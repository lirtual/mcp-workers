/** Cloudflare Workers entry point for the Raindrop MCP server. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import { RaindropMCPService } from "./services/raindropmcp.service.js";
import { createLogger } from "./utils/logger.js";

interface Env {
  RAINDROP_ACCESS_TOKEN: string;
  MCP_ORIGIN_TOKEN: string;
  RAINDROP_RATE_LIMIT_POINTS?: string;
  RAINDROP_RATE_LIMIT_DURATION_SECONDS?: string;
  RAINDROP_RATE_LIMIT_MAX_RETRIES?: string;
}

const logger = createLogger("worker");

const mcpHandler = createMcpHandler(
  () => new RaindropMCPService().getServer(),
  {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => logger.error("MCP handler error", error),
  },
);

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, MCP-Protocol-Version, MCP-Param-*, MCP-Session-Id",
};

const withCors = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const constantTimeEqual = async (actual: string, expected: string) => {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  const actualBytes = new Uint8Array(actualHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    difference |= actualBytes[index]! ^ expectedBytes[index]!;
  }
  return difference === 0;
};

const extractBearerToken = (request: Request) => {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
};

const authenticateOrigin = async (request: Request, env: Env) => {
  if (!env.MCP_ORIGIN_TOKEN) {
    logger.error("MCP_ORIGIN_TOKEN is not configured");
    return { configured: false, authenticated: false };
  }

  const suppliedToken = extractBearerToken(request);
  if (!suppliedToken) {
    logger.warn("Rejected MCP request without origin bearer credential");
    return { configured: true, authenticated: false };
  }

  const authenticated = await constantTimeEqual(
    suppliedToken,
    env.MCP_ORIGIN_TOKEN,
  );
  if (!authenticated) {
    logger.warn("Rejected MCP request with invalid origin bearer credential");
  }
  return { configured: true, authenticated };
};

const withoutOriginCredential = (request: Request) => {
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  return new Request(request, { headers });
};

const isEmptyCompatibilityProbe = (request: Request) => {
  if (request.method !== "POST") return false;

  const contentLength = request.headers.get("Content-Length");
  const contentType = request.headers.get("Content-Type")?.toLowerCase();

  // Temporary compatibility behavior for an observed client reachability probe.
  // Authentication is always checked before this exception. Keep it narrowly
  // scoped so malformed real MCP requests still receive the SDK's normal errors.
  return contentLength === "0" && contentType === "application/octet-stream";
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          ...(origin
            ? {
                "Access-Control-Allow-Origin": origin,
                Vary: "Origin",
              }
            : {}),
        },
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(
        Response.json({
          status: "healthy",
          service: "raindrop-mcp",
          version: pkg.version,
          runtime: "cloudflare-workers",
          protocolTarget: "2026-07-28",
          httpMode: "per-request",
        }),
        origin,
      );
    }

    if (url.pathname !== "/mcp") {
      return withCors(
        Response.json(
          {
            error: "Not Found",
            endpoints: {
              mcp: "/mcp",
              health: "/health",
            },
          },
          { status: 404 },
        ),
        origin,
      );
    }

    const originAuth = await authenticateOrigin(request, env);
    if (!originAuth.configured) {
      return withCors(
        Response.json(
          { error: "MCP origin authentication is not configured" },
          { status: 500 },
        ),
        origin,
      );
    }
    if (!originAuth.authenticated) {
      return withCors(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
        origin,
      );
    }

    if (!env.RAINDROP_ACCESS_TOKEN) {
      logger.error("RAINDROP_ACCESS_TOKEN is not configured");
      return withCors(
        Response.json(
          { error: "Raindrop authentication is not configured" },
          { status: 500 },
        ),
        origin,
      );
    }

    if (isEmptyCompatibilityProbe(request)) {
      logger.info("Accepted empty MCP compatibility probe");
      return withCors(new Response(null, { status: 204 }), origin);
    }

    // Do not expose the Portal-to-origin bearer secret to the MCP SDK or tools.
    const sanitizedRequest = withoutOriginCredential(request);

    // createMcpHandler returns a web-standard fetch-shaped handler object
    // ({ fetch, close, notify, bus }), not a directly callable function.
    const response = await mcpHandler.fetch(sanitizedRequest);
    return withCors(response, origin);
  },
};
