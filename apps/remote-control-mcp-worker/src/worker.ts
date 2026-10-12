import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { parseLocalRead, type LocalRead } from "./local-read.ts";

/** Fixed VPC Service target. Tool arguments cannot change this URL. */
export const DEVICE_CALL_URL = "http://remote-control-device.invalid/internal/call";

const MAX_MCP_BODY_BYTES = 65_536;
const MAX_DEVICE_BODY_BYTES = 512_000;
const SERVER_NAME = "remote-control-mcp-worker";
const SERVER_VERSION = "0.0.0";
const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

const READ_FILE_TOOL = {
  name: "read_file",
  title: "Read local file",
  description:
    "Read a local file on the authorized Linux device. Only a filesystem path is accepted. URL fetches, shell commands, and file modifications are not available.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Local filesystem path. URL schemes are rejected.",
      },
      offset: {
        type: "integer",
        minimum: -100_000,
        maximum: 1_000_000,
        description: "Optional 0-based line offset. Negative values read from the end.",
      },
      length: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Optional maximum number of lines.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: {
    title: "Read local file",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

const SAFE_EVENTS = new Set([
  "portal_auth_not_configured",
  "invalid_origin",
  "unauthorized",
  "rejected",
  "device_not_configured",
  "device_unavailable",
  "read_completed",
  "read_failed",
]);

function log(event: string): void {
  if (!SAFE_EVENTS.has(event)) return;
  console.log(JSON.stringify({ service: SERVER_NAME, event }));
}

function jsonError(status: number, code: string, message: string): Response {
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

function rpc(id: unknown, result: unknown, status = 200): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { headers: { "cache-control": "no-store" } },
  );
}

function toolError(id: unknown, message: string): Response {
  return rpc(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

function toolText(id: unknown, text: string): Response {
  return rpc(id, {
    content: [{ type: "text", text }],
    isError: false,
  });
}

async function readBounded(
  source: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<string | null> {
  const declared = source.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (!source.body) return "";

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function readResponseText(response: Response): Promise<string | null> {
  return readBounded(response, MAX_DEVICE_BODY_BYTES);
}

function upstreamArguments(read: LocalRead): Record<string, string | number> {
  const args: Record<string, string | number> = { path: read.path };
  if (read.offset !== undefined) args.offset = read.offset;
  if (read.length !== undefined) args.length = read.length;
  return args;
}

function completedText(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as { status?: unknown; result?: unknown };
  if (record.status !== "completed" || record.result === null || typeof record.result !== "object") {
    return null;
  }
  const content = (record.result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") return null;
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type !== "text" || typeof textBlock.text !== "string") return null;
    parts.push(textBlock.text);
  }
  return parts.join("");
}

async function callDevice(env: Env, read: LocalRead, id: unknown): Promise<Response> {
  const deviceToken = env.REMOTE_CONTROL_DEVICE_TOKEN;
  const binding = env.REMOTE_CONTROL_DEVICE;
  if (!deviceToken || !binding) {
    log("device_not_configured");
    return toolError(id, "The remote device is unavailable.");
  }

  let response: Response;
  try {
    response = await binding.fetch(DEVICE_CALL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-credential": deviceToken,
      },
      body: JSON.stringify({
        tool: "read_file",
        arguments: upstreamArguments(read),
      }),
    });
  } catch {
    log("device_unavailable");
    return toolError(id, "The remote device is unavailable.");
  }

  const raw = await readResponseText(response);
  if (raw === null) {
    log("device_unavailable");
    return toolError(id, "The remote device is unavailable.");
  }

  if (!response.ok) {
    log(response.status === 400 ? "rejected" : "device_unavailable");
    const message =
      response.status === 400
        ? "The requested tool call was rejected."
        : "The remote device is unavailable.";
    return toolError(id, message);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    log("device_unavailable");
    return toolError(id, "The remote device is unavailable.");
  }

  const text = completedText(parsed);
  if (text !== null) {
    log("read_completed");
    return toolText(id, text);
  }

  const status =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { status?: unknown }).status
      : undefined;
  if (status === "failed") {
    log("read_failed");
    return toolError(id, "The file read failed.");
  }

  log("device_unavailable");
  return toolError(id, "The remote device is unavailable.");
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const raw = await readBounded(request, MAX_MCP_BODY_BYTES);
  if (raw === null) return rpcError(null, -32600, "Invalid request.");

  let message: unknown;
  try {
    message = JSON.parse(raw) as unknown;
  } catch {
    return rpcError(null, -32700, "Parse error.");
  }

  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid request.");
  }

  const rpcMessage = message as { id?: unknown; method?: unknown; params?: unknown };
  if (rpcMessage.id === undefined) {
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  if (typeof rpcMessage.method !== "string") return rpcError(rpcMessage.id, -32600, "Invalid request.");

  if (rpcMessage.method === "initialize") {
    const params = rpcMessage.params;
    const requested =
      params !== null && typeof params === "object"
        ? (params as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : PROTOCOL_VERSION;
    return rpc(rpcMessage.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Read one local file with read_file. URL reads, shell commands, and file modifications are not available.",
    });
  }

  if (rpcMessage.method === "tools/list") {
    return rpc(rpcMessage.id, { tools: [READ_FILE_TOOL] });
  }

  if (rpcMessage.method === "tools/call") {
    const params = rpcMessage.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      log("rejected");
      return toolError(rpcMessage.id, "The requested tool call was rejected.");
    }
    const call = params as { name?: unknown; arguments?: unknown };
    if (call.name !== "read_file") {
      log("rejected");
      return toolError(rpcMessage.id, "The requested tool call was rejected.");
    }
    const read = parseLocalRead(call.arguments);
    if (!read) {
      log("rejected");
      return toolError(rpcMessage.id, "The requested tool call was rejected.");
    }
    return callDevice(env, read, rpcMessage.id);
  }

  return rpcError(rpcMessage.id, -32601, "Method not found.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return jsonError(404, "not_found", "The route was not found.");
    }

    const portalAuth = await authenticatePortalRequest(request, {
      expectedToken: env.MCP_ACCESS_TOKEN,
      // No verified browser Origin is configured. A present Origin is rejected.
      allowedOrigins: [],
    });
    if (!portalAuth.ok) {
      if (portalAuth.reason === "misconfigured") {
        log("portal_auth_not_configured");
        return jsonError(
          503,
          "portal_auth_not_configured",
          "MCP Portal authentication is not configured.",
        );
      }
      if (portalAuth.reason === "invalid_origin") {
        log("invalid_origin");
        return jsonError(403, "invalid_origin", "Request Origin is not allowed.");
      }
      log("unauthorized");
      return jsonError(401, "unauthorized", "Valid MCP Portal authentication is required.");
    }

    if (request.method !== "POST") {
      return jsonError(405, "method_not_allowed", "Method is not allowed.");
    }

    return handleMcp(portalAuth.request, env);
  },
};
