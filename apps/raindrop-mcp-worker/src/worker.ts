/** Cloudflare Workers entry point for the Raindrop MCP server. */
import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import { RaindropMCPService } from "./services/raindropmcp.service.js";
import { EXECUTION_LIMITS, readBounded } from "./services/execution-budget.js";
import { createLogger } from "./utils/logger.js";

interface Env {
  RAINDROP_ACCESS_TOKEN: string;
  MCP_ACCESS_TOKEN: string;
  RAINDROP_RATE_LIMIT_MAX_RETRIES?: string;
}

const logger = createLogger("worker");

const parseMaxReadRetries = (value: string | undefined): number => {
  const parsed = Number(value ?? "3");
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(3, parsed) : 3;
};

const createHandler = (env: Env, signal: AbortSignal) =>
  createMcpHandler(
    () =>
      new RaindropMCPService({
        accessToken: env.RAINDROP_ACCESS_TOKEN,
        maxReadRetries: parseMaxReadRetries(env.RAINDROP_RATE_LIMIT_MAX_RETRIES),
        debugHttp: false,
        signal,
      }).getServer(),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: () => logger.error("MCP handler error"),
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
    // Check actual streamed bytes: Content-Length is untrusted and may be absent.
    // Keep authentication and the empty compatibility probe ahead of this read.
    // Ingress happens BEFORE the request-scoped upstream budget is created.
    // Bound the streaming read itself and propagate client disconnects.
    const ingress = new AbortController();
    const abortIngress = () => ingress.abort();
    portalAuth.request.signal.addEventListener("abort", abortIngress, { once: true });
    if (portalAuth.request.signal.aborted) abortIngress();
    const ingressTimeout = setTimeout(abortIngress, EXECUTION_LIMITS.fetchMs);
    let body: Uint8Array;
    try {
      body = await readBounded(
        portalAuth.request.body,
        EXECUTION_LIMITS.requestBytes,
        ingress.signal,
      );
      if (ingress.signal.aborted) {
        return jsonError(408, "REQUEST_BODY_TIMEOUT", "MCP request body timed out or was cancelled.");
      }
    } catch {
      if (ingress.signal.aborted) {
        return jsonError(408, "REQUEST_BODY_TIMEOUT", "MCP request body timed out or was cancelled.");
      }
      return jsonError(413, "REQUEST_TOO_LARGE", "MCP request exceeds 128 KiB.");
    } finally {
      clearTimeout(ingressTimeout);
      portalAuth.request.signal.removeEventListener("abort", abortIngress);
    }
    const headers = new Headers(portalAuth.request.headers);
    headers.delete("content-length");
    const boundedRequest = new Request(portalAuth.request.url, {
      method: portalAuth.request.method,
      headers,
      body: body.length ? (body.buffer as ArrayBuffer) : null,
      signal: portalAuth.request.signal,
    });
    return createHandler(env, boundedRequest.signal).fetch(boundedRequest);
  },
};
