/**
 * v2 Agent lifecycle with an explicitly enabled, bounded read-only capability.
 *
 * Heartbeats are answered by the Durable Object Hibernation auto-response,
 * without waking the DO for normal liveness checks. Remote reads are disabled
 * by default; this handler never executes Shell or write operations.
 */
import { DeviceSessionRejectedError, openAuthenticatedDeviceSocket } from "./v2-session-client.ts";
import { executeReadTool } from "./read-execution.ts";
import { parseLocalRead, parseReadMultiple, parseListDirectory, parseFileInfo } from "./local-read.ts";
import { SearchSessions } from "./search.ts";

export type SocketEnd = "aborted" | "closed" | "offline" | "policy";
const PING = "rc-v2:ping";
const PONG = "rc-v2:pong";
const AUTH_REQUEST = "rc-v2:auth:";
const AUTH_RESPONSE = "rc-v2:auth-ok:";
const AUTH_INTERVAL_MS = 900_000; // 15 minutes; a deliberate, rare DO wake-up.
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;

export function monitorDeviceSocket(
  socket: WebSocket,
  signal: AbortSignal,
  timing: { intervalMs: number; timeoutMs: number; authIntervalMs?: number } = {
    intervalMs: HEARTBEAT_INTERVAL_MS, timeoutMs: HEARTBEAT_TIMEOUT_MS,
  },
  readOnly?: (tool: string, args: unknown, signal: AbortSignal) => Promise<string | null>,
): Promise<SocketEnd> {
  const authEvery = timing.authIntervalMs ?? AUTH_INTERVAL_MS;
  if (!Number.isFinite(timing.intervalMs) || timing.intervalMs <= 0 ||
      !Number.isFinite(timing.timeoutMs) || timing.timeoutMs <= 0 ||
      timing.timeoutMs >= timing.intervalMs ||
      !Number.isFinite(authEvery) || authEvery <= timing.timeoutMs) {
    throw new Error("Invalid Agent heartbeat interval.");
  }
  return new Promise((resolve) => {
    let settled = false;
    let awaitingPong = false;
    let readsInFlight = 0;
    let awaitingAuth: string | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let authWatchdog: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let authInterval: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (interval) clearInterval(interval);
      if (authInterval) clearInterval(authInterval);
      if (watchdog) clearTimeout(watchdog);
      if (authWatchdog) clearTimeout(authWatchdog);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const finish = (why: SocketEnd) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (why !== "closed") {
        try { socket.close(); } catch { /* connection already gone */ }
      }
      resolve(why);
    };
    const onAbort = () => finish("aborted");
    const onClose = (event: Event) => {
      const { code, reason } = event as Event & { code?: number; reason?: string };
      finish(code === 1008 ? "policy" : code === 1000 && reason === "superseded" ? "closed" : "offline");
    };
    const onError = () => finish("offline");
    const onMessage = (event: MessageEvent) => {
      if (event.data === PONG) {
        if (!awaitingPong) return; // Ignore late duplicate pongs.
        awaitingPong = false;
        if (watchdog) clearTimeout(watchdog);
        watchdog = undefined;
        return;
      }
      if (typeof event.data === "string" && event.data.startsWith(AUTH_RESPONSE)) {
        // A delayed reply to an older check can never satisfy this request.
        // Ignore stale/duplicate replies, but retain the active deadline.
        if (!awaitingAuth || event.data !== AUTH_RESPONSE + awaitingAuth) return;
        awaitingAuth = undefined;
        if (authWatchdog) clearTimeout(authWatchdog);
        authWatchdog = undefined;
        return;
      }
      if (typeof event.data === "string" && event.data.length <= 65_536 &&
          event.data.startsWith("{") && readOnly) {
        let request: Record<string, unknown> | undefined;
        try {
          const decoded = JSON.parse(event.data) as unknown;
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
            request = decoded as Record<string, unknown>;
          }
        } catch { /* Not an authorized read frame. */ }
        const readParsers: Record<string, (args: unknown) => unknown> = {
          read_file: parseLocalRead, read_multiple_files: parseReadMultiple,
          list_directory: parseListDirectory, get_file_info: parseFileInfo,
        };
        if (request?.kind === "read" && typeof request.tool === "string" &&
            Object.hasOwn(readParsers, request.tool) &&
            typeof request.request_id === "string" &&
            /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.request_id) &&
            Object.keys(request).length === 4 && readParsers[request.tool]?.(request.arguments) &&
            readsInFlight < 4) {
          readsInFlight++;
          const id = request.request_id;
          const tool = request.tool;
          void Promise.resolve().then(() => readOnly(tool, request.arguments, signal))
            .then(text => {
              if (settled || signal.aborted || socket.readyState !== WebSocket.OPEN) return;
              const valid = typeof text === "string" && text.length <= 65_536;
              socket.send(JSON.stringify({
                kind: "read_result", request_id: id,
                status: valid ? "completed" : "failed",
                ...(valid ? { text } : {}),
              }));
            }).catch(() => {
              if (!settled && !signal.aborted && socket.readyState === WebSocket.OPEN) {
                try { socket.send(JSON.stringify({ kind: "read_result", request_id: id, status: "failed" })); }
                catch { finish("offline"); }
              }
            }).finally(() => { readsInFlight--; });
          return;
        }
      }
      finish("policy"); // Never interpret non-read traffic as an executable request.
    };
    if (signal.aborted) { finish("aborted"); return; }
    if (socket.readyState !== WebSocket.OPEN) { finish("offline"); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    interval = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) { finish("offline"); return; }
      if (awaitingPong) return;
      awaitingPong = true;
      watchdog = setTimeout(() => finish("offline"), timing.timeoutMs);
      try { socket.send(PING); } catch { finish("offline"); }
    }, timing.intervalMs);
    // Automatic pongs prove transport liveness only. This separate low-frequency
    // check intentionally wakes the DO to verify the current device/epoch.
    authInterval = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) { finish("offline"); return; }
      if (awaitingAuth) return;
      // Every authority check has a unique identifier. No fixed-string ACK
      // from an earlier check may authorize a later one after network delay.
      awaitingAuth = crypto.randomUUID().replace(/-/g, "");
      authWatchdog = setTimeout(() => finish("offline"), timing.timeoutMs);
      try { socket.send(AUTH_REQUEST + awaitingAuth); } catch { finish("offline"); }
    }, authEvery);
  });
}

/**
 * Bounded retry delay. Every reconnection obtains a FRESH signed nonce via
 * openAuthenticatedDeviceSocket; no ambiguous command or old nonce is replayed.
 * A policy close stops retrying until an operator restarts the Agent.
 */
export async function maintainAuthenticatedDeviceSession(
  baseAddress: string,
  keyPath: string,
  signal: AbortSignal,
  options: {
    send?: typeof fetch;
    makeSocket?: (url: string, protocols: string[]) => WebSocket;
    heartbeat?: { intervalMs: number; timeoutMs: number; authIntervalMs?: number };
    // Explicit opt-in for isolated T05 tests. Default remains authentication only.
    readOnly?: boolean;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    onState?: (status: "connected" | "disconnected" | "rejected") => void;
  } = {},
): Promise<void> {
  const delay = options.wait ?? ((ms: number, abort: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (abort.aborted) { resolve(); return; }
      const done = () => { clearTimeout(timer); abort.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      abort.addEventListener("abort", done, { once: true });
    }));
  let failures = 0;
  while (!signal.aborted) {
    try {
      const connection = await openAuthenticatedDeviceSocket(
        baseAddress, keyPath, options.send, options.makeSocket, signal,
      );
      if (signal.aborted) { connection.socket.close(); break; }
      const connectedAt = performance.now();
      options.onState?.("connected");
      const outcome = await monitorDeviceSocket(connection.socket, signal, options.heartbeat,
        options.readOnly ? async (tool, args, requestSignal) => {
          const searches = new SearchSessions();
          try {
            // Reuse the existing v1 validated read engine, never the Shell/mutation dispatcher.
            const reply = await executeReadTool(tool, args, searches, requestSignal);
            return reply.kind === "completed" ? reply.text : null;
          } finally { await searches.close(); }
        } : undefined);
      if (outcome === "aborted" || outcome === "closed") return;
      if (outcome === "policy") { options.onState?.("rejected"); return; }
      // Opening a socket is not evidence of stability. If an Agent loops
      // through brief successful handshakes, keep the escalating backoff.
      // After two healthy heartbeat periods, reset for fast future recovery.
      const intervalMs = options.heartbeat?.intervalMs ?? HEARTBEAT_INTERVAL_MS;
      if (performance.now() - connectedAt >= intervalMs * 2) failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof DeviceSessionRejectedError) {
        options.onState?.("rejected");
        return;
      }
      // Temporary transport faults remain retryable; no credential material or
      // raw exception objects are written to logs.
    }
    if (signal.aborted) break;
    options.onState?.("disconnected");
    const capped = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
    failures++;
    await delay(capped, signal);
  }
}
