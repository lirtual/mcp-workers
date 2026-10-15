/**
 * Authentication-only v2 Agent connection lifecycle.
 *
 * Heartbeats are answered by the Durable Object Hibernation auto-response,
 * without waking the DO for normal liveness checks. This deliberately does
 * not accept or execute remote commands.
 */
import { openAuthenticatedDeviceSocket } from "./v2-session-client.ts";

export type SocketEnd = "aborted" | "closed" | "offline" | "policy";
const PING = "rc-v2:ping";
const PONG = "rc-v2:pong";
const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;

export function monitorDeviceSocket(
  socket: WebSocket,
  signal: AbortSignal,
  timing: { intervalMs: number; timeoutMs: number } = {
    intervalMs: HEARTBEAT_INTERVAL_MS, timeoutMs: HEARTBEAT_TIMEOUT_MS,
  },
): Promise<SocketEnd> {
  if (!Number.isFinite(timing.intervalMs) || timing.intervalMs <= 0 ||
      !Number.isFinite(timing.timeoutMs) || timing.timeoutMs <= 0 ||
      timing.timeoutMs >= timing.intervalMs) {
    throw new Error("Invalid Agent heartbeat interval.");
  }
  return new Promise((resolve) => {
    let settled = false;
    let awaitingPong = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (interval) clearInterval(interval);
      if (watchdog) clearTimeout(watchdog);
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
      if (event.data !== PONG) return finish("policy");
      if (!awaitingPong) return; // Ignore unsolicited/late harmless duplicate pongs.
      awaitingPong = false;
      if (watchdog) clearTimeout(watchdog);
      watchdog = undefined;
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
    heartbeat?: { intervalMs: number; timeoutMs: number };
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
        baseAddress, keyPath, options.send, options.makeSocket,
      );
      if (signal.aborted) { connection.socket.close(); break; }
      failures = 0;
      options.onState?.("connected");
      const outcome = await monitorDeviceSocket(connection.socket, signal, options.heartbeat);
      if (outcome === "aborted" || outcome === "closed") return;
      if (outcome === "policy") { options.onState?.("rejected"); return; }
    } catch {
      if (signal.aborted) break;
      // Do not expose credential material or exception objects in Agent logs.
    }
    if (signal.aborted) break;
    options.onState?.("disconnected");
    const capped = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
    failures++;
    await delay(capped, signal);
  }
}
