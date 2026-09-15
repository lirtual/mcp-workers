import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "agents/mcp/server";
import { loadConfig } from "./config";
import { createServer } from "./mcp/server";
import type { Env } from "./types";

function authError(status: number, code: string, message: string): Response {
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });

    const portalAuth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN,
      allowedOrigins: [],
    });
    if (!portalAuth.ok) {
      if (portalAuth.reason === "misconfigured") {
        return authError(
          503,
          "portal_auth_not_configured",
          "MCP Portal authentication is not configured.",
        );
      }
      if (portalAuth.reason === "invalid_origin") {
        return authError(403, "invalid_origin", "Request Origin is not allowed.");
      }
      return authError(
        401,
        "unauthorized",
        "Valid MCP Portal authentication is required.",
      );
    }

    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      console.error("MCP request rejected", {
        message: error instanceof Error ? error.message : "configuration error",
      });
      return new Response("Service misconfigured", { status: 503 });
    }

    const handler = createMcpHandler(() => createServer(config, env.OPENLIST_TOKEN));
    return handler(portalAuth.request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
