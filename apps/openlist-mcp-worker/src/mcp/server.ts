import { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../types";
import { OpenListClient } from "../openlist/client";
import { registerTools } from "../tools/register";

export function createServer(config: AppConfig, token: string): McpServer {
  const server = new McpServer({ name: "openlist-mcp-worker", version: "0.1.0" });
  const client = new OpenListClient(config.openListUrl, token, config.timeoutMs);
  registerTools(server, config, client);
  return server;
}
