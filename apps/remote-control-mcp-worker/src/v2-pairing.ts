/** v2 pending enrollment only. No connection or remote-command permission exists here. */
const PAIRING_DOMAIN = "remote-control:v2:pending:";
const MAX_BOOTSTRAP_BODY = 4096;
const MAX_PENDING = 24;
const TTL_MS = 600_000;
const BUDGET_WINDOW_MS = 60_000;
const MAX_REGISTRATIONS_PER_MINUTE = 12;
const MAX_LOOKUPS_PER_MINUTE = 30;
const MAX_APPROVALS_PER_MINUTE = 8;
const te = new TextEncoder();
import { issueSessionChallenge, authorizeSession, acceptAuthenticatedSocket, handleIdleSocketMessage, handleDeviceInfoMessage, listApprovedDevices, deviceIsAuthorized, listLiveGrants, TEMPORARY_GRANT_MS, type V2Device } from "./v2-session.ts";
import { parseBrowserDoArguments } from "./browser-tools.ts";
import { prepareOwnerUpgrade, presentOwnerUpgrade, confirmOwnerUpgrade, cancelPreparedOwnerUpgrade, claimOwnerUpgradeDispatch, markUpgradeDispatchUncertain, markStaleOwnerUpgradeAttention, markOwnerUpgradeCompleted, markOwnerUpgradeRolledBack, readOwnerUpgrade, type ReviewedUpgradePin } from "./upgrade-approval.ts";
import {inspectReviewedLinuxUpgradeAsset,type ReviewedLinuxUpgradePin} from "./linux-upgrade-pin.ts";
import { parseLocalRead, parseReadMultiple, parseListDirectory, parseFileInfo, parseSearchStart, parseSearchSessionId, parseLocalWriteFile, parseLocalCreateDirectory, parseLocalEditBlock, parseLocalMoveFile, parseLocalDeleteFile, parseStartProcess, parseLocalProcessOutput, parseListSessions, parseLocalProcessInteraction, parseLocalProcessTermination, parseOperationId } from "./local-read.ts";

export interface PendingDevice {
  name: string;
  public_key: string;
  grant_type?: "temporary";
  pairing_id: string;
  fingerprint: string;
  expires_at: number;
  created_at: number;
  confirmation_hash?: string;
  confirmation_expires_at?: number;
  pairing_protocol?: "single-code-v1"; // absent on old pending rows
}

export interface ApprovedDevice {
  device_id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  approved_at: number;
  grant_type?: "permanent" | "temporary";
  expires_at?: number;
  revoked: false;
}

type PendingStorage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete" | "transaction">;
type Registration = { name: string; public_key: string; code_verifier: string; proof: string; issued_at: number; grant_type?: "temporary"; pairing_protocol?: "single-code-v1" };
type AttemptBudget = { reset_at: number; count: number };

/**
 * Limits preapproval abuse using one tiny durable counter per operation, without
 * adding a KV/R2 service, an always-on alarm, or IP-based device tracking.
 * A sustained hostile flood can still deny service; this gate bounds DO work.
 */
async function consumeBudget(storage: PendingStorage, action: "register" | "lookup" | "approve", max: number): Promise<boolean> {
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
      (p.grant_type !== undefined && p.grant_type !== "temporary") ||
      p.pairing_protocol !== "single-code-v1" ||
      typeof p.issued_at !== "number" || !Number.isSafeInteger(p.issued_at) ||
      Date.now() - p.issued_at > 60_000 || p.issued_at - Date.now() > 30_000) return null;
  try {
    const keyBytes = asBytes(p.public_key);
    if (keyBytes.byteLength !== 44) return null; // DER SPKI wrapper of Ed25519 key.
    const signature = asBytes(p.proof);
    if (signature.length !== 64) return null;
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(keyBytes).buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
    const challenge = te.encode(PAIRING_DOMAIN + p.code_verifier + ":" + p.public_key + ":" + p.name + ":" + p.issued_at + (p.grant_type === "temporary" ? ":temporary" : "") + ":single-code-v1");
    const ok = await crypto.subtle.verify("Ed25519", key, Uint8Array.from(signature).buffer as ArrayBuffer, Uint8Array.from(challenge).buffer as ArrayBuffer);
    if (!ok) return null;
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(keyBytes).buffer as ArrayBuffer);
    const fingerprint = [...new Uint8Array(digest)].slice(0, 12).map((c) => c.toString(16).padStart(2, "0")).join("");
    const time = Date.now();
    return {
      verifier: p.code_verifier,
      record: { name: p.name, public_key: p.public_key, pairing_id: crypto.randomUUID(), fingerprint, expires_at: time + TTL_MS, created_at: time,
        ...(p.grant_type === "temporary" ? {grant_type: "temporary" as const} : {}),
        pairing_protocol: "single-code-v1" as const },
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
    // The bootstrap request includes a signed proof of this public key, but
    // never grants permissions. A revoked or previously approved key MUST
    // NOT be allowed to enroll as a new identity, even after reinstall.
    const grants = await listLiveGrants(txn);
    if (!grants.complete || grants.active.size >= 64) return { status: 503, body: { error: "capacity" } };
    if ([...grants.active.values()].some(d => d.public_key === verified.record.public_key)) {
      return { status: 409, body: { error: "identity_already_used" } };
    }
    const existing = await txn.list<PendingDevice>({ prefix: "pending:", limit: MAX_PENDING + 1 });
    const key = "pending:" + verified.verifier;
    // A repeated identical active request is rejected, as before.
    if (existing.get(key)?.expires_at && existing.get(key)!.expires_at > Date.now()) {
      return { status: 409, body: { error: "already_pending" } };
    }
    let active = 0;
    for (const [pendingKey, record] of existing) {
      if (record.expires_at <= Date.now() ||
          record.public_key === verified.record.public_key) {
        // Invalidate any prior code/challenge for this same unapproved key
        // atomically; an interrupted install obtains a fresh pairing code.
        await txn.delete(pendingKey);
      } else active++;
    }
    if (active >= MAX_PENDING) return { status: 429, body: { error: "pending_capacity" } };
    await txn.put(key, verified.record);
    return { status: 202, body: { status: "pending", expires_at: verified.record.expires_at } };
  });
}

/**
 * Read-only revocation proof for explicit --re-pair.
 * No approval, device mutation or key reactivation occurs here.
 */
export async function checkRevokedIdentity(
  storage: PendingStorage, payload: unknown,
): Promise<{ status: number; body: object }> {
  if (!await consumeBudget(storage, "lookup", MAX_LOOKUPS_PER_MINUTE)) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const p = payload as { device_id?: unknown; public_key?: unknown; issued_at?: unknown; proof?: unknown };
  if (typeof p.device_id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.device_id) ||
      typeof p.public_key !== "string" || p.public_key.length > 96 ||
      typeof p.proof !== "string" || p.proof.length > 128 ||
      typeof p.issued_at !== "number" || !Number.isSafeInteger(p.issued_at) ||
      Date.now() - p.issued_at > 60_000 || p.issued_at - Date.now() > 30_000) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  try {
    const signature = asBytes(p.proof);
    const keyBytes = asBytes(p.public_key);
    if (signature.length !== 64 || keyBytes.length !== 44) return { status: 400, body: {error: "invalid_request"} };
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(keyBytes).buffer as ArrayBuffer,
      { name: "Ed25519" }, false, ["verify"]);
    const transcript = te.encode("remote-control:v2:re-pair-revoked:" +
      p.device_id + ":" + p.public_key + ":" + p.issued_at);
    if (!await crypto.subtle.verify("Ed25519", key,
      Uint8Array.from(signature).buffer as ArrayBuffer,
      Uint8Array.from(transcript).buffer as ArrayBuffer)) {
      return { status: 403, body: { error: "unauthorized" } };
    }
    const device = await storage.get<V2Device>("device:" + p.device_id);
    // Proof confirms possession of the SUPPLIED key, not historical ownership
    // of a deleted device ID. This negative status never grants authority;
    // fresh owner-reviewed pairing is always required.
    if (deviceIsAuthorized(device)) {
      return { status: device.public_key === p.public_key ? 409 : 403,
        body: { error: device.public_key === p.public_key ? "identity_still_approved" : "unauthorized" } };
    }
    // Tolerate and lazily remove legacy preview tombstones after the new
    // negative-status contract is active. Never retain a new tombstone.
    if (device && !deviceIsAuthorized(device)) {
      await storage.delete("device:" + p.device_id);
      await storage.delete("session:nonce:" + p.device_id);
      await storage.delete("session:epoch:" + p.device_id);
    }
    return { status: 200, body: { status: "not_approved", device_id: p.device_id } };
  } catch {
    return { status: 400, body: { error: "invalid_request" } };
  }
}

export async function lookupPending(storage: PendingStorage, verifier: string): Promise<{ status: number; body: object }> {
  if (!/^[a-f0-9]{64}$/.test(verifier)) return { status: 400, body: { error: "invalid_code" } };
  if (!await consumeBudget(storage, "lookup", MAX_LOOKUPS_PER_MINUTE)) {
    return { status: 429, body: { error: "rate_limited" } };
  }
  const record = await storage.get<PendingDevice>("pending:" + verifier);
  if (!record || record.expires_at <= Date.now()) return { status: 404, body: { error: "not_found" } };
  // Public key only appears as an immutable fingerprint to the authenticated MCP owner.
  return { status: 200, body: { pairing_id: record.pairing_id, name: record.name, fingerprint: record.fingerprint, expires_at: record.expires_at,
    grant_type: record.grant_type ?? "permanent" } };
}

/**
 * One-code owner approval, called ONLY through the authenticated MCP tool.
 * Approval never depends on an Agent-supplied public Bearer token or a second
 * human-entered challenge. The waiting Agent uses existing signed session
 * recovery (fresh nonce, same Ed25519 public key) to claim its device ID.
 * 
 * Legacy pending entries that still contain a confirmation_hash must fail
 * closed rather than silently convert into owner-only approvals.
 */
export async function approvePendingKey(
  storage: PendingStorage, pairingId: unknown, fingerprint: unknown, expectedGrantType: unknown,
): Promise<{ status: number; body: object }> {
  if (typeof pairingId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pairingId) ||
      typeof fingerprint !== "string" || !/^[a-f0-9]{24}$/.test(fingerprint) ||
      (expectedGrantType !== "permanent" && expectedGrantType !== "temporary")) {
    return {status: 400, body: {error: "invalid_request"}};
  }
  // Use the existing enrollment budget; no second rate-counter namespace.
  if (!await consumeBudget(storage, "approve", MAX_APPROVALS_PER_MINUTE)) {
    return {status: 429, body: {error: "rate_limited"}};
  }
  return storage.transaction(async (txn) => {
    const pending = await txn.list<PendingDevice>({prefix: "pending:", limit: MAX_PENDING + 1});
    if (pending.size > MAX_PENDING) return {status: 503, body: {error: "capacity"}};
    const match = [...pending].find(([,row]) =>
      row.pairing_id === pairingId && row.fingerprint === fingerprint && row.expires_at > Date.now());
    if (!match) return {status: 404, body: {error: "not_found"}};
    const [key, row] = match;
    const mode = row.grant_type ?? "permanent";
    if (expectedGrantType !== mode) return {status: 409, body: {error: "grant_type_mismatch"}};
    // Do not repurpose a previously prepared two-code request into a
    // one-code approval while its old terminal challenge remains in flight.
    if (row.pairing_protocol !== "single-code-v1" || row.confirmation_hash) {
      return {status: 409, body: {error: "legacy_pairing_in_progress"}};
    }
    const grants = await listLiveGrants(txn);
    if (!grants.complete || grants.active.size >= 64) return {status: 503, body: {error: "capacity"}};
    if ([...grants.active.values()].some(device => device.public_key === row.public_key)) {
      return {status: 409, body: {error: "identity_already_used"}};
    }
    const deviceId = crypto.randomUUID();
    const approvedAt = Date.now();
    await txn.put("device:" + deviceId, {
      device_id: deviceId, name: row.name, public_key: row.public_key,
      fingerprint: row.fingerprint, approved_at: approvedAt, revoked: false,
      grant_type: mode,
      ...(mode === "temporary" ? {expires_at: approvedAt + TEMPORARY_GRANT_MS} : {}),
    } satisfies ApprovedDevice);
    await txn.delete(key);
    // Do not return the pairing code, verifier or public key to MCP.
    return {status: 200, body: {status: "approved", device_id: deviceId, grant_type: mode}};
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
  private readonly pendingCleanup = new Map<string, {
    socket: WebSocket;
    resolve: (status: "confirmed" | "uncertain") => void;
  }>();
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
      list_sessions: parseListSessions, read_process_output: parseLocalProcessOutput,
      browser_status: args => parseBrowserDoArguments("browser_status", args),
      browser_snapshot: args => parseBrowserDoArguments("browser_snapshot", args),
      browser_tabs: args => parseBrowserDoArguments("browser_tabs", args) && (args as {action:string}).action === "list",
    };
    const operationId = isOperation ? arg.operation_id : undefined;
    const mutationParsers: Record<string, (input: unknown) => unknown> = {
      // Accepted on signed WSS only after the owner DO consumes its grant.
      // Public MCP /operation cannot nominate this private Agent tool.
      upgrade_agent: args => {
        if (!args || typeof args !== "object" || Array.isArray(args)) return null;
        const p = args as Record<string,unknown>;
        const t = p.target;
        if (Object.keys(p).sort().join("|") !==
            "approved_at|current_version|device_id|expires_at|fingerprint|operation_id|target" ||
            typeof p.operation_id !== "string" || typeof p.device_id !== "string" ||
            typeof p.fingerprint !== "string" || !/^[a-f0-9]{24}$/.test(p.fingerprint) ||
            typeof p.current_version !== "string" || p.current_version.length > 64 ||
            typeof p.approved_at !== "number" || !Number.isSafeInteger(p.approved_at) ||
            typeof p.expires_at !== "number" || !Number.isSafeInteger(p.expires_at) ||
            !t || typeof t !== "object" || Array.isArray(t)) return null;
        const pin = t as Record<string, unknown>;
        const fields=Object.keys(pin).sort().join("|");
        const windows=fields==="commit|tag|windows_asset_sha256" &&
          typeof pin.windows_asset_sha256==="string" &&
          /^[a-f0-9]{64}$/.test(pin.windows_asset_sha256);
        const linux=fields==="commit|linux_arch|linux_asset_sha256|tag" &&
          (pin.linux_arch==="x64"||pin.linux_arch==="arm64") &&
          typeof pin.linux_asset_sha256==="string" &&
          /^[a-f0-9]{64}$/.test(pin.linux_asset_sha256) &&
          typeof pin.tag==="string" &&
          /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pin.tag);
        return (windows||linux) && typeof pin.tag==="string" &&
          typeof pin.commit==="string" && /^[a-f0-9]{40}$/.test(pin.commit)
          ? p : null;
      },
      write_file: parseLocalWriteFile, create_directory: parseLocalCreateDirectory,
      edit_block: parseLocalEditBlock, move_file: parseLocalMoveFile,
      delete_file: parseLocalDeleteFile, start_process: parseStartProcess,
      interact_with_process: parseLocalProcessInteraction, force_terminate: parseLocalProcessTermination,
      browser_start: args => parseBrowserDoArguments("browser_start", args),
      browser_navigate: args => parseBrowserDoArguments("browser_navigate", args),
      browser_close: args => parseBrowserDoArguments("browser_close", args),
      browser_tabs: args => parseBrowserDoArguments("browser_tabs", args) && (args as {action:string}).action !== "list",
      browser_click: args => parseBrowserDoArguments("browser_click", args),
      browser_fill: args => parseBrowserDoArguments("browser_fill", args),
      browser_press_key: args => parseBrowserDoArguments("browser_press_key", args),
      browser_select_option: args => parseBrowserDoArguments("browser_select_option", args),
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
    if (!deviceIsAuthorized(device) || !epoch) {
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
      // A reply to work admitted BEFORE expiry may still settle its existing
      // receipt; expiry only forbids NEW dispatch. Revocation still rejects.
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
            const sessionId = answer.session_id;
            pending.resolve(Response.json({
              operation_id: pending.operationId, status,
              ...(typeof sessionId === "string" &&
                /^[a-f0-9]{8}-[a-f0-9]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/.test(sessionId)
                ? { session_id: sessionId } : {}),
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
  /** Cleanup ACKs are accepted only from the exact pre-revocation socket. */
  private handleCleanupAck(socket: WebSocket, message: string): boolean {
    if (message.length > 256 || !message.startsWith("{")) return false;
    let response: Record<string, unknown>;
    try { response = JSON.parse(message) as Record<string, unknown>; }
    catch { return false; }
    if (response.kind !== "revoke_cleanup_result") return false;
    if (typeof response.request_id !== "string") return true;
    const pending = this.pendingCleanup.get(response.request_id);
    if (!pending) return true; // timed-out / already acknowledged; never queue
    if (pending.socket !== socket) {
      try { socket.close(1008, "wrong device cleanup ack"); } catch { /* closed */ }
      return true;
    }
    pending.resolve(response.status === "confirmed" ? "confirmed" : "uncertain");
    return true;
  }


  /** Owner-only rename: update a display label without touching keys, grants or live sockets. */
  private async renameDevice(request: Request): Promise<Response> {
    const body = await limitedJson(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const args = body as Record<string, unknown>;
    if (Object.keys(args).length !== 2 ||
        typeof args.device_id !== "string" ||
        !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args.device_id) ||
        typeof args.name !== "string" || args.name.length < 1 || args.name.length > 64 ||
        args.name.trim() !== args.name || /[\x00-\x1f]/.test(args.name)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const deviceId = args.device_id, name = args.name;
    const result = await this.state.storage.transaction(async txn => {
      const device = await txn.get<V2Device>("device:" + deviceId);
      if (!deviceIsAuthorized(device)) return null;
      await txn.put("device:" + deviceId, { ...device, name });
      return { device_id: deviceId, name };
    });
    return result
      ? Response.json(result, { headers: { "cache-control": "no-store" } })
      : Response.json({ error: "not_found" }, { status: 404 });
  }

  /** Delete durable grant/epoch before touching any live sockets or in-flight requests. */
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
      if (!record) return { status: "not_found" as const };
      if (record.revoked === true) {
        await txn.delete("device:" + id); // Legacy Preview tombstone only.
        return { status: "not_found" as const };
      }
      const previousEpoch = await txn.get<string>("session:epoch:" + id);
      await txn.delete("device:" + id);
      await txn.delete("session:nonce:" + id);
      await txn.delete("session:epoch:" + id);
      return { status: "revoked" as const, previousEpoch };
    });
    if (outcome.status === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
    // Cancel all ordinary requests AFTER authorization deletion commits; cleanup is a
    // one-shot internal frame to the pre-revocation authenticated socket only.
    for (const pending of this.pendingReads.values()) {
      if (pending.deviceId === id) {
        pending.resolve(Response.json({ error: "revoked" }, { status: 503 }));
      }
    }
    let cleanup: "offline" | "confirmed" | "unconfirmed" = "offline";
    try {
      const sockets = this.state.getWebSockets("device:" + id);
      const target = sockets.find(socket => {
        if (!outcome.previousEpoch || socket.readyState !== WebSocket.OPEN) return false;
        try {
          const attachment = socket.deserializeAttachment() as { device_id?: unknown; epoch?: unknown } | null;
          return attachment?.device_id === id && attachment.epoch === outcome.previousEpoch;
        } catch { return false; }
      });
      if (target) {
        cleanup = "unconfirmed";
        if (this.pendingCleanup.size < 4) {
          const requestId = crypto.randomUUID();
          cleanup = await new Promise<"confirmed" | "unconfirmed">(resolve => {
            const timer = setTimeout(() => finish("unconfirmed"), 2_500);
            const finish = (status: "confirmed" | "unconfirmed") => {
              clearTimeout(timer);
              this.pendingCleanup.delete(requestId);
              resolve(status);
            };
            this.pendingCleanup.set(requestId, {
              socket: target,
              resolve: status => finish(status === "confirmed" ? "confirmed" : "unconfirmed"),
            });
            try { target.send(JSON.stringify({ kind: "revoke_cleanup", request_id: requestId })); }
            catch { finish("unconfirmed"); }
          });
        }
      } else if (sockets.some(socket => socket.readyState === WebSocket.OPEN)) cleanup = "unconfirmed";
      for (const socket of sockets) {
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
    for (const pending of this.pendingCleanup.values()) {
      if (pending.socket === socket) pending.resolve("uncertain");
    }
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
    if (typeof message === "string" && this.handleCleanupAck(socket, message)) return;
    if (typeof message === "string" && await this.handleReadResult(socket, message)) return;
    if (await handleDeviceInfoMessage(this.state, socket, message)) return;
    await handleIdleSocketMessage(this.state, socket, message);
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/ws/")) {
      return acceptAuthenticatedSocket(this.state.storage, this.state, request);
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === "/rename") {
      try { return await this.renameDevice(request); }
      catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
    }
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
    // The only route that can create an owner upgrade intent. The public MCP
    // layer must supply a SERVER-PINNED target, never caller-provided commit/
    // hash/URL. A live signed WSS epoch is mandatory even to prepare.
    // Read-only owner DO status for an upgrade remains queryable after Agent
    // Task shutdown, unlike a live-WSS receipt query. Never returns the
    // confirmation secret, form token or full device fingerprint.
    if (path === "/upgrade/status") {
      try {
        const input = await limitedJson(request, 1024) as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            Object.keys(input).sort().join("|") !== "device_id|operation_id" ||
            typeof input.operation_id !== "string" ||
            typeof input.device_id !== "string") {
          return Response.json({error:"invalid_request"},{status:400});
        }
        const record = await readOwnerUpgrade(this.state.storage,input.operation_id);
        if (!record || record.preview.device_id !== input.device_id) {
          return Response.json({error:"not_found"},{status:404});
        }
        let status = record.state;
        // No silent indefinite `claimed` state after stage/watchdog deadlines.
        // A missing signed Agent receipt stays locked and needs owner attention.
        // This does not dispatch, cancel, or retry the upgrade.
        if (status === "claimed" &&
            await markStaleOwnerUpgradeAttention(this.state.storage,input.operation_id))
          status = "needs_attention";
        // Reconcile only a freshly authenticated, currently reported socket.
        // A restored old runtime can report a failed local rollback receipt,
        // but must never release the guarded device lock or claim success.
        if (status === "claimed" || status === "needs_attention") {
          const device = await this.state.storage.get<V2Device>("device:"+input.device_id);
          const epoch = await this.state.storage.get<string>("session:epoch:"+input.device_id);
          const version = device?.device_info?.agent_version;
          let reported = false;
          if (device && epoch && device.fingerprint === record.preview.fingerprint &&
              (version === record.preview.target.tag || version === record.preview.current_version)) {
            for (const ws of this.state.getWebSockets("device:"+input.device_id)) {
              try {
                const a = ws.deserializeAttachment() as {device_id?:unknown;
                  epoch?:unknown;device_info_reported?:unknown;last_auth_check_at?:unknown} | null;
                const last = a?.last_auth_check_at;
                if (ws.readyState === WebSocket.OPEN && a?.device_id === input.device_id &&
                    a.epoch === epoch && a.device_info_reported === true &&
                    typeof last === "number" && last <= Date.now() &&
                    Date.now() - last < 16 * 60_000) {
                  reported = true; break;
                }
              } catch { /* An unreported or stale socket never verifies completion. */ }
            }
          }
          if (reported) {
            try {
              const result = await this.readFile(new Request("https://v2.internal/operation",{
                method:"POST",headers:{"content-type":"application/json"},
                body:JSON.stringify({
                  device_id:input.device_id,tool:"get_operation_status",
                  operation_id:input.operation_id,
                  arguments:{operation_id:input.operation_id},
                }),
              }),true);
              if (result.ok) {
                const answer=await result.json() as {
                  status?:unknown;receipt?:{tool_name?:unknown;state?:unknown;operation_id?:unknown;safe_result_summary?:unknown};
                };
                if (answer.receipt?.operation_id === input.operation_id &&
                    answer.receipt.tool_name === "upgrade_agent") {
                  if (version === record.preview.target.tag &&
                      answer.status === "completed" && answer.receipt.state === "completed" &&
                      await markOwnerUpgradeCompleted(this.state.storage,
                        input.operation_id,input.device_id,epoch!)) {
                    status = "completed";
                  } else if (version === record.preview.current_version &&
                      answer.status === "failed" && answer.receipt.state === "failed") {
                    const verifiedRollback =
                      ((device?.device_info?.os === "linux" &&
                        answer.receipt.safe_result_summary ===
                          "Original Linux unit and identity restored; signed owner reconciliation required.") ||
                       (device?.device_info?.os === "windows" &&
                        answer.receipt.safe_result_summary ===
                          "Watchdog restored original native user Task; owner review required.")) &&
                      await markOwnerUpgradeRolledBack(this.state.storage,
                        input.operation_id,input.device_id,epoch!);
                    if (verifiedRollback)status = "rolled_back";
                    else if (await markUpgradeDispatchUncertain(
                      this.state.storage,input.operation_id))status = "needs_attention";
                  }
                }
              }
            } catch { /* Uncertain upgrade remains guarded and queryable. */ }
          }
        }
        return Response.json({
          operation_id:record.preview.operation_id,
          device_id:record.preview.device_id,
          status,
          target_version:record.preview.target.tag,
        },{headers:{"cache-control":"no-store"}});
      } catch {
        return Response.json({error:"unavailable"},{status:503});
      }
    }
    if (path === "/upgrade/prepare") {
      try {
        const input = await limitedJson(request, 2048) as Record<string, unknown>;
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            Object.keys(input).sort().join("|") !== "device_id|operation_id|target" ||
            typeof input.device_id !== "string" ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.device_id) ||
            typeof input.operation_id !== "string" ||
            !/^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,128}$/.test(input.operation_id) ||
            !input.target || typeof input.target !== "object" ||
            Array.isArray(input.target)) {
          return Response.json({error:"invalid_request"},{status:400});
        }
        const id = input.device_id;
        const target = input.target as Record<string, unknown>;
        const shape=Object.keys(target).sort().join("|");
        if ((shape!=="commit|tag|windows_asset_sha256" &&
             shape!=="commit|linux_arm64_asset_sha256|linux_x64_asset_sha256|protocol|tag") ||
            typeof target.tag !== "string" ||
            typeof target.commit !== "string") {
          return Response.json({error:"invalid_request"},{status:400});
        }
        if(shape==="commit|tag|windows_asset_sha256" &&
           typeof target.windows_asset_sha256!=="string")
          return Response.json({error:"invalid_request"},{status:400});
        const epoch = await this.state.storage.get<string>("session:epoch:" + id);
        const now = Date.now();
        if (!epoch) return Response.json({error:"offline"},{status:503});
        let authenticated = false;
        for (const socket of this.state.getWebSockets("device:" + id)) {
          try {
            const attached = socket.deserializeAttachment() as {
              device_id?:unknown; epoch?:unknown; last_auth_check_at?:unknown;
              device_info_reported?:unknown;
            } | null;
            const last = attached?.last_auth_check_at;
            // Newly connected sockets must report their current runtime
            // capability before an old persisted capability can be trusted.
            if (socket.readyState === WebSocket.OPEN && attached?.device_id === id &&
                attached.epoch === epoch && attached.device_info_reported === true &&
                typeof last === "number" && last <= now && now - last < 16 * 60_000) {
              authenticated = true; break;
            }
          } catch { /* malformed WSS incarnation cannot prepare an upgrade */ }
        }
        if (!authenticated) return Response.json({error:"offline"},{status:503});
        // Only the server-owned, independently reviewed immutable dual-arch
        // Linux pin may select an asset. Signed WSS metadata selects exactly
        // ONE architecture; client-supplied SHA, URL or OS cannot choose it.
        let approvedTarget:ReviewedUpgradePin;
        if(shape==="commit|tag|windows_asset_sha256"){
          approvedTarget=target as unknown as ReviewedUpgradePin;
        }else{
          const device=await this.state.storage.get<V2Device>("device:"+id);
          const reviewed=inspectReviewedLinuxUpgradeAsset(device,
            target as unknown as ReviewedLinuxUpgradePin);
          if(!reviewed)return Response.json({error:"not_reviewed"},{status:409});
          approvedTarget={tag:reviewed.tag,commit:reviewed.commit,
            linux_arch:reviewed.arch,linux_asset_sha256:reviewed.asset_sha256};
        }
        const result = await prepareOwnerUpgrade(this.state.storage,
          input.operation_id, id, approvedTarget, now);
        return Response.json(result, {status:result.status === "prepared" ? 200 : 409,
          headers:{"cache-control":"no-store"}});
      } catch {
        return Response.json({error:"unavailable"},{status:503});
      }
    }

    // Internal-only routes; the public Worker MUST validate signed Access
    // owner identity, host, Origin and CSRF before forwarding either call.
    // Neither route dispatches an Agent operation or changes a Windows Task.
    if (path === "/upgrade/preview" || path === "/upgrade/confirm" || path === "/upgrade/cancel") {
      try {
        const body = await limitedJson(request, 2048) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            typeof body.operation_id !== "string" ||
            typeof body.confirmation !== "string" ||
            (path === "/upgrade/preview"
              ? Object.keys(body).length !== 2
              : Object.keys(body).length !== 3 || typeof body.form_token !== "string")) {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        if (path === "/upgrade/preview") {
          const result = await presentOwnerUpgrade(this.state.storage,
            body.operation_id, body.confirmation);
          return result
            ? Response.json(result, { headers: { "cache-control": "no-store" } })
            : Response.json({ error: "not_found" }, { status: 404 });
        }
        if (path === "/upgrade/cancel") {
          const cancelled = await cancelPreparedOwnerUpgrade(this.state.storage,
            body.operation_id, body.confirmation, body.form_token as string);
          return Response.json({cancelled},{status:cancelled?200:409,
            headers:{"cache-control":"no-store"}});
        }
        const approved = await confirmOwnerUpgrade(this.state.storage,
          body.operation_id, body.confirmation, body.form_token as string);
        if (!approved) return Response.json({approved:false},{status:409,
          headers:{"cache-control":"no-store"}});
        // The single Access owner POST consumes the grant before attempting
        // one signed WSS admission. The current Agent handler only fsyncs its
        // receipt; no installer download or Task switch exists on this branch.
        const dispatch = await claimOwnerUpgradeDispatch(this.state.storage,body.operation_id);
        if (!dispatch) return Response.json({approved:true,status:"needs_attention"},{
          headers:{"cache-control":"no-store"}});
        const pending = await this.readFile(new Request("https://v2.internal/operation",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({
            device_id:dispatch.device_id, tool:"upgrade_agent",
            operation_id:dispatch.operation_id, arguments:dispatch,
          }),
        }),true);
        let status:unknown;
        try { status=(await pending.json() as {status?:unknown}).status; }
        catch { /* Unknown WSS response remains guarded. */ }
        if (pending.ok && status === "admitted")
          return Response.json({approved:true,status:"admitted"},{
            headers:{"cache-control":"no-store"}});
        await markUpgradeDispatchUncertain(this.state.storage,body.operation_id);
        return Response.json({approved:true,status:"needs_attention"},{
          headers:{"cache-control":"no-store"}});

      } catch {
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
    }
    if (path === "/devices") {
      try {
        if (request.headers.get("content-type") !== "application/json" ||
            await request.text() !== "{}") return new Response(null, { status: 400 });
        const output = await listApprovedDevices(this.state);
        return Response.json(output.body, { status: output.status, headers: { "cache-control": "no-store" } });
      } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
    }
    if (!["/register", "/lookup", "/approve", "/session/challenge", "/session/recover", "/re-pair/status"].includes(path)) return new Response(null, { status: 404 });
    let payload: unknown;
    try { payload = await limitedJson(request); } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    try {
      let output: { status: number; body: object };
      if (path === "/re-pair/status") output = await checkRevokedIdentity(this.state.storage, payload);
      else if (path === "/session/challenge") output = await issueSessionChallenge(this.state.storage, payload);
      else if (path === "/session/recover") output = await authorizeSession(this.state.storage, payload);
      else if (path === "/register") output = await registerPending(this.state.storage, payload);
      else if (path === "/lookup") output = await lookupPending(
        this.state.storage, (payload as { verifier?: unknown })?.verifier as string,
      );
      else if (path === "/approve") {
        const pending = payload as {pairing_id?:unknown; expected_fingerprint?:unknown; expected_grant_type?:unknown};
        output = await approvePendingKey(this.state.storage, pending?.pairing_id,
          pending?.expected_fingerprint, pending?.expected_grant_type);
      } else return new Response(null, {status:404});
      return Response.json(output.body, { status: output.status, headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
  }
}
