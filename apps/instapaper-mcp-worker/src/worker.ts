import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "agents/mcp/server";
import { instapaperCredentialsFromEnv, type Env } from "./env.js";
import { createServer } from "./mcp/server.js";

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

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }

  const portalAuth = await authenticatePortalRequest(request, {
    expectedToken: env.MCP_ACCESS_TOKEN,
    allowedOrigins: [],
  });
  if (!portalAuth.ok) {
    if (portalAuth.reason === "misconfigured") {
      return jsonError(503, "portal_auth_not_configured", "MCP Portal authentication is not configured.");
    }
    if (portalAuth.reason === "invalid_origin") {
      return jsonError(403, "invalid_origin", "Request Origin is not allowed.");
    }
    return jsonError(401, "unauthorized", "Valid MCP Portal authentication is required.");
  }

  const handler = createMcpHandler(() => createServer(instapaperCredentialsFromEnv(env)), {
    route: "/mcp",
  });

  return handler(portalAuth.request, env, ctx);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
