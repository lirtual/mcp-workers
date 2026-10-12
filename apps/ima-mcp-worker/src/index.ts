import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Env, ImaCredentials } from "./types.ts";
import { ImaClient, ImaKnowledge } from "./ima.ts";
import { RefreshingImaNotes } from "./exporting-notes.ts";
import { registerTools } from "./tools.ts";
import { IMA_SERVER_INSTRUCTIONS } from "./instructions.ts";

export { ImaImageRefreshShard } from "./image-refresh-shard.ts";

const VERSION = "0.5.0";

type RuntimeEnv = Env & { R2_PUBLIC_BASE_URL?: string };

function missingRuntimeConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.MCP_ACCESS_TOKEN) missing.push("MCP_ACCESS_TOKEN");
  if (!env.CLIENT_ID) missing.push("CLIENT_ID");
  if (!env.API_KEY) missing.push("API_KEY");
  if (!env.R2_BUCKET) missing.push("R2_BUCKET");
  if (!env.R2_PUBLIC_BASE_URL) missing.push("R2_PUBLIC_BASE_URL");
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
    const runtimeEnv = env as RuntimeEnv;

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
      !env.CLIENT_ID ? "CLIENT_ID" : null,
      !env.API_KEY ? "API_KEY" : null,
      !env.R2_BUCKET ? "R2_BUCKET" : null,
      !runtimeEnv.R2_PUBLIC_BASE_URL ? "R2_PUBLIC_BASE_URL" : null,
    ].filter((value): value is string => value !== null);
    if (missingIma.length) return configurationError(missingIma);

    const credentials: ImaCredentials = {
      clientId: env.CLIENT_ID!,
      apiKey: env.API_KEY!,
    };

    const handler = createMcpHandler(() => {
      const api = new ImaClient(runtimeEnv, credentials);
      const notes = new RefreshingImaNotes(api);
      const server = new McpServer(
        { name: "ima", version: VERSION },
        { instructions: IMA_SERVER_INSTRUCTIONS },
      );
      registerTools(server, notes, new ImaKnowledge(runtimeEnv, api), true);
      return server;
    }, {
      route: "/mcp",
      allowedHostnames: [url.hostname],
      legacy: "stateless",
    });

    return handler(portalAuth.request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
