/** HTTP entry point for the Raindrop MCP server. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { config } from "dotenv";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { AuthorizationCode } from "simple-oauth2";
import pkg from "../package.json";
import { RaindropMCPService } from "./services/raindropmcp.service.js";
import { createLogger } from "./utils/logger.js";

config({ quiet: true });

const PORT = Number.parseInt(process.env.HTTP_PORT || "3002", 10);
const logger = createLogger("http");
const localHosts = ["localhost", "127.0.0.1", "[::1]"];
const parseHosts = (value: string | undefined) =>
  value
    ?.split(",")
    .map((host) => host.trim())
    .filter(Boolean) || [];
const allowedHosts = [...localHosts, ...parseHosts(process.env.ALLOWED_HOSTS)];
const allowedOrigins = [
  ...localHosts,
  ...parseHosts(process.env.ALLOWED_ORIGINS),
];
const validateHost = hostHeaderValidation(allowedHosts);
const validateOrigin = originValidation(allowedOrigins);

const oauthClient = new AuthorizationCode({
  client: {
    id: process.env.RAINDROP_CLIENT_ID,
    secret: process.env.RAINDROP_CLIENT_SECRET,
  },
  auth: {
    tokenHost: "https://raindrop.io",
    authorizePath: "/oauth/authorize",
    tokenPath: "/oauth/access_token",
  },
});

const maxReadRetries = Number(
  process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES ?? "3",
);
const serviceConfig = {
  accessToken: process.env.RAINDROP_ACCESS_TOKEN ?? "",
  maxReadRetries:
    Number.isInteger(maxReadRetries) && maxReadRetries >= 0
      ? maxReadRetries
      : 3,
  debugHttp: process.env.NODE_ENV === "development",
};

const mcpHandler = createMcpHandler(
  () => new RaindropMCPService(serviceConfig).getServer(),
  {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => logger.error("MCP handler error", error),
  },
);
const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror: (error) => logger.error("MCP Node adapter error", error),
});

const setCorsHeaders = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => {
  const origin = req.headers.origin;
  if (typeof origin === "string") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, MCP-Protocol-Version, MCP-Param-*",
  );
};

const server = http.createServer(async (req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  setCorsHeaders(req, res);

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        service: "raindrop-mcp-worker",
        version: pkg.version,
        protocolTarget: "2026-07-28",
        httpMode: "per-request",
      }),
    );
    return;
  }

  if (url.pathname === "/auth/raindrop" && req.method === "GET") {
    if (!process.env.RAINDROP_CLIENT_ID) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("RAINDROP_CLIENT_ID not set");
      return;
    }
    const redirectUri =
      process.env.RAINDROP_REDIRECT_URI ||
      `http://localhost:${PORT}/auth/raindrop/callback`;
    res.writeHead(302, {
      Location: oauthClient.authorizeURL({
        redirect_uri: redirectUri,
        scope: "read write",
      }),
    });
    res.end();
    return;
  }

  if (url.pathname === "/auth/raindrop/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code parameter");
      return;
    }
    const redirectUri =
      process.env.RAINDROP_REDIRECT_URI ||
      `http://localhost:${PORT}/auth/raindrop/callback`;
    try {
      const token = await oauthClient.getToken({
        code,
        redirect_uri: redirectUri,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: token.token.access_token }));
    } catch (error) {
      logger.error("OAuth token exchange failed", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "OAuth token exchange failed" }));
    }
    return;
  }

  if (url.pathname === "/mcp") {
    await nodeMcpHandler(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

export const startHttpServer = () =>
  server.listen(PORT, () => {
    logger.info(`Raindrop MCP HTTP Server running on port ${PORT}`);
    logger.info(`MCP endpoint: http://localhost:${PORT}/mcp`);
  });

const shutdown = async () => {
  await mcpHandler.close();
  server.close(() => process.exit(0));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startHttpServer();
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

export { server as app, mcpHandler };
