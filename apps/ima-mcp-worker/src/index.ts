import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Env, ImaCredentials } from "./types.ts";
import { ImaClient, ImaKnowledge, ImaNotes } from "./ima.ts";
import { registerTools } from "./tools.ts";
import { IMA_SERVER_INSTRUCTIONS } from "./instructions.ts";
import { verifySignedDownload } from "./r2.ts";

const VERSION = "0.5.0";

function missingRuntimeConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.MCP_ACCESS_TOKEN) missing.push("MCP_ACCESS_TOKEN");
  if (!env.CLIENT_ID) missing.push("CLIENT_ID");
  if (!env.API_KEY) missing.push("API_KEY");
  if (!env.R2_BUCKET) missing.push("R2_BUCKET");
  if (!env.IMA_DOWNLOAD_SIGNING_KEY) missing.push("IMA_DOWNLOAD_SIGNING_KEY");
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

function downloadError(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, name: "ima-cloudflare-mcp", version: VERSION, mode: "single-user" });
    }

    if (url.pathname === "/ready") {
      const missing = missingRuntimeConfig(env);
      return missing.length === 0
        ? Response.json({ ready: true })
        : Response.json({ ready: false, missing }, { status: 503 });
    }

    if (url.pathname.startsWith("/download/")) {
      if (!env.R2_BUCKET) return downloadError(503, "R2 bucket not configured");

      let key: string;
      try {
        key = decodeURIComponent(url.pathname.slice("/download/".length));
      } catch {
        return downloadError(403, "Invalid download link");
      }

      const authorization = await verifySignedDownload(
        env,
        key,
        url.searchParams.get("expires"),
        url.searchParams.get("sig"),
      );
      if (!authorization.ok) {
        if (authorization.reason === "misconfigured") {
          return downloadError(503, "Download signing is not configured");
        }
        if (authorization.reason === "expired") {
          return downloadError(410, "Download link expired");
        }
        return downloadError(403, "Invalid download link");
      }

      const object = await env.R2_BUCKET.get(key);
      if (!object) return downloadError(404, "File not found");

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "private, no-store");
      headers.set("x-content-type-options", "nosniff");
      return new Response(object.body, { headers });
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
    ].filter((value): value is string => value !== null);
    if (missingIma.length) return configurationError(missingIma);

    const credentials: ImaCredentials = {
      clientId: env.CLIENT_ID!,
      apiKey: env.API_KEY!,
    };
    const runtimeEnv: Env = env.PUBLIC_BASE_URL ? env : { ...env, PUBLIC_BASE_URL: url.origin };

    const handler = createMcpHandler(() => {
      const api = new ImaClient(runtimeEnv, credentials);
      const server = new McpServer(
        { name: "ima", version: VERSION },
        { instructions: IMA_SERVER_INSTRUCTIONS },
      );
      registerTools(server, new ImaNotes(api), new ImaKnowledge(runtimeEnv, api), true);
      return server;
    }, {
      route: "/mcp",
      allowedHostnames: [url.hostname],
      legacy: "stateless",
    });

    return handler(portalAuth.request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
