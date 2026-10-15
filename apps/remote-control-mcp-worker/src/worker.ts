import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
export { V2OwnerCoordinator } from "./v2-pairing.ts";

type V2Env = Env & { V2_OWNER?: DurableObjectNamespace };
function pendingOwner(env: Env): DurableObjectStub | null {
  const ns = (env as V2Env).V2_OWNER;
  return ns ? ns.get(ns.idFromName("single-owner-v2")) : null;
}

const PAIRING_PREPARE_TOOL = {
  name: "pairing_prepare",
  title: "Prepare new device terminal confirmation",
  description: "Prepare a short-lived, one-use challenge for the NEW device's physical/SSH terminal. This tool cannot approve or activate a device. The owner must manually enter the challenge on that device.",
  inputSchema: {
    type: "object",
    properties: {
      pairing_id: { type: "string" },
      expected_fingerprint: { type: "string" },
    },
    required: ["pairing_id", "expected_fingerprint"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
} as const;

async function prepareLocalDevice(
  env: Env, id: unknown, argumentsValue: unknown,
): Promise<Response> {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    return toolError(id, "The confirmation preparation was rejected.");
  }
  const args = argumentsValue as Record<string, unknown>;
  if (Object.keys(args).length !== 2 ||
      typeof args.pairing_id !== "string" || typeof args.expected_fingerprint !== "string") {
    return toolError(id, "The confirmation preparation was rejected.");
  }
  const owner = pendingOwner(env);
  if (!owner) return toolError(id, "Device enrollment is disabled.");
  try {
    const response = await owner.fetch("https://v2.internal/prepare", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_id: args.pairing_id, expected_fingerprint: args.expected_fingerprint }),
    });
    if (!response.ok) return toolError(id, "The pending device was not found or cannot be confirmed.");
    return toolText(id, JSON.stringify(await response.json()));
  } catch { return toolError(id, "Confirmation preparation is unavailable."); }
}

const PAIRING_LOOKUP_TOOL = {
  name: "pairing_lookup",
  title: "Inspect pending local device",
  description: "Read a pending Agent label and key fingerprint. Never approves or activates a device.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", minLength: 10, maxLength: 10 } },
    required: ["code"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} as const;

async function lookupPendingDevice(env: Env, code: unknown, id: unknown): Promise<Response> {
  if (typeof code !== "string" || !/^[A-Z2-7]{10}$/.test(code)) return toolError(id, "The pairing code was rejected.");
  const owner = pendingOwner(env);
  if (!owner) return toolError(id, "Device enrollment is disabled.");
  const value = new TextEncoder().encode("remote-control:v2:pending:" + code);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  const verifier = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
  try {
    const response = await owner.fetch("https://v2.internal/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verifier }),
    });
    if (!response.ok) return toolError(id, "The pairing code was not found or expired.");
    const detail = await response.json() as unknown;
    return toolText(id, JSON.stringify(detail));
  } catch {
    return toolError(id, "Pending device lookup is unavailable.");
  }
}

import {
  parseFileInfo,
  parseListDirectory,
  parseLocalRead,
  parseReadMultiple,
  parseSearchSessionId,
  parseSearchStart,
  parseLocalWriteFile,
  parseLocalCreateDirectory,
  parseLocalEditBlock,
  parseLocalMoveFile,
  parseLocalDeleteFile,
  parseOperationId,
  parseStartProcess,
  parseLocalProcessOutput,
  parseListSessions,
  parseLocalProcessInteraction,
  parseLocalProcessTermination,
  type LocalFileInfo,
  type LocalListDirectory,
  type LocalRead,
  type LocalReadMultiple,
  type LocalSearch,
  type LocalWriteFile,
  type LocalCreateDirectory,
  type LocalEditBlock,
  type LocalMoveFile,
  type LocalDeleteFile,
  type OperationId,
  type SearchSessionId,
  type LocalStartProcess,
  type LocalProcessOutput,
  type LocalProcessInteraction,
  type LocalProcessTermination,
} from "./local-read.ts";

/** Fixed v1 VPC Service target. Re-exporting arbitrary constants from a DO entrypoint breaks workerd. */
import { DEVICE_CALL_URL } from "./device-target.ts";

const MAX_MCP_BODY_BYTES = 65_536;
const MAX_DEVICE_BODY_BYTES = 512_000;
const MAX_DEVICE_REQUEST_BYTES = 65_536;
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
    "Read a local file on the authorized Linux device. Only a filesystem path is accepted. URL fetches are not supported.",
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
  name: "read_files",
  title: "Read local files",
  description:
    "Read up to 8 local files. Combined output is capped. URL fetches are not supported.",
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
  name: "stat_file",
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
  name: "search_files",
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
  name: "search_next",
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

const WRITE_FILE_TOOL = {
  name: "write_file",
  title: "Write local file",
  description:
    "Rewrite or append a local file. Supply a stable operation_id and reuse it only for the same intent after a lost response; use a new ID for a new intent. Query get_operation_status with the same ID before considering a retry.",
  inputSchema: {
    type: "object",
    properties: {
      operation_id: { type: "string", minLength: 1, maxLength: 128, description: "Stable ID for this exact write intent." },
      path: { type: "string" },
      content: { type: "string", maxLength: 49152, description: "UTF-8 text up to the bounded internal request size." },
      mode: { type: "string", enum: ["rewrite", "append"] },
    },
    required: ["operation_id", "path", "content", "mode"],
    additionalProperties: false,
  },
  annotations: { title: "Write local file", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
} as const;

const CREATE_DIRECTORY_TOOL = {
  name: "create_directory", title: "Create local directory",
  description: "Create one local directory. Use a stable operation_id for this exact intent and query get_operation_status after an uncertain response.",
  inputSchema: { type: "object", properties: { operation_id: { type: "string", minLength: 1, maxLength: 128 }, path: { type: "string" } }, required: ["operation_id", "path"], additionalProperties: false },
  annotations: { title: "Create local directory", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
} as const;

const EDIT_BLOCK_TOOL = {
  name: "replace_text", title: "Replace text in local file",
  description: "Replace exact text occurrences in a local UTF-8 file. expected_replacements defaults to 1; the file is unchanged if the count differs. Use a stable operation_id and query status after an uncertain response.",
  inputSchema: { type: "object", properties: { operation_id: { type: "string", minLength: 1, maxLength: 128 }, file_path: { type: "string" }, old_string: { type: "string", minLength: 1, maxLength: 49152 }, new_string: { type: "string", maxLength: 49152 }, expected_replacements: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["operation_id", "file_path", "old_string", "new_string"], additionalProperties: false },
  annotations: { title: "Replace text in local file", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
} as const;

const MOVE_FILE_TOOL = {
  name: "move_file", title: "Move or rename local file",
  description: "Move or rename a local regular file on the same filesystem to a destination that does not already exist. Use a stable operation_id and query status after an uncertain response.",
  inputSchema: { type: "object", properties: { operation_id: { type: "string", minLength: 1, maxLength: 128 }, source: { type: "string" }, destination: { type: "string" } }, required: ["operation_id", "source", "destination"], additionalProperties: false },
  annotations: { title: "Move or rename local file", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
} as const;

const DELETE_FILE_TOOL = {
  name: "delete_file",
  title: "Delete local file",
  description: "Delete a regular file only (not a directory or symlink). Requires operation_id; query get_operation_status if the response is uncertain.",
  inputSchema: {
    type: "object",
    properties: {
      operation_id: { type: "string", minLength: 1, maxLength: 128 },
      path: { type: "string" },
    },
    required: ["operation_id", "path"],
    additionalProperties: false,
  },
  annotations: { title: "Delete local file", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
} as const;

const GET_OPERATION_STATUS_TOOL = {
  name: "get_operation_status",
  title: "Get operation status",
  description: "Query a previously submitted operation by its stable operation_id. This only reads the local receipt and never dispatches work.",
  inputSchema: {
    type: "object",
    properties: { operation_id: { type: "string", minLength: 1, maxLength: 128 } },
    required: ["operation_id"],
    additionalProperties: false,
  },
  annotations: { title: "Get operation status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} as const;

const START_PROCESS_TOOL = {
  name: "run_command", title: "Start development command",
  description: "Start a development command with the Agent account's fixed local Shell. Commands run with that Linux account's full OS permissions. Every start requires a stable operation_id; after an uncertain response, query that ID before considering a new intent. A running command returns an Agent-owned session_id. Shell commands use the authorized Linux Agent account's current OS permissions.",
  inputSchema: { type: "object", properties: { operation_id: { type: "string", minLength: 1, maxLength: 128 }, command: { type: "string", minLength: 1, maxLength: 8192 }, timeout_ms: { type: "integer", minimum: 0, maximum: 30000, description: "Maximum time to wait before returning a running session; defaults to 1000 ms." } }, required: ["operation_id", "command"], additionalProperties: false },
  annotations: { title: "Start development command", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const;

const LIST_SESSIONS_TOOL = {
  name: "list_sessions", title: "List managed sessions",
  description: "List only development command sessions started and tracked by this Agent. Completed sessions are retained for a bounded period.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "List managed sessions", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} as const;

const READ_PROCESS_OUTPUT_TOOL = {
  name: "read_session_output", title: "Read managed session output",
  description: "Read a bounded byte page from a session started by this Agent. Includes session state, next offset, truncation, and EOF. Stale or unknown session IDs are rejected.",
  inputSchema: { type: "object", properties: { session_id: { type: "string", format: "uuid" }, offset: { type: "integer", minimum: 0, maximum: 262144 }, length: { type: "integer", minimum: 1, maximum: 65536 } }, required: ["session_id"], additionalProperties: false },
  annotations: { title: "Read managed session output", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
} as const;

const INTERACT_WITH_PROCESS_TOOL = {
  name: "send_input", title: "Send input to managed session",
  description: "Send a bounded UTF-8 input page to a session started by this Agent. Each input requires a stable operation_id; uncertain input is never replayed. Only a currently tracked session can receive input.",
  inputSchema: { type: "object", properties: { operation_id: { type: "string", minLength: 1, maxLength: 128 }, session_id: { type: "string", format: "uuid" }, input: { type: "string", minLength: 1, maxLength: 8192 } }, required: ["operation_id", "session_id", "input"], additionalProperties: false },
  annotations: { title: "Send input to managed session", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const;

const FORCE_TERMINATE_TOOL = {
  name: "stop_session", title: "Stop managed session",
  description: "Stop only a session started and still owned by this Agent. Uses a graceful signal followed by bounded escalation after rechecking the same process identity. A stale or unverified session is rejected.",
  inputSchema: { type: "object", properties: { operation_id: { type: "string", minLength: 1, maxLength: 128 }, session_id: { type: "string", format: "uuid" } }, required: ["operation_id", "session_id"], additionalProperties: false },
  annotations: { title: "Stop managed session", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const;

const LOCAL_TOOLS = [
  READ_FILE_TOOL,
  READ_MULTIPLE_TOOL,
  LIST_DIRECTORY_TOOL,
  FILE_INFO_TOOL,
  START_SEARCH_TOOL,
  GET_MORE_SEARCH_RESULTS_TOOL,
  STOP_SEARCH_TOOL,
  WRITE_FILE_TOOL,
  CREATE_DIRECTORY_TOOL,
  EDIT_BLOCK_TOOL,
  MOVE_FILE_TOOL,
  DELETE_FILE_TOOL,
  GET_OPERATION_STATUS_TOOL,
  START_PROCESS_TOOL,
  LIST_SESSIONS_TOOL,
  READ_PROCESS_OUTPUT_TOOL,
  INTERACT_WITH_PROCESS_TOOL,
  FORCE_TERMINATE_TOOL,
];

function isKnownTool(name: unknown): boolean {
  // Only the curated public names are reachable. Private Agent method names
  // cannot be supplied directly to bypass argument validation or authorization.
  return typeof name === "string" && LOCAL_TOOLS.some((tool) => tool.name === name);
}

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
  "write_completed",
  "write_failed",
  "directory_completed",
  "directory_failed",
  "edit_completed",
  "edit_failed",
  "move_completed",
  "move_failed",
  "delete_completed",
  "delete_failed",
  "operation_conflict",
  "not_found",
  "process_started",
  "process_failed",
  "process_listed",
  "process_output_read",
  "process_input_sent",
  "process_terminated",
  "process_action_failed",
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
  | { tool: "get_more_search_results" | "stop_search"; arguments: SearchSessionId }
  | { tool: "write_file"; arguments: LocalWriteFile }
  | { tool: "create_directory"; arguments: LocalCreateDirectory }
  | { tool: "edit_block"; arguments: LocalEditBlock }
  | { tool: "move_file"; arguments: LocalMoveFile }
  | { tool: "delete_file"; arguments: LocalDeleteFile }
  | { tool: "get_operation_status"; arguments: OperationId }
  | { tool: "start_process"; arguments: LocalStartProcess }
  | { tool: "list_sessions"; arguments: Record<string, never> }
  | { tool: "read_process_output"; arguments: LocalProcessOutput }
  | { tool: "interact_with_process"; arguments: LocalProcessInteraction }
  | { tool: "force_terminate"; arguments: LocalProcessTermination };

function mutationTool(call: LocalCall): boolean {
  return call.tool === "write_file" || call.tool === "create_directory" || call.tool === "edit_block" || call.tool === "move_file" || call.tool === "delete_file" || call.tool === "start_process" || call.tool === "interact_with_process" || call.tool === "force_terminate";
}

function callOperationId(call: LocalCall): string | undefined {
  if (call.tool === "get_operation_status") return call.arguments.operationId;
  if (call.tool === "write_file" || call.tool === "create_directory" || call.tool === "edit_block" || call.tool === "move_file" || call.tool === "delete_file") return call.arguments.operationId;
  if (call.tool === "start_process") return call.arguments.operationId;
  if (call.tool === "interact_with_process" || call.tool === "force_terminate") return call.arguments.operationId;
  return undefined;
}

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
  if (call.tool === "write_file") {
    return {
      path: call.arguments.path,
      content: call.arguments.content,
      mode: call.arguments.mode,
    };
  }
  if (call.tool === "create_directory") return { path: call.arguments.path };
  if (call.tool === "edit_block") return { file_path: call.arguments.filePath, old_string: call.arguments.oldString, new_string: call.arguments.newString, expected_replacements: call.arguments.expectedReplacements };
  if (call.tool === "move_file") return { source: call.arguments.source, destination: call.arguments.destination };
  if (call.tool === "delete_file") return { path: call.arguments.path };
  if (call.tool === "get_operation_status") return { operation_id: call.arguments.operationId };
  if (call.tool === "start_process") return { command: call.arguments.command, timeout_ms: call.arguments.timeoutMs };
  if (call.tool === "list_sessions") return {};
  if (call.tool === "read_process_output") return { session_id: call.arguments.sessionId, offset: call.arguments.offset, length: call.arguments.length };
  if (call.tool === "interact_with_process") return { session_id: call.arguments.sessionId, input: call.arguments.input };
  if (call.tool === "force_terminate") return { session_id: call.arguments.sessionId };
  return { session_id: call.arguments.sessionId };
}

function deviceUrl(call: LocalCall): string {
  if (call.tool === "get_operation_status") {
    return `http://remote-control-device.invalid/internal/operations/${encodeURIComponent(call.arguments.operationId)}`;
  }
  return DEVICE_CALL_URL;
}

const PUBLIC_TO_AGENT_TOOL: Record<string, string> = {
  "read_files": "read_multiple_files",
  "stat_file": "get_file_info",
  "search_files": "start_search",
  "search_next": "get_more_search_results",
  "replace_text": "edit_block",
  "run_command": "start_process",
  "read_session_output": "read_process_output",
  "send_input": "interact_with_process",
  "stop_session": "force_terminate",
};
// The Agent protocol and persisted tool_name stay stable across public MCP renames.
const AGENT_TO_PUBLIC_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(PUBLIC_TO_AGENT_TOOL).map(([publicName, agentName]) => [agentName, publicName]),
);

function parseLocalCall(name: unknown, args: unknown): LocalCall | null {
  // Keep the private Agent protocol and existing receipt names stable.
  if (typeof name === "string") name = PUBLIC_TO_AGENT_TOOL[name] ?? name;
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
  if (name === "write_file") {
    const write = parseLocalWriteFile(args);
    return write ? { tool: "write_file", arguments: write } : null;
  }
  if (name === "create_directory") {
    const operation = parseLocalCreateDirectory(args);
    return operation ? { tool: "create_directory", arguments: operation } : null;
  }
  if (name === "edit_block") {
    const operation = parseLocalEditBlock(args);
    return operation ? { tool: "edit_block", arguments: operation } : null;
  }
  if (name === "move_file") {
    const operation = parseLocalMoveFile(args);
    return operation ? { tool: "move_file", arguments: operation } : null;
  }
  if (name === "delete_file") {
    const operation = parseLocalDeleteFile(args);
    return operation ? { tool: "delete_file", arguments: operation } : null;
  }
  if (name === "get_operation_status") {
    const operation = parseOperationId(args);
    return operation ? { tool: "get_operation_status", arguments: operation } : null;
  }
  if (name === "start_process") {
    const process = parseStartProcess(args);
    return process ? { tool: "start_process", arguments: process } : null;
  }
  if (name === "list_sessions") {
    return parseListSessions(args) ? { tool: "list_sessions", arguments: {} } : null;
  }
  if (name === "read_process_output") {
    const output = parseLocalProcessOutput(args);
    return output ? { tool: "read_process_output", arguments: output } : null;
  }
  if (name === "interact_with_process") {
    const interaction = parseLocalProcessInteraction(args);
    return interaction ? { tool: "interact_with_process", arguments: interaction } : null;
  }
  if (name === "force_terminate") {
    const termination = parseLocalProcessTermination(args);
    return termination ? { tool: "force_terminate", arguments: termination } : null;
  }
  return null;
}

function failureMessage(tool: LocalCall["tool"]): string {
  if (tool === "list_directory") return "The directory list failed.";
  if (tool === "get_file_info") return "The file info request failed.";
  if (tool === "start_search") return "The search could not be completed.";
  if (tool === "get_more_search_results" || tool === "stop_search") return "The search session is unavailable.";
  if (tool === "read_process_output") return "The managed session is unavailable.";
  if (tool === "interact_with_process" || tool === "force_terminate") return "The managed session action failed.";
  return "The file read failed.";
}

function successEvent(tool: LocalCall["tool"]): string {
  if (tool === "list_directory") return "list_completed";
  if (tool === "get_file_info") return "info_completed";
  if (tool === "start_search" || tool === "get_more_search_results") return "search_completed";
  if (tool === "stop_search") return "search_stopped";
  if (tool === "start_process") return "process_started";
  if (tool === "list_sessions") return "process_listed";
  if (tool === "read_process_output") return "process_output_read";
  if (tool === "interact_with_process") return "process_input_sent";
  if (tool === "force_terminate") return "process_terminated";
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

function publicReceipt(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const receipt = value as Record<string, unknown>;
  const allowed = ["operation_id", "tool_name", "state", "created_at", "updated_at", "safe_result_summary", "session_id"];
  const projection: Record<string, unknown> = {};
  for (const key of allowed) if (receipt[key] !== undefined) projection[key] = receipt[key];
  if (typeof projection.tool_name === "string") {
    const publicName = AGENT_TO_PUBLIC_TOOL[projection.tool_name] ?? projection.tool_name;
    if (LOCAL_TOOLS.some((tool) => tool.name === publicName)) projection.public_tool_name = publicName;
  }
  return projection.operation_id && projection.state ? projection : null;
}

async function callDevice(env: Env, call: LocalCall, id: unknown, signal: AbortSignal): Promise<Response> {
  const operationId = callOperationId(call);
  const isMutation = mutationTool(call);
  const deviceToken = env.REMOTE_CONTROL_DEVICE_TOKEN;
  const binding = env.REMOTE_CONTROL_DEVICE;
  if (!deviceToken || !binding) {
    log("device_not_configured");
    return operationId
      ? toolText(id, JSON.stringify({ operation_id: operationId, status: "unavailable" }))
      : toolError(id, "The remote device is unavailable.");
  }

  let response: Response;
  const requestBody = call.tool === "get_operation_status"
    ? undefined
    : JSON.stringify({
        tool: call.tool,
        ...(operationId ? { operation_id: operationId } : {}),
        arguments: upstreamArguments(call),
      });
  if (requestBody !== undefined && new TextEncoder().encode(requestBody).byteLength > MAX_DEVICE_REQUEST_BYTES) {
    return operationId
      ? toolError(id, JSON.stringify({ operation_id: operationId, status: "bad_request" }))
      : toolError(id, "The requested tool call was rejected.");
  }
  try {
    response = await binding.fetch(deviceUrl(call), {
      method: call.tool === "get_operation_status" ? "GET" : "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-device-credential": deviceToken,
      },
      ...(requestBody === undefined ? {} : { body: requestBody }),
    });
  } catch {
    log("device_unavailable");
    return operationId
      ? toolText(id, JSON.stringify({ operation_id: operationId, status: isMutation ? "timeout_unknown" : "unavailable" }))
      : toolError(id, "The remote device is unavailable.");
  }

  const raw = await readResponseText(response);
  if (raw === null) {
    log("device_unavailable");
    return operationId
      ? toolText(id, JSON.stringify({ operation_id: operationId, status: isMutation ? "timeout_unknown" : "unavailable" }))
      : toolError(id, "The remote device is unavailable.");
  }

  if (!response.ok) {
    if (isMutation && operationId && response.status === 409) {
      log("operation_conflict");
      return toolError(id, JSON.stringify({ operation_id: operationId, status: "conflict" }));
    }
    if (call.tool === "get_operation_status" && response.status === 404) {
      return toolText(id, JSON.stringify({ operation_id: call.arguments.operationId, status: "not_found" }));
    }
    if (call.tool === "read_process_output" && response.status === 404) {
      log("not_found");
      return toolError(id, "The managed session was not found.");
    }
    if ((call.tool === "interact_with_process" || call.tool === "force_terminate") && response.status === 404) {
      log("not_found");
      return toolError(id, "The managed session was not found.");
    }
    if (operationId && response.status === 503) {
      let knownUnavailable = false;
      try {
        const failed = JSON.parse(raw) as { status?: unknown };
        knownUnavailable = failed.status === "unavailable";
      } catch { /* An unreadable submitted-write response has an unknown outcome. */ }
      return toolText(id, JSON.stringify({
        operation_id: operationId,
        status: knownUnavailable || !isMutation ? "unavailable" : "timeout_unknown",
      }));
    }
    if (operationId) {
      const status = response.status === 400 ? "bad_request" : "unavailable";
      return isMutation
        ? toolError(id, JSON.stringify({ operation_id: operationId, status }))
        : toolText(id, JSON.stringify({ operation_id: operationId, status }));
    }
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
    return operationId
      ? toolText(id, JSON.stringify({ operation_id: operationId, status: "timeout_unknown" }))
      : toolError(id, "The remote device is unavailable.");
  }

  const text = completedText(parsed);
  if (isMutation && parsed !== null && typeof parsed === "object") {
    const operation = parsed as { operation_id?: unknown; status?: unknown; receipt?: unknown; session_id?: unknown };
    if (call.tool === "start_process") {
      log(operation.status === "failed" ? "process_failed" : "process_started");
      return toolText(id, JSON.stringify({ operation_id: operationId, status: operation.status, session_id: operation.session_id, receipt: publicReceipt(operation.receipt) }));
    }
    if (call.tool === "interact_with_process" || call.tool === "force_terminate") {
      const event = call.tool === "force_terminate" ? "process_terminated" : "process_input_sent";
      log(operation.status === "failed" ? "process_action_failed" : event);
      return toolText(id, JSON.stringify({ operation_id: operationId, status: operation.status, session_id: call.arguments.sessionId, receipt: publicReceipt(operation.receipt) }));
    }
    const category = call.tool === "create_directory" ? "directory" : call.tool === "edit_block" ? "edit" : call.tool === "move_file" ? "move" : "write";
    log(operation.status === "failed" ? `${category}_failed` : `${category}_completed`);
    return toolText(id, JSON.stringify({ operation_id: operationId, status: operation.status, receipt: publicReceipt(operation.receipt) }));
  }
  if (call.tool === "get_operation_status") {
    const record = parsed as Record<string, unknown>;
    return toolText(id, JSON.stringify(publicReceipt(record)));
  }
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
        "File and Shell tools execute with the authorized Linux Agent account's actual OS permissions. Each mutation requires a stable operation ID; query the original ID after an uncertain response, and use a new ID only for a new intent. Managed sessions accept bounded stdin and stop requests only while the Agent can verify ownership; after restart, stale session actions are rejected and uncertain operations are never replayed.",
    });
  }

  if (rpcMessage.method === "tools/list") {
    return rpc(rpcMessage.id, { tools: pendingOwner(env) ? [...LOCAL_TOOLS, PAIRING_LOOKUP_TOOL, PAIRING_PREPARE_TOOL] : LOCAL_TOOLS });
  }

  if (rpcMessage.method === "tools/call") {
    const params = rpcMessage.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      log("rejected");
      return toolError(rpcMessage.id, "The requested tool call was rejected.");
    }
    const call = params as { name?: unknown; arguments?: unknown };
    if (call.name === "pairing_prepare" && pendingOwner(env)) {
      return prepareLocalDevice(env, rpcMessage.id, call.arguments);
    }
    if (call.name === "pairing_lookup" && pendingOwner(env)) {
      const args = call.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args) ||
          Object.keys(args).length !== 1 || !Object.hasOwn(args, "code")) {
        return toolError(rpcMessage.id, "The pairing lookup was rejected.");
      }
      return lookupPendingDevice(env, (args as { code?: unknown }).code, rpcMessage.id);
    }
    if (!isKnownTool(call.name)) {
      log("rejected");
      return toolError(rpcMessage.id, "The requested tool call was rejected.");
    }
    if (["write_file", "create_directory", "replace_text", "move_file", "delete_file", "run_command", "send_input", "stop_session"].includes(String(call.name))) {
      const candidate = call.arguments !== null && typeof call.arguments === "object"
        ? (call.arguments as Record<string, unknown>).operation_id
        : undefined;
      const validId = parseOperationId({ operation_id: candidate });
      if (!validId) {
        log("rejected");
        return toolError(rpcMessage.id, "The mutation requires a valid operation_id.");
      }
      if (!parseLocalCall(call.name, call.arguments)) {
        log("rejected");
        return toolError(rpcMessage.id, JSON.stringify({ operation_id: validId.operationId, status: "bad_request" }));
      }
    }
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
    if (url.pathname.startsWith("/agent/connect/") && pendingOwner(env)) {
      const deviceId = url.pathname.slice("/agent/connect/".length);
      if (request.method !== "GET" || !/^[a-f0-9-]{36}$/.test(deviceId) ||
          url.search || request.headers.has("origin") ||
          request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonError(400, "bad_request", "The request was rejected.");
      }
      const protocols = request.headers.get("sec-websocket-protocol");
      if (!protocols || protocols.length > 256) return jsonError(401, "unauthorized", "Invalid session proof.");
      try {
        return await pendingOwner(env)!.fetch("https://v2.internal/ws/" + deviceId, {
          headers: { upgrade: "websocket", "sec-websocket-protocol": protocols },
        });
      } catch { return jsonError(503, "unavailable", "Device session is unavailable."); }
    }
    if ((url.pathname === "/agent/pair/start" || url.pathname === "/agent/pair/complete" ||
         url.pathname === "/agent/session/challenge" || url.pathname === "/agent/session/recover") && pendingOwner(env)) {
      if (request.method !== "POST" || request.headers.has("origin")) {
        return jsonError(405, "method_not_allowed", "The request was rejected.");
      }
      try {
        const raw = await readBounded(request, 4096);
        if (raw === null) return jsonError(400, "bad_request", "The request was rejected.");
        return await pendingOwner(env)!.fetch(url.pathname === "/agent/pair/complete" ? "https://v2.internal/complete" :
          url.pathname === "/agent/session/challenge" ? "https://v2.internal/session/challenge" :
          url.pathname === "/agent/session/recover" ? "https://v2.internal/session/recover" : "https://v2.internal/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        });
      } catch {
        return jsonError(503, "unavailable", "Pending enrollment is unavailable.");
      }
    }
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
