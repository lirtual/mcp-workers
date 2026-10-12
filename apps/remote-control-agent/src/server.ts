import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { listLocalDirectory, readLocalFileInfo, readMultipleLocalFiles, BrowseFailed } from "./browse.ts";
import {
  parseFileInfo,
  parseListDirectory,
  parseLocalRead,
  parseReadMultiple,
  parseSearchSessionId,
  parseSearchStart,
} from "./local-read.ts";
import { readLocalFile, ReadFailed } from "./read-file.ts";
import { SearchFailed, SearchSessions } from "./search.ts";

const MAX_BODY_BYTES = 65_536;
const LOOPBACK_HOST = "127.0.0.1";
const SAFE_EVENTS = new Set([
  "unauthorized",
  "rejected",
  "read_completed",
  "read_failed",
  "list_completed",
  "list_failed",
  "info_completed",
  "info_failed",
  "search_started",
  "search_completed",
  "search_failed",
  "search_stopped",
  "unavailable",
  "not_found",
  "health",
  "status",
]);

export type AgentLog = (event: string) => void;

export interface StartAgentOptions {
  deviceToken: string;
  host?: string;
  port?: number;
  log?: AgentLog;
  /** Process-local startup setting; production uses the fixed default. */
  searchSessionTtlMs?: number;
}

export interface RunningAgent {
  baseUrl: string;
  hostname: string;
  port: number;
  close: () => Promise<void>;
}

function credentialsMatch(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

function emit(log: AgentLog | undefined, event: string): void {
  if (!SAFE_EVENTS.has(event)) return;
  log?.(event);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = request.headers["content-length"];
    if (typeof declared === "string" && Number(declared) > MAX_BODY_BYTES) {
      resolve(null);
      request.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        resolve(null);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function deviceCredential(request: IncomingMessage): string | null {
  const header = request.headers["x-device-credential"];
  if (typeof header !== "string" || header.length === 0) return null;
  return header;
}

function operationId(pathname: string): string | null {
  const prefix = "/internal/operations/";
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return null;
  return id;
}

type ToolOutcome =
  | { kind: "rejected"; message: string }
  | {
      kind: "failed";
      event: "read_failed" | "list_failed" | "info_failed" | "search_failed";
      code: "bad_request" | "failed" | "not_found" | "conflict";
      message: string;
    }
  | { kind: "unavailable" }
  | {
      kind: "completed";
      event: "read_completed" | "list_completed" | "info_completed" | "search_completed" | "search_stopped";
      text: string;
    };

async function runTool(
  tool: unknown,
  args: unknown,
  searches: SearchSessions,
  requestSignal: AbortSignal,
  log: AgentLog | undefined,
): Promise<ToolOutcome> {
  try {
    if (tool === "read_file") {
      const read = parseLocalRead(args);
      if (!read) return { kind: "rejected", message: "The requested tool call was rejected." };
      return { kind: "completed", event: "read_completed", text: await readLocalFile(read) };
    }
    if (tool === "read_multiple_files") {
      const read = parseReadMultiple(args);
      if (!read) return { kind: "rejected", message: "The requested tool call was rejected." };
      return { kind: "completed", event: "read_completed", text: await readMultipleLocalFiles(read) };
    }
    if (tool === "list_directory") {
      const list = parseListDirectory(args);
      if (!list) return { kind: "rejected", message: "The requested tool call was rejected." };
      return { kind: "completed", event: "list_completed", text: await listLocalDirectory(list) };
    }
    if (tool === "get_file_info") {
      const info = parseFileInfo(args);
      if (!info) return { kind: "rejected", message: "The requested tool call was rejected." };
      return { kind: "completed", event: "info_completed", text: await readLocalFileInfo(info) };
    }
    if (tool === "start_search") {
      const search = parseSearchStart(args);
      if (!search) return { kind: "rejected", message: "The requested tool call was rejected." };
      emit(log, "search_started");
      return {
        kind: "completed",
        event: "search_completed",
        text: JSON.stringify(await searches.start(search, requestSignal)),
      };
    }
    if (tool === "get_more_search_results" || tool === "stop_search") {
      const session = parseSearchSessionId(args);
      if (!session) return { kind: "rejected", message: "The requested tool call was rejected." };
      const result =
        tool === "get_more_search_results"
          ? await searches.more(session.sessionId, requestSignal)
          : await searches.stop(session.sessionId);
      return {
        kind: "completed",
        event: tool === "stop_search" ? "search_stopped" : "search_completed",
        text: JSON.stringify(result),
      };
    }
    return { kind: "rejected", message: "The requested tool is not available." };
  } catch (error) {
    if (error instanceof ReadFailed) {
      return { kind: "failed", event: "read_failed", code: "bad_request", message: "The file read failed." };
    }
    if (error instanceof BrowseFailed) {
      const event = error.message.startsWith("The directory")
        ? "list_failed"
        : error.message.startsWith("The file info")
          ? "info_failed"
          : "read_failed";
      return { kind: "failed", event, code: "bad_request", message: error.message };
    }
    if (error instanceof SearchFailed) {
      return {
        kind: "failed",
        event: "search_failed",
        code: error.code,
        message: "The local search request could not be completed.",
      };
    }
    return { kind: "unavailable" };
  }
}

export async function startAgent(options: StartAgentOptions): Promise<RunningAgent> {
  if (!options.deviceToken) {
    throw new Error("Device credential is not configured.");
  }

  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error("Agent listens on loopback only.");
  }

  const log = options.log;
  const searches = new SearchSessions(options.searchSessionTtlMs);

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (request.aborted || response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      emit(log, "unavailable");
      sendJson(response, 503, {
        error: "unavailable",
        message: "The local file service is unavailable.",
      });
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestAbort = new AbortController();
    const abortIfDisconnected = () => {
      if (!response.writableEnded) requestAbort.abort();
    };
    request.once("aborted", abortIfDisconnected);
    response.once("close", abortIfDisconnected);

    const presented = deviceCredential(request);
    if (!presented || !credentialsMatch(presented, options.deviceToken)) {
      request.resume();
      emit(log, "unauthorized");
      sendJson(response, 401, {
        error: "unauthorized",
        message: "A valid device credential is required.",
      });
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && pathname === "/internal/healthz") {
      request.resume();
      emit(log, "health");
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && pathname.startsWith("/internal/operations/")) {
      request.resume();
      const id = operationId(pathname);
      if (!id) {
        emit(log, "rejected");
        sendJson(response, 400, {
          error: "bad_request",
          message: "The operation id was rejected.",
        });
        return;
      }
      emit(log, "status");
      sendJson(response, 404, {
        error: "not_found",
        message: "The operation was not found.",
      });
      return;
    }

    if (method === "POST" && pathname === "/internal/call") {
      const raw = await readBody(request);
      if (raw === null) {
        emit(log, "rejected");
        sendJson(response, 400, {
          error: "bad_request",
          message: "The request was rejected.",
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        emit(log, "rejected");
        sendJson(response, 400, {
          error: "bad_request",
          message: "The request was rejected.",
        });
        return;
      }

      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        emit(log, "rejected");
        sendJson(response, 400, {
          error: "bad_request",
          message: "The request was rejected.",
        });
        return;
      }

      const body = parsed as { tool?: unknown; arguments?: unknown };
      const outcome = await runTool(body.tool, body.arguments, searches, requestAbort.signal, log);
      if (requestAbort.signal.aborted) return;
      if (outcome.kind === "rejected") {
        emit(log, "rejected");
        sendJson(response, 400, {
          error: "bad_request",
          message: outcome.message,
        });
        return;
      }
      if (outcome.kind === "failed") {
        emit(log, outcome.event);
        sendJson(response, 200, {
          status: "failed",
          error: { code: outcome.code, message: outcome.message },
        });
        return;
      }
      if (outcome.kind === "unavailable") {
        emit(log, "unavailable");
        sendJson(response, 503, {
          error: "unavailable",
          message: "The local file service is unavailable.",
        });
        return;
      }
      emit(log, outcome.event);
      sendJson(response, 200, {
        status: "completed",
        result: { content: [{ type: "text", text: outcome.text }] },
      });
      return;
    }

    request.resume();
    emit(log, "not_found");
    sendJson(response, 404, {
      error: "not_found",
      message: "The route was not found.",
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    server.close();
    throw new Error("Agent listens on loopback only.");
  }

  return {
    baseUrl: `http://${LOOPBACK_HOST}:${address.port}`,
    hostname: address.address,
    port: address.port,
    close: async () => {
      await searches.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
