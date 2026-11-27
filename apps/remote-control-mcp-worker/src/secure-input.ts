/** Metadata-only, one-time secure input lifecycle for the existing RCA owner DO. */
export const SECURE_INPUT_TTL_MS = 5 * 60_000;
export const SECURE_INPUT_RETENTION_MS = 24 * 60 * 60_000;
export const SECURE_INPUT_STALE_MS = 2 * 60_000;
export const MAX_SECURE_INPUT_BYTES = 8_192;
export const SECURE_INPUT_MAX_RECORDS = 64;
const SECURE_INPUT_MAX_ACTIVE = 4;

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const KEY_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ENVIRONMENT = /^[A-Za-z0-9_.-]{1,64}$/;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const ERROR_CODES = new Set([
  "provider_auth_unavailable", "target_not_accessible", "provider_cli_unavailable",
  "provider_write_failed", "process_unavailable", "input_rejected", "timed_out",
  "execution_interrupted", "unknown",
]);

export type SecureInputTarget =
  | { kind: "task_process"; session_id: string; name: string }
  | { kind: "github_repository_secret" | "github_repository_variable"; repository: string; name: string }
  | { kind: "github_environment_secret" | "github_environment_variable"; repository: string; environment: string; name: string }
  | { kind: "cloudflare_worker_secret"; account_id: string; worker_name: string; environment: string; mode: "deploy" | "version"; name: string };

export type SecureInputExecution = {
  device_id: string;
  epoch: string;
  grant_type: "permanent" | "temporary" | "session";
  session_attempt_id?: string;
  session_run_id?: number;
  session_run_attempt?: number;
  session_workflow_name?: "ubuntu" | "windows";
  expires_at?: number;
};

export type SecureInputState = "pending" | "accepted" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "expired";
export type SecureInputProviderPrincipal =
  | { provider: "github"; identity: string; repository: string; permission: "admin" }
  | { provider: "cloudflare"; identity: string; account_id: string; account_name?: string };

export interface SecureInputRecord {
  request_id: string;
  task_id: string;
  owner_user_id: string;
  purpose: string;
  target: SecureInputTarget;
  execution: SecureInputExecution;
  provider_principal?: SecureInputProviderPrincipal;
  is_production: boolean;
  production_authorized_at?: number;
  target_binding: string;
  state: SecureInputState;
  created_at: number;
  updated_at: number;
  expires_at: number;
  consumed_at?: number;
  dispatch_started_at?: number;
  error_code?: string;
}

type SecureInputStore = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list" | "transaction">;
export type ParsedSecureInputRequest = {
  purpose: string;
  target: SecureInputTarget;
  execution: { device_id: string };
  is_production: boolean;
};

const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const cleanText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);

export function parseSecureInputRequest(value: unknown): ParsedSecureInputRequest | null {
  if (!object(value) || (!exact(value, ["purpose", "execution", "target"]) &&
      !exact(value, ["purpose", "execution", "target", "is_production"])) ||
      (value.is_production !== undefined && typeof value.is_production !== "boolean") ||
      !cleanText(value.purpose, 256) || !object(value.execution) ||
      !exact(value.execution, ["device_id"]) || typeof value.execution.device_id !== "string" ||
      !ID.test(value.execution.device_id) || !object(value.target)) return null;
  const t = value.target;
  if (typeof t.kind !== "string") return null;
  let target: SecureInputTarget;
  if (t.kind === "task_process") {
    if (!exact(t, ["kind", "session_id", "name"]) || typeof t.session_id !== "string" ||
        !ID.test(t.session_id) || typeof t.name !== "string" || !KEY_NAME.test(t.name)) return null;
    target = { kind: t.kind, session_id: t.session_id, name: t.name };
  } else if (t.kind === "github_repository_secret" || t.kind === "github_repository_variable") {
    if (!exact(t, ["kind", "repository", "name"]) || typeof t.repository !== "string" ||
        !REPOSITORY.test(t.repository) || t.repository.includes("..") ||
        typeof t.name !== "string" || !KEY_NAME.test(t.name)) return null;
    target = { kind: t.kind, repository: t.repository, name: t.name };
  } else if (t.kind === "github_environment_secret" || t.kind === "github_environment_variable") {
    if (!exact(t, ["kind", "repository", "environment", "name"]) ||
        typeof t.repository !== "string" || !REPOSITORY.test(t.repository) || t.repository.includes("..") ||
        typeof t.environment !== "string" || !ENVIRONMENT.test(t.environment) ||
        typeof t.name !== "string" || !KEY_NAME.test(t.name)) return null;
    target = { kind: t.kind, repository: t.repository, environment: t.environment, name: t.name };
  } else if (t.kind === "cloudflare_worker_secret") {
    if (!exact(t, ["kind", "account_id", "worker_name", "environment", "mode", "name"]) ||
        typeof t.account_id !== "string" || !ACCOUNT_ID.test(t.account_id) ||
        typeof t.worker_name !== "string" || !WORKER_NAME.test(t.worker_name) ||
        typeof t.environment !== "string" || (t.environment !== "default" && !ENVIRONMENT.test(t.environment)) ||
        (t.mode !== "deploy" && t.mode !== "version") ||
        typeof t.name !== "string" || !KEY_NAME.test(t.name)) return null;
    target = { kind: t.kind, account_id: t.account_id, worker_name: t.worker_name,
      environment: t.environment, mode: t.mode, name: t.name };
  } else return null;
  return { purpose: value.purpose, target, execution: { device_id: value.execution.device_id },
    is_production: value.is_production === undefined ? true : value.is_production };
}

export function validateSecureInputSecret(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_SECURE_INPUT_BYTES) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value; }
  catch { return false; }
}

export async function secureInputTargetBinding(record: Pick<SecureInputRecord,
  "request_id" | "task_id" | "owner_user_id" | "purpose" | "target" | "execution" | "is_production"> &
  Partial<Pick<SecureInputRecord, "provider_principal">>): Promise<string> {
  const canonical = JSON.stringify({
    request_id: record.request_id, task_id: record.task_id, owner_user_id: record.owner_user_id,
    purpose: record.purpose, target: record.target, execution: record.execution,
    is_production: record.is_production,
    ...(record.provider_principal ? { provider_principal: record.provider_principal } : {}),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function hasSecureInputCapacity(rows: ReadonlyMap<string, SecureInputRecord>, deviceId: string): boolean {
  const active = [...rows.values()].filter(row =>
    row.state === "pending" || row.state === "accepted" || row.state === "running");
  return rows.size < SECURE_INPUT_MAX_RECORDS && active.length < 16 &&
    active.filter(row => row.execution.device_id === deviceId).length < SECURE_INPUT_MAX_ACTIVE;
}

export async function createSecureInputRecord(
  store: SecureInputStore,
  input: ParsedSecureInputRequest,
  ownerUserId: string,
  execution: SecureInputExecution,
  providerPrincipal?: SecureInputProviderPrincipal,
  now = Date.now(),
): Promise<SecureInputRecord> {
  const requestId = crypto.randomUUID();
  const base = {
    request_id: requestId, task_id: requestId, owner_user_id: ownerUserId,
    purpose: input.purpose, target: input.target, execution, is_production: input.is_production,
    ...(providerPrincipal ? { provider_principal: providerPrincipal } : {}),
  };
  const record: SecureInputRecord = {
    ...base, target_binding: await secureInputTargetBinding(base), state: "pending",
    created_at: now, updated_at: now, expires_at: now + SECURE_INPUT_TTL_MS,
  };
  await store.transaction(async tx => {
    const rows = await tx.list<SecureInputRecord>({ prefix: "secure-input:", limit: SECURE_INPUT_MAX_RECORDS + 1 });
    if (!hasSecureInputCapacity(rows, execution.device_id)) {
      throw new Error("secure_input_capacity");
    }
    await tx.put("secure-input:" + requestId, record);
  });
  return record;
}

const keyFor = (id: string) => "secure-input:" + id;
const reject = (status: number, error: string) => ({ status, body: { error } });
const terminal = (state: SecureInputState) =>
  state === "succeeded" || state === "failed" || state === "cancelled" || state === "expired";

export async function getSecureInputRecord(
  store: SecureInputStore, requestId: string, ownerUserId: string, now = Date.now(),
): Promise<{ status: number; body: SecureInputRecord | object }> {
  if (!ID.test(requestId)) return reject(400, "bad_request");
  const current = await store.get<SecureInputRecord>(keyFor(requestId));
  if (!current || current.owner_user_id !== ownerUserId) return reject(404, "not_found");
  if (current.state === "pending" && current.expires_at <= now) {
    const expired = { ...current, state: "expired" as const, updated_at: now };
    await store.put(keyFor(requestId), expired);
    return { status: 200, body: expired };
  }
  if ((current.state === "accepted" || current.state === "running") &&
      now - current.updated_at > SECURE_INPUT_STALE_MS) {
    const unknown = { ...current, state: "unknown" as const, error_code: "execution_interrupted", updated_at: now };
    await store.put(keyFor(requestId), unknown);
    return { status: 200, body: unknown };
  }
  return { status: 200, body: current };
}

export async function cancelSecureInputRecord(
  store: SecureInputStore, requestId: string, ownerUserId: string, now = Date.now(),
): Promise<{ status: number; body: object }> {
  if (!ID.test(requestId)) return reject(400, "bad_request");
  return store.transaction(async tx => {
    const current = await tx.get<SecureInputRecord>(keyFor(requestId));
    if (!current || current.owner_user_id !== ownerUserId) return reject(404, "not_found");
    if (current.state !== "pending") return reject(409, "already_consumed");
    if (current.expires_at <= now) {
      await tx.put(keyFor(requestId), { ...current, state: "expired", updated_at: now });
      return reject(410, "expired");
    }
    await tx.put(keyFor(requestId), { ...current, state: "cancelled", updated_at: now });
    return { status: 200, body: { request_id: requestId, state: "cancelled" } };
  });
}

/** Atomic one-time consume. Secret bytes are deliberately not an argument. */
export async function consumeSecureInputRecord(
  store: SecureInputStore, requestId: string, ownerUserId: string,
  confirmation: { target_confirmed: boolean; production_authorized: boolean }, now = Date.now(),
): Promise<{ status: number; body: object; record?: SecureInputRecord }> {
  if (!ID.test(requestId)) return reject(400, "bad_request");
  return store.transaction(async tx => {
    const current = await tx.get<SecureInputRecord>(keyFor(requestId));
    if (!current || current.owner_user_id !== ownerUserId) return reject(404, "not_found");
    if (current.state !== "pending") return reject(409, "already_consumed");
    if (!confirmation.target_confirmed || (current.is_production && !confirmation.production_authorized)) {
      return reject(403, current.is_production ? "production_authorization_required" : "target_confirmation_required");
    }
    if (current.expires_at <= now) {
      await tx.put(keyFor(requestId), { ...current, state: "expired", updated_at: now });
      return reject(410, "expired");
    }
    const consumed: SecureInputRecord = {
      ...current, state: "unknown", consumed_at: now, updated_at: now,
      ...(current.is_production ? { production_authorized_at: now } : {}),
    };
    await tx.put(keyFor(requestId), consumed);
    return { status: 200, body: { request_id: requestId, state: "unknown" }, record: consumed };
  });
}

export async function startSecureInputDispatch(
  store: SecureInputStore, requestId: string, deviceId: string, epoch: string, now = Date.now(),
): Promise<{ status: number; record?: SecureInputRecord; body: object }> {
  if (!ID.test(requestId) || !ID.test(deviceId) || !epoch) return reject(400, "bad_request");
  return store.transaction(async tx => {
    const current = await tx.get<SecureInputRecord>(keyFor(requestId));
    if (!current || current.execution.device_id !== deviceId || current.execution.epoch !== epoch ||
        current.state !== "unknown" || current.consumed_at === undefined) return reject(404, "not_found");
    if (current.dispatch_started_at !== undefined) return reject(409, "already_dispatched");
    const next = { ...current, dispatch_started_at: now, updated_at: now };
    await tx.put(keyFor(requestId), next);
    return { status: 200, body: { request_id: requestId, state: "unknown" }, record: next };
  });
}

export async function updateSecureInputStatus(
  store: SecureInputStore, requestId: string, deviceId: string, epoch: string,
  state: "accepted" | "running" | "succeeded" | "failed" | "unknown",
  errorCode?: string, now = Date.now(),
): Promise<{ status: number; body: object }> {
  if (!ID.test(requestId) || !ID.test(deviceId) || !epoch ||
      (errorCode !== undefined && !ERROR_CODES.has(errorCode))) return reject(400, "bad_request");
  return store.transaction(async tx => {
    const current = await tx.get<SecureInputRecord>(keyFor(requestId));
    if (!current || current.execution.device_id !== deviceId || current.execution.epoch !== epoch ||
        current.consumed_at === undefined || current.dispatch_started_at === undefined) return reject(404, "not_found");
    if (terminal(current.state)) return reject(409, "terminal");
    const allowed = state === "accepted" ? current.state === "unknown" :
      state === "running" ? current.state === "accepted" || current.state === "unknown" :
      state === "unknown" ? current.state === "accepted" || current.state === "running" || current.state === "unknown" :
      current.state === "accepted" || current.state === "running" || current.state === "unknown";
    if (!allowed) return reject(409, "invalid_transition");
    const next: SecureInputRecord = {
      ...current, state, updated_at: now,
      error_code: state === "unknown" ? errorCode ?? current.error_code :
        state === "failed" ? errorCode : undefined,
    };
    await tx.put(keyFor(requestId), next);
    return { status: 200, body: { request_id: requestId, state, ...(next.error_code ? { error_code: next.error_code } : {}) } };
  });
}

/** Only metadata is returned to MCP/Web; the binding digest stays internal. */
export function publicSecureInputRecord(record: SecureInputRecord): object {
  return {
    request_id: record.request_id, task_id: record.task_id, purpose: record.purpose,
    target: record.target, is_production: record.is_production,
    execution: {
      device_id: record.execution.device_id, grant_type: record.execution.grant_type,
      ...(record.execution.session_attempt_id ? { session_attempt_id: record.execution.session_attempt_id } : {}),
      ...(record.execution.session_run_id ? { session_run_id: record.execution.session_run_id } : {}),
      ...(record.execution.session_run_attempt ? { session_run_attempt: record.execution.session_run_attempt } : {}),
      ...(record.execution.session_workflow_name ? { session_workflow_name: record.execution.session_workflow_name } : {}),
      ...(record.execution.expires_at ? { expires_at: record.execution.expires_at } : {}),
    },
    ...(record.provider_principal ? { provider_principal: record.provider_principal } : {}),
    state: record.state, created_at: record.created_at, updated_at: record.updated_at,
    expires_at: record.expires_at, ...(record.consumed_at ? { consumed_at: record.consumed_at } : {}),
    ...(record.error_code ? { error_code: record.error_code } : {}),
  };
}

export async function markSecureInputUnknownForSocket(
  store: SecureInputStore, deviceId: string, epoch: string, now = Date.now(),
): Promise<void> {
  const rows = await store.list<SecureInputRecord>({ prefix: "secure-input:", limit: SECURE_INPUT_MAX_RECORDS });
  for (const [key, current] of rows) {
    if (current.execution.device_id !== deviceId || current.execution.epoch !== epoch ||
        current.consumed_at === undefined || terminal(current.state)) continue;
    await store.transaction(async tx => {
      const latest = await tx.get<SecureInputRecord>(key);
      if (!latest || latest.execution.device_id !== deviceId || latest.execution.epoch !== epoch ||
          latest.consumed_at === undefined || latest.dispatch_started_at === undefined || terminal(latest.state)) return;
      await tx.put(key, { ...latest, state: "unknown",
        error_code: latest.error_code ?? "execution_interrupted", updated_at: now });
    });
  }
}

export async function pruneSecureInputRecords(store: SecureInputStore, now = Date.now()): Promise<boolean> {
  return store.transaction(async tx => {
    const query = { prefix: "secure-input:", limit: SECURE_INPUT_MAX_RECORDS + 1 };
    const rows = await tx.list<SecureInputRecord>(query);
    let removed = false;
    for (const [key, record] of rows) {
      if (record.expires_at + SECURE_INPUT_RETENTION_MS <= now) {
        await tx.delete(key);
        removed = true;
      } else if (record.state === "pending" && record.expires_at <= now) {
        await tx.put(key, { ...record, state: "expired", updated_at: now });
      }
    }
    // Recover from an over-capacity store only by normal retention cleanup.
    return rows.size <= SECURE_INPUT_MAX_RECORDS ||
      (removed && (await tx.list<SecureInputRecord>(query)).size <= SECURE_INPUT_MAX_RECORDS);
  });
}
