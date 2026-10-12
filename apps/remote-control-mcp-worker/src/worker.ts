import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import {
  parseFileInfo,
  parseListDirectory,
  parseLocalRead,
  parseReadMultiple,
  parseSearchSessionId,
  parseSearchStart,
  type LocalFileInfo,
  type LocalListDirectory,
  type LocalRead,
  type LocalReadMultiple,
  type LocalSearch,
  type SearchSessionId,
} from "./local-read.ts";

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

const READ_MULTIPLE_TOOL = {
  name: "read_multiple_files",
  title: "Read local files",
  description:
    "Read up to 8 local files. Combined output is capped. URL fetches, shell commands, and file modifications are not available.",
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string" },
        description: "Local filesystem paths. URL schemes are rejected.",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
  annotations: {
    title: "Read local files",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

const LIST_DIRECTORY_TOOL = {
  name: "list_directory",
  title: "List local directory",
  description:
    "List a local directory. Depth 1 returns immediate entries. Depth may be at most 3. Symbolic links are not followed. Output is capped.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Local directory path. URL schemes are rejected." },
      depth: { type: "integer", minimum: 1, maximum: 3, description: "Optional directory depth, from 1 to 3." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: {
    title: "List local directory",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

const FILE_INFO_TOOL = {
  name: "get_file_info",
  title: "Read local file info",
  description: "Return type, size, mode, and modification time for a local path. File contents are not returned.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Local filesystem path. URL schemes are rejected." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: {
    title: "Read local file info",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

const START_SEARCH_TOOL = {
  name: "start_search",
  title: "Search local files",
  description:
    "Search local file and directory names or literal, case-sensitive text in files. Results are paged. The Agent bounds depth, files, bytes, results, active searches, and lifetime; symbolic links are not followed.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Local directory path to search. URL schemes are rejected." },
      pattern: { type: "string", minLength: 1, maxLength: 256, description: "Literal case-sensitive substring." },
      search_type: { type: "string", enum: ["filename", "content"] },
    },
    required: ["path", "pattern", "search_type"],
    additionalProperties: false,
  },
  annotations: {
    title: "Search local files",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

const GET_MORE_SEARCH_RESULTS_TOOL = {
  name: "get_more_search_results",
  title: "Get more search results",
  description: "Fetch the next fixed-size page from an active local search session.",
  inputSchema: {
    type: "object",
    properties: { session_id: { type: "string", format: "uuid" } },
    required: ["session_id"],
    additionalProperties: false,
  },
  annotations: {
    title: "Get more search results",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

const STOP_SEARCH_TOOL = {
  name: "stop_search",
  title: "Stop local search",
  description: "Stop an active local search and release its traversal resources.",
  inputSchema: {
    type: "object",
    properties: { session_id: { type: "string", format: "uuid" } },
    required: ["session_id"],
    additionalProperties: false,
  },
  annotations: {
    title: "Stop local search",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
} as const;

const LOCAL_TOOLS = [
  READ_FILE_TOOL,
  READ_MULTIPLE_TOOL,
  LIST_DIRECTORY_TOOL,
  FILE_INFO_TOOL,
  START_SEARCH_TOOL,
  GET_MORE_SEARCH_RESULTS_TOOL,
  STOP_SEARCH_TOOL,
];

const SAFE_EVENTS = new Set([
  "portal_auth_not_configured",
  "invalid_origin",
  "unauthorized",
  "rejected",
  "device_not_configured",
  "device_unavailable",
  "read_completed",
  "read_failed",
  "list_completed",
  "list_failed",
  "info_completed",
  "info_failed",
  "search_completed",
  "search_failed",
  "search_stopped",
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

type LocalCall =
  | { tool: "read_file"; arguments: LocalRead }
  | { tool: "read_multiple_files"; arguments: LocalReadMultiple }
  | { tool: "list_directory"; arguments: LocalListDirectory }
  | { tool: "get_file_info"; arguments: LocalFileInfo }
  | { tool: "start_search"; arguments: LocalSearch }
  | { tool: "get_more_search_results" | "stop_search"; arguments: SearchSessionId };

function upstreamArguments(call: LocalCall): Record<string, unknown> {
  if (call.tool === "read_file") {
    const args: Record<string, string | number> = { path: call.arguments.path };
    if (call.arguments.offset !== undefined) args.offset = call.arguments.offset;
    if (call.arguments.length !== undefined) args.length = call.arguments.length;
    return args;
  }
  if (call.tool === "read_multiple_files") return { paths: call.arguments.paths };
  if (call.tool === "list_directory") return { path: call.arguments.path, depth: call.arguments.depth };
  if (call.tool === "get_file_info") return { path: call.arguments.path };
  if (call.tool === "start_search") {
    return { path: call.arguments.path, pattern: call.arguments.pattern, search_type: call.arguments.searchType };
  }
  return { session_id: call.arguments.sessionId };
}

function parseLocalCall(name: unknown, args: unknown): LocalCall | null {
  if (name === "read_file") {
    const read = parseLocalRead(args);
    return read ? { tool: "read_file", arguments: read } : null;
  }
  if (name === "read_multiple_files") {
    const read = parseReadMultiple(args);
    return read ? { tool: "read_multiple_files", arguments: read } : null;
  }
  if (name === "list_directory") {
    const list = parseListDirectory(args);
    return list ? { tool: "list_directory", arguments: list } : null;
  }
  if (name === "get_file_info") {
    const info = parseFileInfo(args);
    return info ? { tool: "get_file_info", arguments: info } : null;
  }
  if (name === "start_search") {
    const search = parseSearchStart(args);
    return search ? { tool: "start_search", arguments: search } : null;
  }
  if (name === "get_more_search_results" || name === "stop_search") {
    const session = parseSearchSessionId(args);
    return session ? { tool: name, arguments: session } : null;
  }
  return null;
}

function failureMessage(tool: LocalCall["tool"]): string {
  if (tool === "list_directory") return "The directory list failed.";
  if (tool === "get_file_info") return "The file info request failed.";
  if (tool === "start_search") return "The search could not be completed.";
  if (tool === "get_more_search_results" || tool === "stop_search") return "The search session is unavailable.";
  return "The file read failed.";
}

function successEvent(tool: LocalCall["tool"]): string {
  if (tool === "list_directory") return "list_completed";
  if (tool === "get_file_info") return "info_completed";
  if (tool === "start_search" || tool === "get_more_search_results") return "search_completed";
  if (tool === "stop_search") return "search_stopped";
  return "read_completed";
}

function failureEvent(tool: LocalCall["tool"]): string {
  if (tool === "list_directory") return "list_failed";
  if (tool === "get_file_info") return "info_failed";
  if (tool === "start_search" || tool === "get_more_search_results" || tool === "stop_search") return "search_failed";
  return "read_failed";
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

async function callDevice(env: Env, call: LocalCall, id: unknown, signal: AbortSignal): Promise<Response> {
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
      signal,
      headers: {
        "content-type": "application/json",
        "x-device-credential": deviceToken,
      },
      body: JSON.stringify({
        tool: call.tool,
        arguments: upstreamArguments(call),
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
    log(successEvent(call.tool));
    return toolText(id, text);
  }

  const status =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { status?: unknown }).status
      : undefined;
  if (status === "failed") {
    log(failureEvent(call.tool));
    return toolError(id, failureMessage(call.tool));
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
        "Read local files, list directories, inspect file metadata, and search file names or contents. URL reads, shell commands, and file modifications are not available.",
    });
  }

  if (rpcMessage.method === "tools/list") {
    return rpc(rpcMessage.id, { tools: LOCAL_TOOLS });
  }

  if (rpcMessage.method === "tools/call") {
    const params = rpcMessage.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      log("rejected");
      return toolError(rpcMessage.id, "The requested tool call was rejected.");
    }
    const call = params as { name?: unknown; arguments?: unknown };
    const localCall = parseLocalCall(call.name, call.arguments);
    if (!localCall) {
      log("rejected");
      return toolError(rpcMessage.id, "The requested tool call was rejected.");
    }
    return callDevice(env, localCall, rpcMessage.id, request.signal);
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
