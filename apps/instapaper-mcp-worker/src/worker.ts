import { createMcpHandler } from "agents/mcp/server";
import { authenticateOrigin } from "./auth/origin-auth.js";
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

  const originAuth = authenticateOrigin(request, env.MCP_ORIGIN_TOKEN);
  if (!originAuth.ok) {
    if (originAuth.reason === "misconfigured") {
      return jsonError(503, "origin_auth_not_configured", "MCP origin authentication is not configured.");
    }
    return jsonError(401, "unauthorized", "Valid MCP Portal origin authentication is required.");
  }

  const handler = createMcpHandler(() => createServer(instapaperCredentialsFromEnv(env)), {
    route: "/mcp",
  });

  return handler(originAuth.request, env, ctx);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
