import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { parseLocalRead } from "./local-read.ts";
import { readLocalFile, ReadFailed } from "./read-file.ts";

const MAX_BODY_BYTES = 65_536;
const LOOPBACK_HOST = "127.0.0.1";
const SAFE_EVENTS = new Set([
  "unauthorized",
  "rejected",
  "read_completed",
  "read_failed",
  "unavailable",
  "not_found",
  "health",
  "status",
]);

export type AgentLog = (event: string) => void;

export interface StartAgentOptions {
  deviceToken: string;
  childHome: string;
  host?: string;
  port?: number;
  log?: AgentLog;
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

export async function startAgent(options: StartAgentOptions): Promise<RunningAgent> {
  if (!options.deviceToken) {
    throw new Error("Device credential is not configured.");
  }

  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) {
    throw new Error("Agent listens on loopback only.");
  }

  const childHome = path.resolve(options.childHome);
  if (childHome === path.resolve(os.homedir())) {
    throw new Error("Refusing to use the login home.");
  }
  const log = options.log;

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
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
      if (body.tool !== "read_file") {
        emit(log, "rejected");
        sendJson(response, 400, {
          error: "bad_request",
          message: "The requested tool is not available.",
        });
        return;
      }

      const read = parseLocalRead(body.arguments);
      if (!read) {
        emit(log, "rejected");
        sendJson(response, 400, {
          error: "bad_request",
          message: "The requested tool call was rejected.",
        });
        return;
      }

      try {
        const text = await readLocalFile(read);
        emit(log, "read_completed");
        sendJson(response, 200, {
          status: "completed",
          result: { content: [{ type: "text", text }] },
        });
      } catch (error) {
        if (error instanceof ReadFailed) {
          emit(log, "read_failed");
          sendJson(response, 200, {
            status: "failed",
            error: { code: "bad_request", message: "The file read failed." },
          });
          return;
        }
        emit(log, "unavailable");
        sendJson(response, 503, {
          error: "unavailable",
          message: "The local file service is unavailable.",
        });
      }
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
