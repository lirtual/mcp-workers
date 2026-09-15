/** Cloudflare Workers entry point for the Raindrop MCP server. */
import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import { RaindropMCPService } from "./services/raindropmcp.service.js";
import { createLogger } from "./utils/logger.js";

interface Env {
  RAINDROP_ACCESS_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
  RAINDROP_RATE_LIMIT_MAX_RETRIES?: string;
}

const logger = createLogger("worker");

const parseMaxReadRetries = (value: string | undefined): number => {
  const parsed = Number(value ?? "3");
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 3;
};

const createHandler = (env: Env) =>
  createMcpHandler(
    () =>
      new RaindropMCPService({
        accessToken: env.RAINDROP_ACCESS_TOKEN,
        maxReadRetries: parseMaxReadRetries(env.RAINDROP_RATE_LIMIT_MAX_RETRIES),
        debugHttp: false,
      }).getServer(),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => logger.error("MCP handler error", error),
    },
  );

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: code, message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
      },
    },
  );
}

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

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        status: "healthy",
        service: "raindrop-mcp-worker",
        version: pkg.version,
        runtime: "cloudflare-workers",
        protocolTarget: "2026-07-28",
        httpMode: "per-request",
      });
    }

    if (url.pathname !== "/mcp") {
      return Response.json(
        {
          error: "Not Found",
          endpoints: {
            mcp: "/mcp",
            health: "/health",
          },
        },
        { status: 404 },
      );
    }

    const portalAuth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN,
      allowedOrigins: [],
    });
    if (!portalAuth.ok) {
      if (portalAuth.reason === "misconfigured") {
        logger.error("MCP_ACCESS_TOKEN is not configured");
        return jsonError(
          503,
          "portal_auth_not_configured",
          "MCP Portal authentication is not configured.",
        );
      }
      if (portalAuth.reason === "invalid_origin") {
        logger.warn("Rejected MCP request with an invalid Origin");
        return jsonError(403, "invalid_origin", "Request Origin is not allowed.");
      }
      logger.warn("Rejected MCP request with invalid Portal authentication");
      return jsonError(
        401,
        "unauthorized",
        "Valid MCP Portal authentication is required.",
      );
    }

    if (!env.RAINDROP_ACCESS_TOKEN) {
      logger.error("RAINDROP_ACCESS_TOKEN is not configured");
      return jsonError(
        503,
        "raindrop_auth_not_configured",
        "Raindrop authentication is not configured.",
      );
    }

    if (isEmptyCompatibilityProbe(request)) {
      logger.info("Accepted empty MCP compatibility probe");
      return new Response(null, { status: 204 });
    }

    // The shared Portal auth boundary removes the ingress Authorization header
    // before the request reaches the MCP SDK or any Raindrop tool/service code.
    return createHandler(env).fetch(portalAuth.request);
  },
};
