import { createMcpHandler } from "agents/mcp/server";
import { verifyAccessRequest } from "./auth/access-verifier";
import { verifyPortalOrigin } from "./auth/origin-verifier";
import { loadConfig } from "./config";
import { createServer } from "./mcp/server";
import type { Env } from "./types";

function portalUnauthorized() {
  return Response.json(
    { error: "unauthorized", message: "Invalid MCP Portal origin credential." },
    {
      status: 401,
      headers: { "Cache-Control": "no-store", "WWW-Authenticate": "Bearer" },
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

    let config;
    let mcpRequest = request;
    try {
      config = loadConfig(env);
      const portalAuth = verifyPortalOrigin(request, env.MCP_ORIGIN_TOKEN);
      if (portalAuth.ok) {
        mcpRequest = portalAuth.request;
      } else if (portalAuth.reason === "unauthorized") {
        return portalUnauthorized();
      } else {
        // Expand phase: preserve the existing Cloudflare Access JWT path.
        await verifyAccessRequest(request, config);
      }
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("MCP request rejected", { message: error instanceof Error ? error.message : "configuration error" });
      return new Response("Service misconfigured", { status: 503 });
    }

    const handler = createMcpHandler(() => createServer(config, env.OPENLIST_TOKEN));
    return handler(mcpRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;
