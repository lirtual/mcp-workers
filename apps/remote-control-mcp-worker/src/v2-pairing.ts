/** v2 pending enrollment only. No connection or remote-command permission exists here. */
const PAIRING_DOMAIN = "remote-control:v2:pending:";
const MAX_BOOTSTRAP_BODY = 4096;
const MAX_PENDING = 24;
const TTL_MS = 600_000;
const BUDGET_WINDOW_MS = 60_000;
const MAX_REGISTRATIONS_PER_MINUTE = 12;
const MAX_LOOKUPS_PER_MINUTE = 30;
const MAX_PREPARES_PER_MINUTE = 8;
const MAX_COMPLETIONS_PER_MINUTE = 12;
const CHALLENGE_TTL_MS = 300_000;
const CONFIRM_DOMAIN = "remote-control:v2:local-confirm:";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const te = new TextEncoder();
import { issueSessionChallenge, authorizeSession, acceptAuthenticatedSocket, handleIdleSocketMessage, listApprovedDevices, type V2Device } from "./v2-session.ts";
import { parseLocalRead, parseReadMultiple, parseListDirectory, parseFileInfo, parseSearchStart, parseSearchSessionId, parseLocalWriteFile, parseLocalCreateDirectory, parseLocalEditBlock, parseLocalMoveFile, parseLocalDeleteFile, parseOperationId } from "./local-read.ts";

export interface PendingDevice {
  name: string;
  public_key: string;
  pairing_id: string;
  fingerprint: string;
  expires_at: number;
  created_at: number;
  confirmation_hash?: string;
  confirmation_expires_at?: number;
}

export interface ApprovedDevice {
  device_id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  approved_at: number;
  revoked: false;
}

type PendingStorage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete" | "transaction">;
type Registration = { name: string; public_key: string; code_verifier: string; proof: string; issued_at: number };
type AttemptBudget = { reset_at: number; count: number };

/**
 * Limits preapproval abuse using one tiny durable counter per operation, without
 * adding a KV/R2 service, an always-on alarm, or IP-based device tracking.
 * A sustained hostile flood can still deny service; this gate bounds DO work.
 */
async function consumeBudget(storage: PendingStorage, action: "register" | "lookup" | "prepare" | "complete", max: number): Promise<boolean> {
  const key = "budget:" + action;
  return storage.transaction(async (txn) => {
    const now = Date.now();
    const current = await txn.get<AttemptBudget>(key);
    if (current && current.reset_at > now && current.count >= max) return false;
    const next = current && current.reset_at > now
      ? { reset_at: current.reset_at, count: current.count + 1 }
      : { reset_at: now + BUDGET_WINDOW_MS, count: 1 };
    await txn.put(key, next);
    return true;
  });
}

function asBytes(base64: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error("Invalid key encoding.");
  }
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== base64) throw new Error("Non-canonical key encoding.");
  return bytes;
}

export async function verifyRegistration(payload: unknown): Promise<{ record: PendingDevice; verifier: string } | null> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Partial<Registration>;
  if (typeof p.name !== "string" || p.name.length < 1 || p.name.length > 64 ||
      /[\x00-\x1f]/.test(p.name) || typeof p.code_verifier !== "string" ||
      !/^[a-f0-9]{64}$/.test(p.code_verifier) || typeof p.public_key !== "string" ||
      p.public_key.length > 96 || typeof p.proof !== "string" || p.proof.length > 128 ||
      typeof p.issued_at !== "number" || !Number.isSafeInteger(p.issued_at) ||
      Date.now() - p.issued_at > 60_000 || p.issued_at - Date.now() > 30_000) return null;
  try {
    const keyBytes = asBytes(p.public_key);
    if (keyBytes.byteLength !== 44) return null; // DER SPKI wrapper of Ed25519 key.
    const signature = asBytes(p.proof);
    if (signature.length !== 64) return null;
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(keyBytes).buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
    const challenge = te.encode(PAIRING_DOMAIN + p.code_verifier + ":" + p.public_key + ":" + p.name + ":" + p.issued_at);
    const ok = await crypto.subtle.verify("Ed25519", key, Uint8Array.from(signature).buffer as ArrayBuffer, Uint8Array.from(challenge).buffer as ArrayBuffer);
    if (!ok) return null;
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(keyBytes).buffer as ArrayBuffer);
    const fingerprint = [...new Uint8Array(digest)].slice(0, 12).map((c) => c.toString(16).padStart(2, "0")).join("");
    const time = Date.now();
    return {
      verifier: p.code_verifier,
      record: { name: p.name, public_key: p.public_key, pairing_id: crypto.randomUUID(), fingerprint, expires_at: time + TTL_MS, created_at: time },
    };
  } catch {
    return null;
  }
}

export async function registerPending(storage: PendingStorage, payload: unknown): Promise<{ status: number; body: object }> {
  // Charge even invalid requests before performing public-key signature work.
  if (!await consumeBudget(storage, "register", MAX_REGISTRATIONS_PER_MINUTE)) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  const verified = await verifyRegistration(payload);
  if (!verified) return { status: 400, body: { error: "invalid_request" } };
  return storage.transaction(async (txn) => {
    const existing = await txn.list<PendingDevice>({ prefix: "pending:", limit: MAX_PENDING + 1 });
    let active = 0;
    for (const [key, record] of existing) {
      if (record.expires_at <= Date.now()) await txn.delete(key);
      else active++;
    }
    if (active >= MAX_PENDING) return { status: 429, body: { error: "pending_capacity" } };
    const key = "pending:" + verified.verifier;
    // Expired entries were deleted above; permit reuse of their verifier.
    // Reject only an active record so stale pending state cannot block retries.
    if (existing.get(key)?.expires_at && existing.get(key)!.expires_at > Date.now()) {
      return { status: 409, body: { error: "already_pending" } };
    }
    await txn.put(key, verified.record);
    return { status: 202, body: { status: "pending", expires_at: verified.record.expires_at } };
  });
}

export async function lookupPending(storage: PendingStorage, verifier: string): Promise<{ status: number; body: object }> {
  if (!/^[a-f0-9]{64}$/.test(verifier)) return { status: 400, body: { error: "invalid_code" } };
  if (!await consumeBudget(storage, "lookup", MAX_LOOKUPS_PER_MINUTE)) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  const record = await storage.get<PendingDevice>("pending:" + verifier);
  if (!record || record.expires_at <= Date.now()) return { status: 404, body: { error: "not_found" } };
  // Public key only appears as an immutable fingerprint to the authenticated MCP owner.
  return { status: 200, body: { pairing_id: record.pairing_id, name: record.name, fingerprint: record.fingerprint, expires_at: record.expires_at } };
}

/**
 * Prepare a device-specific challenge for a *separately confirmed local terminal*.
 * The MCP caller may ask for a challenge but can never authorize a device itself.
 * A new preparation invalidates any prior challenge on the same pending entry.
 */
export async function prepareLocalConfirmation(
  storage: PendingStorage, pairingId: unknown, fingerprint: unknown,
): Promise<{ status: number; body: object }> {
  if (typeof pairingId !== "string" || !/^[a-f0-9-]{36}$/.test(pairingId) ||
      typeof fingerprint !== "string" || !/^[a-f0-9]{24}$/.test(fingerprint)) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (!await consumeBudget(storage, "prepare", MAX_PREPARES_PER_MINUTE)) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  return storage.transaction(async (txn) => {
    const pending = await txn.list<PendingDevice>({ prefix: "pending:", limit: MAX_PENDING + 1 });
    const match = [...pending].find(([, row]) =>
      row.pairing_id === pairingId && row.fingerprint === fingerprint && row.expires_at > Date.now());
    if (!match) return { status: 404, body: { error: "not_found" } };
    const [key, row] = match;
    // 12 Base32 symbols, 60 bits. This code is entered on the new host only.
    const random = new Uint8Array(12);
    crypto.getRandomValues(random);
    const challenge = [...random].map((b) => ALPHABET[b & 31]).join("");
    const hash = await crypto.subtle.digest("SHA-256", te.encode(CONFIRM_DOMAIN + challenge));
    const confirmationHash = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = Math.min(row.expires_at, Date.now() + CHALLENGE_TTL_MS);
    await txn.put(key, {
      ...row, confirmation_hash: confirmationHash, confirmation_expires_at: expiresAt,
    });
    return { status: 200, body: {
      pairing_id: row.pairing_id,
      fingerprint: row.fingerprint,
      challenge,
      expires_at: expiresAt,
      instruction: "Enter this challenge manually in the NEW Agent's local terminal. No MCP tool can approve it.",
    } };
  });
}

/** The Agent must sign the already owner-reviewed challenge with its own private key. */
export async function completeLocalConfirmation(storage: PendingStorage, data: unknown):
  Promise<{ status: number; body: object }> {
  if (!await consumeBudget(storage, "complete", MAX_COMPLETIONS_PER_MINUTE)) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const p = data as Record<string, unknown>;
  if (typeof p.verifier !== "string" || !/^[a-f0-9]{64}$/.test(p.verifier) ||
      typeof p.challenge !== "string" || !/^[A-Z2-7]{12}$/.test(p.challenge) ||
      typeof p.proof !== "string" || p.proof.length > 128) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const key = "pending:" + p.verifier;
  const pending = await storage.get<PendingDevice>(key);
  if (!pending || pending.expires_at <= Date.now() || !pending.confirmation_hash ||
      !pending.confirmation_expires_at || pending.confirmation_expires_at <= Date.now()) {
    return { status: 404, body: { error: "not_found" } };
  }
  const actual = await crypto.subtle.digest("SHA-256", te.encode(CONFIRM_DOMAIN + p.challenge));
  const actualHex = [...new Uint8Array(actual)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (actualHex !== pending.confirmation_hash) return { status: 403, body: { error: "denied" } };

  let signatureValid = false;
  try {
    const pub = await crypto.subtle.importKey(
      "spki", Uint8Array.from(asBytes(pending.public_key)).buffer as ArrayBuffer,
      { name: "Ed25519" }, false, ["verify"],
    );
    const transcript = te.encode(CONFIRM_DOMAIN + p.verifier + ":" + p.challenge + ":" + pending.public_key);
    signatureValid = await crypto.subtle.verify(
      "Ed25519", pub, Uint8Array.from(asBytes(p.proof)).buffer as ArrayBuffer,
      Uint8Array.from(transcript).buffer as ArrayBuffer,
    );
  } catch { /* malformed key/signature */ }
  if (!signatureValid) return { status: 403, body: { error: "denied" } };
  // Re-check inside a DO transaction so two valid parallel proofs never activate twice.
  return storage.transaction(async (txn) => {
    const again = await txn.get<PendingDevice>(key);
    if (!again || again.pairing_id !== pending.pairing_id ||
        again.confirmation_hash !== pending.confirmation_hash ||
        !again.confirmation_expires_at || again.confirmation_expires_at <= Date.now() ||
        again.expires_at <= Date.now()) {
      return { status: 409, body: { error: "already_consumed" } };
    }
    // A revoked public key is a permanent tombstone: reinstalling with the
    // stolen/old private key must never create a fresh authorized device ID.
    const known = await txn.list<V2Device>({ prefix: "device:", limit: 65 });
    if (known.size > 64) return { status: 503, body: { error: "capacity" } };
    if ([...known.values()].some(device => device.public_key === again.public_key)) {
      return { status: 409, body: { error: "identity_already_used" } };
    }
    const deviceId = crypto.randomUUID();
    await txn.put("device:" + deviceId, {
      device_id: deviceId, name: again.name, public_key: again.public_key,
      fingerprint: again.fingerprint, approved_at: Date.now(), revoked: false,
    } satisfies ApprovedDevice);
    await txn.delete(key);
    return { status: 200, body: { status: "paired", device_id: deviceId } };
  });
}

async function limitedJson(request: Request, maxBytes = MAX_BOOTSTRAP_BODY): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("oversize");
  if (!request.body) throw new Error("missing");
  const reader = request.body.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("oversize");
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(joined)) as unknown;
}

export class V2OwnerCoordinator {
  private readonly state: DurableObjectState;
  // In-flight reads only: bounded by request timeout; never durable/queued.
  private readonly pendingReads = new Map<string, {
    socket: WebSocket; deviceId: string; epoch: string;
    resolve: (response: Response) => void;
    kind: "read" | "operation"; operationId?: string;
  }>();

  private async readFile(request: Request, isOperation = false): Promise<Response> {
    let body: unknown;
    try { body = await limitedJson(request, 65_536); }
    catch { return Response.json({ error: "bad_request" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const arg = body as Record<string, unknown>;
    const deviceId = arg.device_id;
    const parsers: Record<string, (args: unknown) => unknown> = {
      read_file: parseLocalRead, read_multiple_files: parseReadMultiple,
      list_directory: parseListDirectory, get_file_info: parseFileInfo,
      start_search: parseSearchStart, get_more_search_results: parseSearchSessionId,
      stop_search: parseSearchSessionId,
    };
    const operationId = isOperation ? arg.operation_id : undefined;
    const mutationParsers: Record<string, (input: unknown) => unknown> = {
      write_file: parseLocalWriteFile, create_directory: parseLocalCreateDirectory,
      edit_block: parseLocalEditBlock, move_file: parseLocalMoveFile,
      delete_file: parseLocalDeleteFile,
    };
    const validOperation = typeof operationId === "string" &&
      Boolean(parseOperationId({ operation_id: operationId })) &&
      ((arg.tool === "get_operation_status" &&
        Boolean(parseOperationId(arg.arguments)) &&
        (arg.arguments as { operation_id: string }).operation_id === operationId) ||
      (typeof arg.tool === "string" && Object.hasOwn(mutationParsers, arg.tool) &&
        Boolean(mutationParsers[arg.tool]?.({ ...(arg.arguments as object), operation_id: operationId }))));
    if ((isOperation ? Object.keys(arg).length !== 4 : Object.keys(arg).length !== 3) ||
        typeof arg.tool !== "string" ||
        (isOperation ? !validOperation : (!Object.hasOwn(parsers, arg.tool) || !parsers[arg.tool]?.(arg.arguments))) ||
        typeof deviceId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(deviceId)) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    if (this.pendingReads.size >= 4) return Response.json({ error: "busy" }, { status: 503 });
    const [device, epoch] = await Promise.all([
      this.state.storage.get<V2Device>("device:" + deviceId),
      this.state.storage.get<string>("session:epoch:" + deviceId),
    ]);
    if (!device || device.revoked !== false || !epoch) {
      return Response.json({ error: "offline" }, { status: 503 });
    }
    let active: WebSocket | undefined;
    for (const socket of this.state.getWebSockets("device:" + deviceId)) {
      try {
        const a = socket.deserializeAttachment() as { device_id?: unknown; epoch?: unknown } | null;
        if (a?.device_id === deviceId && a.epoch === epoch && socket.readyState === 1) {
          active = socket; break;
        }
      } catch { /* Ignore malformed detached sessions. */ }
    }
    if (!active) return Response.json({ error: "offline" }, { status: 503 });
    // Concurrent requests may all have passed the earlier cap before awaiting
    // SQLite. Enforce the limit again immediately before reserving a slot.
    if (this.pendingReads.size >= 4) return Response.json({ error: "busy" }, { status: 503 });
    const requestId = crypto.randomUUID();
    const selected = active;
    return new Promise<Response>(resolve => {
      const timer = setTimeout(() => {
        this.pendingReads.delete(requestId);
        resolve(Response.json(isOperation
          ? { operation_id: operationId, status: "timeout_unknown" }
          : { error: "timeout" }, { status: 503 }));
      }, 5_000);
      this.pendingReads.set(requestId, {
        socket: selected, deviceId, epoch,
        kind: isOperation ? "operation" : "read",
        ...(isOperation ? { operationId: operationId as string } : {}),
        resolve: response => {
          clearTimeout(timer);
          this.pendingReads.delete(requestId);
          resolve(response);
        },
      });
      try {
        selected.send(JSON.stringify({
          kind: isOperation ? "operation" : "read", request_id: requestId,
          tool: arg.tool, arguments: arg.arguments,
          ...(isOperation ? { operation_id: operationId } : {}),
        }));
      } catch {
        this.pendingReads.get(requestId)?.resolve(Response.json({ error: "offline" }, { status: 503 }));
      }
    });
  }

  private async handleReadResult(socket: WebSocket, message: string): Promise<boolean> {
    if (message.length > 70_000 || !message.startsWith("{")) return false;
    let reply: Record<string, unknown>;
    try { reply = JSON.parse(message) as Record<string, unknown>; }
    catch { return false; }
    if (!["read_result", "operation_result"].includes(String(reply.kind)) ||
        typeof reply.request_id !== "string") return false;
    const pending = this.pendingReads.get(reply.request_id);
    // A timed-out response has no active waiter. Never queue it for a reconnect.
    if (!pending) return true;
    if (pending.socket !== socket ||
        reply.kind !== (pending.kind === "operation" ? "operation_result" : "read_result")) {
      try { socket.close(1008, "wrong device response"); } catch { /* disconnected */ }
      return true;
    }
    try {
      const [device, epoch] = await Promise.all([
        this.state.storage.get<V2Device>("device:" + pending.deviceId),
        this.state.storage.get<string>("session:epoch:" + pending.deviceId),
      ]);
      if (!device || device.revoked !== false || epoch !== pending.epoch) {
        pending.resolve(Response.json({ error: "unauthorized" }, { status: 503 }));
      } else if (pending.kind === "operation") {
        const result = reply.result;
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          pending.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
        } else {
          const answer = result as Record<string, unknown>;
          const status = answer.status;
          if (answer.operation_id !== pending.operationId || typeof status !== "string" ||
              !["completed", "failed", "admitted", "running", "unknown", "not_found", "conflict", "bad_request", "unavailable"].includes(status)) {
            pending.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
          } else {
            // Never echo private file contents, raw exceptions, or arbitrary
            // Agent-owned properties over the public MCP endpoint.
            const receipt = answer.receipt;
            const publicReceipt: Record<string, unknown> = {};
            if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
              const r = receipt as Record<string, unknown>;
              for (const key of ["operation_id", "tool_name", "state", "created_at",
                "updated_at", "safe_result_summary", "session_id"]) {
                if (typeof r[key] === "string") publicReceipt[key] = r[key];
              }
            }
            pending.resolve(Response.json({
              operation_id: pending.operationId, status,
              ...(Object.keys(publicReceipt).length ? { receipt: publicReceipt } : {}),
            }));
          }
        }
      } else if (reply.status === "completed" && typeof reply.text === "string" &&
          reply.text.length <= 65_536) {
        pending.resolve(Response.json({ status: "completed", text: reply.text }));
      } else {
        pending.resolve(Response.json({ error: "read_failed" }, { status: 503 }));
      }
    } catch { pending.resolve(Response.json({ error: "unavailable" }, { status: 503 })); }
    return true;
  }
  /** Commit the tombstone before touching live sockets or in-flight requests. */
  private async revokeDevice(request: Request): Promise<Response> {
    const body = await limitedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const args = body as Record<string, unknown>;
    if (Object.keys(args).length !== 1 || typeof args.device_id !== "string" ||
        !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args.device_id)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const id = args.device_id;
    const outcome = await this.state.storage.transaction(async txn => {
      const record = await txn.get<V2Device>("device:" + id);
      if (!record) return "not_found" as const;
      if (record.revoked === true) return "already_revoked" as const;
      await txn.put("device:" + id, { ...record, revoked: true });
      await txn.delete("session:nonce:" + id);
      await txn.delete("session:epoch:" + id);
      return "revoked" as const;
    });
    if (outcome === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
    if (outcome === "already_revoked") {
      return Response.json({ device_id: id, status: outcome, process_cleanup: "unconfirmed" });
    }
    // Cancel ongoing transport reads AFTER the durable denial is committed.
    // T07's authenticated owned-session cleanup is not implemented yet:
    // explicitly do not imply Agent processes were stopped.
    for (const pending of this.pendingReads.values()) {
      if (pending.deviceId === id) {
        pending.resolve(Response.json({ error: "revoked" }, { status: 503 }));
      }
    }
    let cleanup: "offline" | "not_attempted" | "unconfirmed" = "offline";
    try {
      for (const socket of this.state.getWebSockets("device:" + id)) {
        if (socket.readyState === WebSocket.OPEN) cleanup = "not_attempted";
        try { socket.close(1008, "revoked"); }
        catch { cleanup = "unconfirmed"; }
      }
    } catch { cleanup = "unconfirmed"; }
    return Response.json({ device_id: id, status: "revoked", process_cleanup: cleanup }, {
      headers: { "cache-control": "no-store" },
    });
  }

  /** Hibernation callbacks run after close/error without relying on JS Map state. */
  private rejectSocketReads(socket: WebSocket): void {
    // Iterating in-flight callbacks is bounded to four; no storage I/O or
    // persistent offline flag that could erase a newer signed epoch.
    for (const pending of this.pendingReads.values()) {
      if (pending.socket === socket) {
        pending.resolve(Response.json({ error: "offline" }, { status: 503 }));
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    this.rejectSocketReads(socket);
    // With newer compatibility dates Cloudflare already replies to close.
    // For older dates this finishes the close handshake without a 1006.
    try { socket.close(code, reason); } catch { /* Already disconnected. */ }
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    this.rejectSocketReads(socket);
    try { socket.close(1011, "connection unavailable"); } catch { /* Already disconnected. */ }
  }

  constructor(state: DurableObjectState) {
    this.state = state;
    // Cloudflare replies to these liveness frames without waking a hibernating
    // DO. The response is NOT proof of current authorization; every future
    // application command must independently check the durable device/epoch.
    if (typeof state.setWebSocketAutoResponse === "function") {
      state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("rc-v2:ping", "rc-v2:pong"),
      );
    }
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && await this.handleReadResult(socket, message)) return;
    await handleIdleSocketMessage(this.state, socket, message);
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/ws/")) {
      return acceptAuthenticatedSocket(this.state.storage, this.state, request);
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === "/revoke") {
      try { return await this.revokeDevice(request); }
      catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
    }
    if (path === "/operation") {
      try { return await this.readFile(request, true); }
      catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
    }
    if (path === "/read") {
      try { return await this.readFile(request); }
      catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
    }
    if (path === "/devices") {
      try {
        if (request.headers.get("content-type") !== "application/json" ||
            await request.text() !== "{}") return new Response(null, { status: 400 });
        const output = await listApprovedDevices(this.state);
        return Response.json(output.body, { status: output.status, headers: { "cache-control": "no-store" } });
      } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
    }
    if (!["/register", "/lookup", "/prepare", "/complete", "/session/challenge", "/session/recover"].includes(path)) return new Response(null, { status: 404 });
    let payload: unknown;
    try { payload = await limitedJson(request); } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    try {
      let output: { status: number; body: object };
      if (path === "/session/challenge") output = await issueSessionChallenge(this.state.storage, payload);
      else if (path === "/session/recover") output = await authorizeSession(this.state.storage, payload);
      else if (path === "/register") output = await registerPending(this.state.storage, payload);
      else if (path === "/lookup") output = await lookupPending(
        this.state.storage, (payload as { verifier?: unknown })?.verifier as string,
      );
      else if (path === "/prepare") {
        const pending = payload as { pairing_id?: unknown; expected_fingerprint?: unknown };
        output = await prepareLocalConfirmation(this.state.storage, pending?.pairing_id, pending?.expected_fingerprint);
      } else output = await completeLocalConfirmation(this.state.storage, payload);
      return Response.json(output.body, { status: output.status, headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
  }
}
