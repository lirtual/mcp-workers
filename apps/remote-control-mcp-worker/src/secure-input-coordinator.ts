import { deviceIsAuthorized, deviceStillGranted, type SessionCheck, type DeviceRecord } from "./session.ts";
import {
  cancelSecureInputRecord, consumeSecureInputRecord, createSecureInputRecord,
  getSecureInputRecord, markSecureInputUnknownForSocket, parseSecureInputRequest,
  pruneSecureInputRecords, publicSecureInputRecord, hasSecureInputCapacity, SECURE_INPUT_MAX_RECORDS,
  startSecureInputDispatch, updateSecureInputStatus, validateSecureInputSecret, type SecureInputProviderPrincipal,
  type SecureInputRecord,
} from "./secure-input.ts";

type Attachment = { device_id?: unknown; epoch?: unknown };
type PrepareResult = { status: "ready" | "failed"; provider_principal?: SecureInputProviderPrincipal; error_code?: string };
type PendingPrepare = { socket: WebSocket; resolve: (result: PrepareResult) => void };
const MAX_BODY = 65_536;
const MAX_FRAME = 65_536;
// Keep read-only provider identity preflight within the Durable Object request budget.
const PROVIDER_PREFLIGHT_TIMEOUT_MS = 4_000;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_CODES = new Set(["provider_auth_unavailable", "target_not_accessible", "provider_cli_unavailable",
  "provider_write_failed", "process_unavailable", "input_rejected", "timed_out", "execution_interrupted", "unknown"]);
const json = (body: object, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function boundedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY) throw new Error("oversize");
  if (!request.body) throw new Error("missing");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error("oversize");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function validPrincipal(target: NonNullable<ReturnType<typeof parseSecureInputRequest>>["target"],
  value: unknown): value is SecureInputProviderPrincipal | undefined {
  if (target.kind === "task_process") return value === undefined;
  if (!isObject(value)) return false;
  if (target.kind === "github_repository_secret" || target.kind === "github_repository_variable" ||
      target.kind === "github_environment_secret" || target.kind === "github_environment_variable") {
    return exact(value, ["provider", "identity", "repository", "permission"]) &&
      value.provider === "github" && typeof value.identity === "string" &&
      value.repository === target.repository && value.permission === "admin";
  }
  if (target.kind === "cloudflare_worker_secret") {
    return (exact(value, ["provider", "identity", "account_id"]) ||
        exact(value, ["provider", "identity", "account_id", "account_name"])) &&
      value.provider === "cloudflare" && typeof value.identity === "string" &&
      value.account_id === target.account_id &&
      (value.account_name === undefined || typeof value.account_name === "string");
  }
  return false;
}

export class SecureInputCoordinator {
  private readonly pendingPrepare = new Map<string, PendingPrepare>();
  private readonly state: DurableObjectState;
  private readonly sessionCheck: SessionCheck;
  constructor(state: DurableObjectState, sessionCheck: SessionCheck) {
    this.state = state;
    this.sessionCheck = sessionCheck;
  }

  private async currentDevice(deviceId: string, epoch: string): Promise<DeviceRecord | null> {
    const [device, currentEpoch] = await Promise.all([
      this.state.storage.get<DeviceRecord>("device:" + deviceId),
      this.state.storage.get<string>("session:epoch:" + deviceId),
    ]);
    if (!device || device.revoked !== false || currentEpoch !== epoch ||
        !deviceIsAuthorized(device) || !deviceStillGranted(device)) return null;
    if (device.grant_type === "session" && !await this.sessionCheck(device)) return null;
    return device;
  }

  private socketFor(deviceId: string, epoch: string): WebSocket | null {
    for (const socket of this.state.getWebSockets("device:" + deviceId)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        const a = socket.deserializeAttachment() as Attachment | null;
        if (a?.device_id === deviceId && a.epoch === epoch) return socket;
      } catch { /* malformed attachment */ }
    }
    return null;
  }

  private async prepare(socket: WebSocket, target: unknown): Promise<PrepareResult | null> {
    if (this.pendingPrepare.size >= 4) return null;
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: PrepareResult | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingPrepare.delete(id);
        resolve(result ?? { status: "failed", error_code: "unknown" });
      };
      const timer = setTimeout(() => finish(null), PROVIDER_PREFLIGHT_TIMEOUT_MS);
      this.pendingPrepare.set(id, { socket, resolve: result => finish(result) });
      try { socket.send(JSON.stringify({ kind: "secure_input_prepare", preflight_id: id, target })); }
      catch { finish(null); }
    });
  }

  private async create(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await boundedJson(request); } catch { return json({ error: "bad_request" }, 400); }
    if (!isObject(body) || !exact(body, ["owner_user_id", "request"]) ||
        typeof body.owner_user_id !== "string" || !OWNER.test(body.owner_user_id)) return json({ error: "bad_request" }, 400);
    const parsed = parseSecureInputRequest(body.request);
    if (!parsed) return json({ error: "bad_request" }, 400);
    if (!await pruneSecureInputRecords(this.state.storage)) return json({ error: "capacity" }, 503);
    const rows = await this.state.storage.list<SecureInputRecord>({ prefix: "secure-input:", limit: SECURE_INPUT_MAX_RECORDS + 1 });
    if (!hasSecureInputCapacity(rows, parsed.execution.device_id)) {
      return json({ error: "capacity" }, 429);
    }
    const [device, epoch] = await Promise.all([
      this.state.storage.get<DeviceRecord>("device:" + parsed.execution.device_id),
      this.state.storage.get<string>("session:epoch:" + parsed.execution.device_id),
    ]);
    if (!device || !epoch || !await this.currentDevice(device.device_id, epoch)) {
      return json({ error: "target_unavailable" }, 503);
    }
    const socket = this.socketFor(device.device_id, epoch);
    if (!socket) return json({ error: "target_offline" }, 503);
    const prepared = await this.prepare(socket, parsed.target);
    if (!prepared || prepared.status !== "ready" || !validPrincipal(parsed.target, prepared.provider_principal)) {
      return json({ error: prepared?.error_code ?? "preflight_failed" }, 409);
    }
    const current = await this.currentDevice(device.device_id, epoch);
    if (!current || this.socketFor(device.device_id, epoch) !== socket) return json({ error: "target_changed" }, 409);
    const execution = {
      device_id: device.device_id, epoch, grant_type: device.grant_type ?? "permanent",
      ...(device.session_attempt_id ? { session_attempt_id: device.session_attempt_id } : {}),
      ...(device.session_run_id ? { session_run_id: device.session_run_id } : {}),
      ...(device.session_run_attempt ? { session_run_attempt: device.session_run_attempt } : {}),
      ...(device.session_workflow_name ? { session_workflow_name: device.session_workflow_name } : {}),
      ...(device.expires_at ? { expires_at: device.expires_at } : {}),
    };
    try {
      const record = await createSecureInputRecord(
        this.state.storage, parsed, body.owner_user_id, execution,
        prepared.provider_principal, Date.now(),
      );
      return json(publicSecureInputRecord(record));
    } catch (error) {
      return json({ error: error instanceof Error && error.message === "secure_input_capacity" ? "capacity" : "unavailable" },
        error instanceof Error && error.message === "secure_input_capacity" ? 429 : 503);
    }
  }

  private async status(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await boundedJson(request); } catch { return json({ error: "bad_request" }, 400); }
    if (!isObject(body) || !exact(body, ["owner_user_id", "request_id"]) ||
        typeof body.owner_user_id !== "string" || !OWNER.test(body.owner_user_id) ||
        typeof body.request_id !== "string" || !ID.test(body.request_id)) return json({ error: "bad_request" }, 400);
    const result = await getSecureInputRecord(this.state.storage, body.request_id, body.owner_user_id);
    if (result.status !== 200 || !("request_id" in result.body)) return json(result.body, result.status);
    const record = result.body as SecureInputRecord;
    const device = await this.state.storage.get<DeviceRecord>("device:" + record.execution.device_id);
    // Presentation only: current name from the existing device record, not the signed binding.
    return json({ ...publicSecureInputRecord(record), ...(device?.name ? { device_name: device.name } : {}) });
  }

  private async cancel(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await boundedJson(request); } catch { return json({ error: "bad_request" }, 400); }
    if (!isObject(body) || !exact(body, ["owner_user_id", "request_id"]) ||
        typeof body.owner_user_id !== "string" || !OWNER.test(body.owner_user_id) ||
        typeof body.request_id !== "string" || !ID.test(body.request_id)) return json({ error: "bad_request" }, 400);
    const result = await cancelSecureInputRecord(this.state.storage, body.request_id, body.owner_user_id);
    return json(result.body, result.status);
  }

  async validateTarget(requestId: string): Promise<boolean> {
    const record = await this.state.storage.get<SecureInputRecord>("secure-input:" + requestId);
    if (!record || record.state !== "pending" || record.expires_at <= Date.now()) return false;
    const current = await this.currentDevice(record.execution.device_id, record.execution.epoch);
    return Boolean(current && this.socketFor(record.execution.device_id, record.execution.epoch));
  }

  async dispatchConsumed(record: SecureInputRecord, secret: string): Promise<Response> {
    let value = secret;
    const dispatch = await startSecureInputDispatch(this.state.storage, record.request_id,
      record.execution.device_id, record.execution.epoch);
    if (dispatch.status !== 200 || !dispatch.record) {
      value = "";
      return json(dispatch.body, dispatch.status);
    }
    record = dispatch.record;
    const current = await this.currentDevice(record.execution.device_id, record.execution.epoch);
    const socket = current ? this.socketFor(record.execution.device_id, record.execution.epoch) : null;
    if (!current || !socket) {
      await updateSecureInputStatus(this.state.storage, record.request_id, record.execution.device_id,
        record.execution.epoch, "unknown", "execution_interrupted");
      value = "";
      return json({ request_id: record.request_id, state: "unknown", error_code: "execution_interrupted" }, 503);
    }
    const frame = JSON.stringify({
      kind: "secure_input", request_id: record.request_id, target: record.target,
      provider_principal: record.provider_principal ?? null, secret: value,
    });
    value = "";
    if (new TextEncoder().encode(frame).byteLength > MAX_FRAME) {
      await updateSecureInputStatus(this.state.storage, record.request_id, record.execution.device_id,
        record.execution.epoch, "failed", "input_rejected");
      return json({ error: "input_rejected" }, 413);
    }
    try { socket.send(frame); }
    catch {
      await updateSecureInputStatus(this.state.storage, record.request_id, record.execution.device_id,
        record.execution.epoch, "unknown", "execution_interrupted");
      return json({ request_id: record.request_id, state: "unknown", error_code: "execution_interrupted" }, 503);
    }
    return json({ request_id: record.request_id, state: "unknown" });
  }

  private async submit(request: Request): Promise<Response> {
    let body: unknown;
    try { body = await boundedJson(request); } catch { return json({ error: "bad_request" }, 400); }
    if (!isObject(body) || !exact(body, ["owner_user_id", "request_id", "secret", "target_confirmed", "production_authorized"]) ||
        typeof body.owner_user_id !== "string" || !OWNER.test(body.owner_user_id) ||
        typeof body.request_id !== "string" || !ID.test(body.request_id) ||
        !validateSecureInputSecret(body.secret) || typeof body.target_confirmed !== "boolean" ||
        typeof body.production_authorized !== "boolean") return json({ error: "bad_request" }, 400);
    const consumed = await consumeSecureInputRecord(this.state.storage, body.request_id, body.owner_user_id, {
      target_confirmed: body.target_confirmed, production_authorized: body.production_authorized,
    });
    if (consumed.status !== 200 || !consumed.record) return json(consumed.body, consumed.status);
    return this.dispatchConsumed(consumed.record, body.secret);
  }

  async handleSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<boolean> {
    if (typeof message !== "string" || message.length > MAX_FRAME || !message.startsWith("{")) return false;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(message) as Record<string, unknown>; } catch { return false; }
    if (!isObject(frame)) return false;
    if (frame.kind === "secure_input_prepare_result") {
      if (!exact(frame, ["kind", "preflight_id", "status"]) &&
          !exact(frame, ["kind", "preflight_id", "status", "provider_principal"]) &&
          !exact(frame, ["kind", "preflight_id", "status", "error_code"])) return false;
      if (typeof frame.preflight_id !== "string" || !ID.test(frame.preflight_id) ||
          (frame.status !== "ready" && frame.status !== "failed")) return false;
      const pending = this.pendingPrepare.get(frame.preflight_id);
      if (!pending) return true;
      if (pending.socket !== socket) {
        try { socket.close(1008, "wrong secure input preflight socket"); } catch { /* closed */ }
        return true;
      }
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment || typeof attachment.device_id !== "string" || typeof attachment.epoch !== "string") {
        pending.resolve({ status: "failed", error_code: "unknown" });
        return true;
      }
      if (frame.status === "ready") {
        const targetRecord = await this.state.storage.get<DeviceRecord>("device:" + attachment.device_id);
        const epoch = await this.state.storage.get<string>("session:epoch:" + attachment.device_id);
        if (!targetRecord || targetRecord.revoked !== false || epoch !== attachment.epoch) {
          pending.resolve({ status: "failed", error_code: "execution_interrupted" });
          return true;
        }
        pending.resolve({ status: "ready", provider_principal: frame.provider_principal as SecureInputProviderPrincipal | undefined });
      } else {
        pending.resolve({ status: "failed", error_code: typeof frame.error_code === "string" &&
          ERROR_CODES.has(frame.error_code) ? frame.error_code : "unknown" });
      }
      return true;
    }
    if (frame.kind !== "secure_input_ack" && frame.kind !== "secure_input_progress" &&
        frame.kind !== "secure_input_result") return false;
    const allowed = frame.kind === "secure_input_result"
      ? exact(frame, ["kind", "request_id", "status"]) || exact(frame, ["kind", "request_id", "status", "error_code"])
      : exact(frame, ["kind", "request_id", "status"]);
    if (!allowed || typeof frame.request_id !== "string" || !ID.test(frame.request_id)) return false;
    const state = frame.status;
    if ((frame.kind === "secure_input_ack" && state !== "accepted") ||
        (frame.kind === "secure_input_progress" && state !== "running") ||
        (frame.kind === "secure_input_result" && state !== "succeeded" && state !== "failed" && state !== "unknown")) return false;
    const errorCode = frame.error_code;
    if (errorCode !== undefined && (typeof errorCode !== "string" || !ERROR_CODES.has(errorCode))) return false;
    let attachment: Attachment | null;
    try { attachment = socket.deserializeAttachment() as Attachment | null; } catch { attachment = null; }
    if (!attachment || typeof attachment.device_id !== "string" || typeof attachment.epoch !== "string") return true;
    const [device, epoch] = await Promise.all([
      this.state.storage.get<DeviceRecord>("device:" + attachment.device_id),
      this.state.storage.get<string>("session:epoch:" + attachment.device_id),
    ]);
    if (!device || device.revoked !== false || epoch !== attachment.epoch) return true;
    await updateSecureInputStatus(this.state.storage, frame.request_id, attachment.device_id,
      attachment.epoch, state as "accepted" | "running" | "succeeded" | "failed" | "unknown",
      typeof errorCode === "string" ? errorCode : undefined);
    return true;
  }

  async socketClosed(socket: WebSocket): Promise<void> {
    for (const [id, pending] of this.pendingPrepare) {
      if (pending.socket === socket) {
        this.pendingPrepare.delete(id);
        pending.resolve({ status: "failed", error_code: "execution_interrupted" });
      }
    }
    try {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (typeof attachment?.device_id === "string" && typeof attachment.epoch === "string") {
        await markSecureInputUnknownForSocket(this.state.storage, attachment.device_id, attachment.epoch);
      }
    } catch { /* A disconnected socket must not affect another epoch. */ }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    switch (new URL(request.url).pathname) {
      case "/secure-input/request": return this.create(request);
      case "/secure-input/status": return this.status(request);
      case "/secure-input/cancel": return this.cancel(request);
      case "/secure-input/submit": return this.submit(request);
      default: return json({ error: "not_found" }, 404);
    }
  }
}
