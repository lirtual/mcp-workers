import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Env, ImaCredentials } from "./types.ts";
import { ImaClient, ImaKnowledge, ImaNotes } from "./ima.ts";
import { registerTools } from "./tools.ts";
import { IMA_SERVER_INSTRUCTIONS } from "./instructions.ts";

export { ImaImageRefreshShard } from "./image-refresh-shard.ts";

const VERSION = "0.5.0";

function missingRuntimeConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.MCP_ACCESS_TOKEN) missing.push("MCP_ACCESS_TOKEN");
  if (!env.IMA_CLIENT_ID) missing.push("IMA_CLIENT_ID");
  if (!env.IMA_API_KEY) missing.push("IMA_API_KEY");
  return missing;
}

function configurationError(missing: string[]): Response {
  return Response.json({ error: "server_misconfigured", missing }, { status: 503 });
}

function authError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: code, message },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
      },
    },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const runtimeEnv = env;

    if (url.pathname === "/health") {
      return Response.json({ ok: true, name: "ima-cloudflare-mcp", version: VERSION, mode: "single-user" });
    }

    if (url.pathname === "/ready") {
      const missing = missingRuntimeConfig(runtimeEnv);
      return missing.length === 0
        ? Response.json({ ready: true })
        : Response.json({ ready: false, missing }, { status: 503 });
    }

    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

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

    const missingIma = [
      !env.IMA_CLIENT_ID ? "IMA_CLIENT_ID" : null,
      !env.IMA_API_KEY ? "IMA_API_KEY" : null,
    ].filter((value): value is string => value !== null);
    if (missingIma.length) return configurationError(missingIma);

    const credentials: ImaCredentials = {
      clientId: env.IMA_CLIENT_ID!,
      apiKey: env.IMA_API_KEY!,
    };

    const handler = createMcpHandler(() => {
      const api = new ImaClient(runtimeEnv, credentials);
      const notes = new ImaNotes(api);
      const server = new McpServer(
        { name: "ima", version: VERSION },
        { instructions: IMA_SERVER_INSTRUCTIONS },
      );
      registerTools(server, notes, new ImaKnowledge(runtimeEnv, api));
      return server;
    }, {
      route: "/mcp",
      allowedHostnames: [url.hostname],
      legacy: "stateless",
    });

    return handler(portalAuth.request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
