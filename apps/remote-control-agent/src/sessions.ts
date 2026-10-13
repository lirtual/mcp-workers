import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

const MAX_SESSIONS = 10;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_PAGE_BYTES = 16 * 1024;
const MAX_PAGE_BYTES = 64 * 1024;
const MAX_WAIT_MS = 30_000;

export type SessionState = "running" | "completed" | "failed" | "unknown";

interface ManagedSession {
  sessionId: string;
  child: ChildProcess;
  control: SessionSupervisorControl;
  startedAt: string;
  lastObservedAt: number;
  endedAt?: number;
  state: SessionState;
  exitCode: number | null;
  terminationRequested: boolean;
  chunks: Buffer[];
  outputBytes: number;
  truncated: boolean;
  exited: Promise<void>;
  closed: Promise<void>;
}

export type SessionActionResult = "completed" | "failed" | "unknown" | "not_found";

export interface SessionSnapshot {
  session_id: string;
  state: SessionState;
  started_at: string;
  last_observed_at: string;
  exit_code: number | null;
}

export interface OutputPage extends SessionSnapshot {
  offset: number;
  next_offset: number;
  eof: boolean;
  truncated: boolean;
  output: string;
}

class SessionSupervisorControl {
  private readonly pending: Array<(value: string | null) => void> = [];
  private readonly buffered: string[] = [];
  private closed = false;
  readonly ready: Promise<boolean>;
  private readonly requests: Writable;

  constructor(requests: Writable, responses: Readable) {
    this.requests = requests;
    responses.on("data", (chunk: Buffer | string) => {
      for (const value of Buffer.from(chunk).toString("ascii")) {
        const waiter = this.pending.shift();
        if (waiter) waiter(value);
        else this.buffered.push(value);
      }
    });
    responses.on("end", () => this.finish());
    responses.on("error", () => this.finish());
    responses.on("close", () => this.finish());
    requests.on("error", () => this.finish());
    this.ready = this.next().then((value) => value === "R");
  }

  private finish(): void {
    this.closed = true;
    for (const waiter of this.pending.splice(0)) waiter(null);
  }

  private next(): Promise<string | null> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  async signal(signal: "SIGTERM" | "SIGKILL"): Promise<boolean> {
    const request = signal === "SIGTERM" ? "T" : "K";
    if (signal === "SIGKILL") {
      return await new Promise<boolean>((resolve) => {
        this.requests.write(request, "ascii", (error) => resolve(!error));
      });
    }
    const response = this.next();
    const written = await new Promise<boolean>((resolve) => {
      this.requests.write(request, "ascii", (error) => resolve(!error));
    });
    return written && (await response) === "O";
  }

  close(): void {
    this.requests.end();
  }
}

const supervisorPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.build/session-supervisor",
);

function snapshot(session: ManagedSession): SessionSnapshot {
  session.lastObservedAt = Date.now();
  return {
    session_id: session.sessionId,
    state: session.state,
    started_at: session.startedAt,
    last_observed_at: new Date(session.lastObservedAt).toISOString(),
    exit_code: session.exitCode,
  };
}

export class ManagedSessions {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly shellPath: string;

  constructor(shellPath: string) {
    if (!path.isAbsolute(shellPath)) throw new Error("The configured shell path must be absolute.");
    this.shellPath = shellPath;
  }

  private prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.state !== "running" && session.endedAt !== undefined && session.endedAt < cutoff) this.sessions.delete(id);
    }
  }

  async start(command: string, waitMs: number, onExit?: (session: SessionSnapshot) => Promise<void>): Promise<SessionSnapshot> {
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("Session capacity reached.");

    const sessionId = randomUUID();
    let child: ChildProcess;
    try {
      child = spawn(supervisorPath, [this.shellPath, command], {
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      throw new Error("The development command could not be started.");
    }

    const requestStream = child.stdio[3] as Writable | null;
    const responseStream = child.stdio[4] as Readable | null;
    if (!requestStream || !responseStream) throw new Error("The development command could not be started.");
    const control = new SessionSupervisorControl(requestStream, responseStream);

    const session: ManagedSession = {
      sessionId,
      child,
      control,
      startedAt: new Date().toISOString(),
      lastObservedAt: Date.now(),
      state: "running",
      exitCode: null,
      terminationRequested: false,
      chunks: [],
      outputBytes: 0,
      truncated: false,
      exited: Promise.resolve(),
      closed: Promise.resolve(),
    };

    const capture = (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - session.outputBytes;
      if (remaining <= 0) {
        session.truncated = true;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      session.chunks.push(Buffer.from(kept));
      session.outputBytes += kept.byteLength;
      if (kept.byteLength < chunk.byteLength) session.truncated = true;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.stdin?.on("error", () => { /* A closed process input is reported through write callbacks. */ });

    session.exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    session.closed = new Promise<void>((resolve) => {
      let settled = false;
      const finish = async (state: SessionState, exitCode: number | null) => {
        if (settled) return;
        settled = true;
        session.state = state;
        session.exitCode = exitCode;
        session.lastObservedAt = Date.now();
        session.endedAt = session.lastObservedAt;
        try { await onExit?.(snapshot(session)); } catch { /* Receipt reconciliation remains unknown after a persistence failure. */ }
        resolve();
      };
      child.once("error", () => { void finish("failed", null); });
      child.once("close", (code) => {
        const stopped = session.terminationRequested;
        void finish(code === 0 || stopped ? "completed" : "failed", code);
      });
    });

    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    const ready = await Promise.race([
      control.ready,
      session.closed.then(() => false),
      new Promise<boolean>((resolve) => { readyTimer = setTimeout(() => resolve(false), 2000); }),
    ]);
    if (readyTimer) clearTimeout(readyTimer);
    if (!ready) {
      await control.signal("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await control.signal("SIGKILL");
      await Promise.race([session.closed, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
      throw new Error("The managed Shell supervisor is unavailable on this Linux kernel.");
    }
    this.sessions.set(sessionId, session);

    if (waitMs > 0 && session.state === "running") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([session.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.min(waitMs, MAX_WAIT_MS)); })]);
      if (timer) clearTimeout(timer);
    }
    return snapshot(session);
  }

  private ownsRunningProcess(session: ManagedSession): boolean {
    return session.state === "running" && session.child.exitCode === null && session.child.signalCode === null;
  }

  private processExited(session: ManagedSession): boolean {
    return session.child.exitCode !== null || session.child.signalCode !== null;
  }

  private signalOwnedProcess(session: ManagedSession, signal: "SIGTERM" | "SIGKILL"): Promise<boolean> {
    if (!this.ownsRunningProcess(session)) return Promise.resolve(false);
    return session.control.signal(signal);
  }

  async writeInput(sessionId: string, input: string): Promise<SessionActionResult> {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return "not_found";
    const stdin = session.child.stdin;
    if (!this.ownsRunningProcess(session) || !stdin?.writable) return "failed";
    return await new Promise<SessionActionResult>((resolve) => {
      let settled = false;
      const finish = (result: SessionActionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish("unknown"), 1000);
      try {
        stdin.write(input, "utf8", (error) => finish(error ? "unknown" : "completed"));
      } catch {
        finish("failed");
      }
    });
  }

  async terminate(sessionId: string): Promise<SessionActionResult> {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return "not_found";
    if (session.state !== "running") return "completed";
    if (!await this.signalOwnedProcess(session, "SIGTERM")) return "unknown";
    session.terminationRequested = true;
    const waitForExit = async (timeoutMs: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        session.exited,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
    };
    await waitForExit(500);
    if (!this.processExited(session) && !await this.signalOwnedProcess(session, "SIGKILL")) return "unknown";
    await waitForExit(500);
    if (!this.processExited(session)) return "unknown";
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([session.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]);
    if (timer) clearTimeout(timer);
    return session.state === "running" ? "unknown" : "completed";
  }

  list(): SessionSnapshot[] {
    this.prune();
    return [...this.sessions.values()].map(snapshot);
  }

  get(sessionId: string): SessionSnapshot | null {
    this.prune();
    const session = this.sessions.get(sessionId);
    return session ? snapshot(session) : null;
  }

  read(sessionId: string, offset: number, length: number): OutputPage | null {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const data = Buffer.concat(session.chunks, session.outputBytes);
    const end = Math.min(data.byteLength, offset + length);
    return {
      ...snapshot(session),
      offset,
      next_offset: end,
      eof: session.state !== "running" && end >= data.byteLength,
      truncated: session.truncated,
      output: data.subarray(Math.min(offset, data.byteLength), end).toString("utf8"),
    };
  }

  async close(): Promise<void> {
    const running = [...this.sessions.values()].filter((session) => session.state === "running");
    const waitForClose = async (timeoutMs: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(running.map((session) => session.closed)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
    };
    await Promise.all(running.map((session) => this.signalOwnedProcess(session, "SIGTERM")));
    await waitForClose(500);
    await Promise.all(running.filter((session) => session.state === "running").map((session) => this.signalOwnedProcess(session, "SIGKILL")));
    await waitForClose(500);
    for (const session of running) {
      if (session.state === "running") {
        session.state = "unknown";
        session.lastObservedAt = Date.now();
      }
    }
    this.sessions.clear();
  }
}

export function parseStartProcess(input: unknown): { command: string; timeoutMs: number } | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "command" && key !== "timeout_ms")) return null;
  if (typeof record.command !== "string" || record.command.length === 0 || record.command.length > 8192 || record.command.includes("\0")) return null;
  const timeout = record.timeout_ms === undefined ? 1000 : record.timeout_ms;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 0 || timeout > MAX_WAIT_MS) return null;
  return { command: record.command, timeoutMs: timeout };
}

export function parseReadProcessOutput(input: unknown): { sessionId: string; offset: number; length: number } | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["session_id", "offset", "length"].includes(key))) return null;
  if (typeof record.session_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.session_id)) return null;
  const offset = record.offset === undefined ? 0 : record.offset;
  const length = record.length === undefined ? DEFAULT_PAGE_BYTES : record.length;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OUTPUT_BYTES) return null;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > MAX_PAGE_BYTES) return null;
  return { sessionId: record.session_id, offset, length };
}

export function parseListSessions(input: unknown): boolean {
  return input !== null && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0;
}

export function parseInteractWithProcess(input: unknown): { sessionId: string; input: string } | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "session_id" && key !== "input")) return null;
  if (typeof record.session_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.session_id)) return null;
  if (typeof record.input !== "string" || record.input.length === 0 || Buffer.byteLength(record.input, "utf8") > 8192 || record.input.includes("\0")) return null;
  return { sessionId: record.session_id, input: record.input };
}

export function parseForceTerminate(input: unknown): { sessionId: string } | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "session_id")) return null;
  if (typeof record.session_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.session_id)) return null;
  return { sessionId: record.session_id };
}
