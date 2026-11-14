/**
 * Stateless, business-agnostic MCP admission rules.
 *
 * This module is deliberately independent of Clerk and Cloudflare SDKs.
 * The caller must first verify that the Clerk Resource is registered,
 * that its OAuth audience matches the canonical URL, and that the selected
 * Portal server is approved for the one Gateway Service Token.
 */
export type GatewayDecision =
  | { ok: true; method: string }
  | { ok: false; reason: "invalid_request" | "method_not_allowed" | "tool_not_allowed" };

const SERVER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_IDS = new Set(["portal", "mcp"]);

function validServerId(serverId: string): boolean {
  return SERVER_ID.test(serverId) && !RESERVED_IDS.has(serverId);
}

export function parseGatewayResource(resourceUrl: string, gatewayOrigin: string): string | null {
  try {
    const url = new URL(resourceUrl);
    const expected = new URL(gatewayOrigin);
    if (
      url.protocol !== "https:" ||
      expected.protocol !== "https:" ||
      url.origin !== expected.origin ||
      url.username || url.password || url.search || url.hash ||
      gatewayOrigin !== expected.origin
    ) return null;
    const match = /^\/mcp\/([a-z][a-z0-9-]{0,31})$/.exec(url.pathname);
    if (!match || !validServerId(match[1]!)) return null;
    return match[1]!;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function toolIsFrom(serverId: string, name: string): boolean {
  const prefix = serverId + "_";
  return validServerId(serverId) && name.startsWith(prefix) && name.length > prefix.length;
}

export function authorizeGatewayMessage(
  payload: unknown,
  serverId: string,
  headers: Headers,
): GatewayDecision {
  if (!validServerId(serverId)) return { ok: false, reason: "invalid_request" };
  const message = record(payload);
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { ok: false, reason: "invalid_request" };
  }
  const method = message.method;
  const params = record(message.params);
  const meta = record(params?._meta);
  const version = meta?.["io.modelcontextprotocol/protocolVersion"];
  const modern = version === "2026-07-28";
  if (modern) {
    if (!record(meta?.["io.modelcontextprotocol/clientCapabilities"]) ||
        headers.get("Mcp-Protocol-Version") !== version ||
        headers.get("Mcp-Method") !== method) {
      return { ok: false, reason: "invalid_request" };
    }
  } else if (version !== undefined || headers.get("Mcp-Protocol-Version") === "2026-07-28") {
    return { ok: false, reason: "invalid_request" };
  }
  if (Object.keys(message).some((key) => !["jsonrpc", "id", "method", "params"].includes(key))) {
    return { ok: false, reason: "invalid_request" };
  }
  if (method === "notifications/initialized") {
    if ("id" in message) return { ok: false, reason: "invalid_request" };
  } else if (!(typeof message.id === "string" ||
      (typeof message.id === "number" && Number.isSafeInteger(message.id)))) {
    // Executable operations must not be silently accepted as notifications.
    return { ok: false, reason: "invalid_request" };
  }
  if (method === "server/discover" &&
      (!modern || !params || Object.keys(params).some((key) => key !== "_meta"))) {
    return { ok: false, reason: "invalid_request" };
  }
  if (method === "tools/list" && message.params !== undefined) {
    if (!params || Object.keys(params).some((key) => key !== "cursor" && key !== "_meta") ||
        (params.cursor !== undefined && typeof params.cursor !== "string")) {
      return { ok: false, reason: "invalid_request" };
    }
  }
  const headerMethod = headers.get("Mcp-Method");
  if (headerMethod !== null && headerMethod !== method) {
    return { ok: false, reason: "invalid_request" };
  }
  if (method === "tools/call") {
    const params = record(message.params);
    if (!params || typeof params.name !== "string") {
      return { ok: false, reason: "invalid_request" };
    }
    // MCP tool calls have name, arguments, and optionally protocol _meta.
    // A request-provided routing override must never reach the Portal.
    if (Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key))) {
      return { ok: false, reason: "invalid_request" };
    }
    const name = params.name;
    const headerName = headers.get("Mcp-Name");
    if (modern ? headerName !== name : (headerName !== null && headerName !== name)) {
      return { ok: false, reason: "invalid_request" };
    }
    return toolIsFrom(serverId, name)
      ? { ok: true, method }
      : { ok: false, reason: "tool_not_allowed" };
  }
  if (headers.has("Mcp-Name")) return { ok: false, reason: "invalid_request" };
  if (method === "server/discover" && modern) return { ok: true, method };
  if (["initialize", "ping", "tools/list", "notifications/initialized"].includes(method) &&
      (!modern || method === "tools/list")) {
    return { ok: true, method };
  }
  return { ok: false, reason: "method_not_allowed" };
}

/**
 * Project a Portal tools/list response onto the current Clerk Resource.
 * Never return other Portal result fields or administrative tools.
 */
export function filterGatewayToolList(payload: unknown, serverId: string, modern = false): unknown | null {
  if (!validServerId(serverId)) return null;
  const response = record(payload);
  const result = record(response?.result);
  if (!response || response.jsonrpc !== "2.0" || !result || !Array.isArray(result.tools)) {
    return null;
  }
  const tools = result.tools.filter((item: unknown) => {
    const tool = record(item);
    return tool && typeof tool.name === "string" && toolIsFrom(serverId, tool.name);
  });
  const projected: Record<string, unknown> = { tools };
  if (typeof result.nextCursor === "string") projected.nextCursor = result.nextCursor;
  if (modern) {
    projected.resultType = "complete";
    projected.ttlMs = 0;
    projected.cacheScope = "private";
  }
  return {
    jsonrpc: "2.0",
    ...("id" in response ? { id: response.id } : {}),
    result: projected,
  };
}
