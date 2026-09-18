import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  EmailConfigError,
  featureEnabled,
  parseEmailAccountsConfig,
} from "./config.js";
import { buildEmailServer } from "./server.js";

export interface Env {
  MCP_ACCESS_TOKEN: string;
  EMAIL_ACCOUNTS_CONFIG: string;
  EMAIL_ALLOW_MODIFY?: string;
  EMAIL_ALLOW_SEND?: string;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
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
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({
      status: "ok",
      service: "email-mcp-worker",
    });
  }

  if (url.pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }

  const portalAuth = await authenticatePortalRequest(request, {
    expectedToken: env.MCP_ACCESS_TOKEN,
    allowedOrigins: [],
  });

  if (!portalAuth.ok) {
    if (portalAuth.reason === "misconfigured") {
      return errorResponse(
        503,
        "portal_auth_not_configured",
        "MCP Portal authentication is not configured.",
      );
    }
    if (portalAuth.reason === "invalid_origin") {
      return errorResponse(403, "invalid_origin", "Request Origin is not allowed.");
    }
    return errorResponse(
      401,
      "unauthorized",
      "Valid MCP Portal authentication is required.",
    );
  }

  let catalog;
  try {
    catalog = parseEmailAccountsConfig(env.EMAIL_ACCOUNTS_CONFIG);
  } catch (error) {
    if (error instanceof EmailConfigError) {
      return errorResponse(503, error.code, error.message);
    }
    return errorResponse(
      503,
      "email_config_invalid",
      "Email account configuration is invalid.",
    );
  }

  const handler = createMcpHandler(
    () =>
      buildEmailServer(catalog, {
        allowModify: featureEnabled(env.EMAIL_ALLOW_MODIFY),
        allowSend: featureEnabled(env.EMAIL_ALLOW_SEND),
      }),
    { legacy: "stateless" },
  );

  return handler.fetch(portalAuth.request);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
