import { createMcpHandler } from "agents/mcp/server";
import { authenticateOrigin } from "./origin-auth.js";
import { createServer, type Env as ServerEnv } from "./server.js";

type Env = ServerEnv & { MCP_ORIGIN_TOKEN: string };

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

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

  const originAuth = authenticateOrigin(request, env.MCP_ORIGIN_TOKEN);
  if (!originAuth.ok) {
    return originAuth.reason === "misconfigured"
      ? authError(503, "origin_auth_not_configured", "MCP origin authentication is not configured.")
      : authError(401, "unauthorized", "Valid MCP origin authentication is required.");
  }

  const handler = createMcpHandler(() => createServer(env), { route: "/mcp" });
  return handler(originAuth.request, env, ctx);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
