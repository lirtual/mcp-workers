/** Private owner-DO admission for one confirmed Windows Agent upgrade.
 * No MCP tool or HTTP route invokes these functions until Access and the
 * signed Agent executor are connected and independently tested.
 *
 * Only a trusted Worker caller may supply a release pin or invoke confirmation;
 * ChatGPT tool arguments, Shell permissions, and bearer authentication are
 * never human-owner consent.
 */
import { deviceIsAuthorized, type V2Device } from "./v2-session.ts";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OPERATION = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RELEASE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9a-z][0-9a-z.-]*))?$/;
export const UPGRADE_APPROVAL_TTL_MS = 5 * 60_000;

export interface ReviewedUpgradePin {
  tag: string;
  commit: string;
  windows_asset_sha256: string;
}
export interface UpgradeApprovalPreview {
  operation_id: string;
  device_id: string;
  fingerprint: string;
  current_version: string;
  target: ReviewedUpgradePin;
  expires_at: number;
}
export type UpgradeApprovalState = "prepared" | "approved" | "claimed" | "completed" | "needs_attention";
interface StoredUpgrade extends UpgradeApprovalPreview {
  state: UpgradeApprovalState;
  confirmation_digest: string;
  form_digest?: string;
  approved_at?: number;
}
type Store = Pick<DurableObjectStorage, "get" | "put" | "transaction">;
const key = (operationId: string) => "upgrade:operation:" + operationId;
const lock = (deviceId: string) => "upgrade:device:" + deviceId;

/** The installed Windows Scheduled Task switch compares base major/minor/patch,
 * rejecting same-base prerelease replacements as well as downgrades. */
function newerWindowsVersion(target: string, current: string): boolean {
  const parse = (version: string) => {
    if (version.length > 64 || !RELEASE.test(version)) return null;
    const groups = /^v([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(version);
    if (!groups) return null;
    const parts = groups.slice(1).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const a = parse(target), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
function validTarget(pin: ReviewedUpgradePin, current: string): boolean {
  return Boolean(pin && typeof pin.tag === "string" && typeof pin.commit === "string" &&
    typeof pin.windows_asset_sha256 === "string" &&
    COMMIT.test(pin.commit) && SHA.test(pin.windows_asset_sha256) &&
    newerWindowsVersion(pin.tag, current));
}
function secret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    b => b.toString(16).padStart(2, "0")).join("");
}
function samePreview(a: UpgradeApprovalPreview, b: UpgradeApprovalPreview): boolean {
  return a.operation_id === b.operation_id && a.device_id === b.device_id &&
    a.fingerprint === b.fingerprint && a.current_version === b.current_version &&
    a.target.tag === b.target.tag && a.target.commit === b.target.commit &&
    a.target.windows_asset_sha256 === b.target.windows_asset_sha256;
}
function publicPreview(row: StoredUpgrade): UpgradeApprovalPreview {
  return { operation_id: row.operation_id, device_id: row.device_id,
    fingerprint: row.fingerprint, current_version: row.current_version,
    target: row.target, expires_at: row.expires_at };
}
function matchesLiveDevice(row: UpgradeApprovalPreview, device: V2Device | undefined): boolean {
  return deviceIsAuthorized(device) && device.grant_type !== "temporary" &&
    device.device_id === row.device_id && device.fingerprint === row.fingerprint &&
    device.device_info?.os === "windows" && device.device_info?.arch === "x64" &&
    device.device_info?.environment === "native" &&
    device.device_info?.agent_version === row.current_version &&
    device.device_info?.upgrade_protocol === "owner-one-shot-v1";
}

/** Caller MUST obtain reviewedPin from a server-owned allowlist, never MCP arguments. */
export async function prepareWindowsUpgrade(
  store: Store, operationId: string, deviceId: string, reviewedPin: ReviewedUpgradePin,
  now = Date.now(),
): Promise<{ status: "prepared"; confirmation: string; preview: UpgradeApprovalPreview } | { status: "existing" | "refused" }> {
  if (!OPERATION.test(operationId) || !UUID.test(deviceId) || !Number.isSafeInteger(now)) return { status: "refused" };
  return store.transaction(async tx => {
    if (await tx.get<StoredUpgrade>(key(operationId))) return { status: "existing" };
    const device = await tx.get<V2Device>("device:" + deviceId);
    if (!deviceIsAuthorized(device) || device.grant_type === "temporary" ||
        device.device_id !== deviceId || device.device_info?.os !== "windows" ||
        device.device_info?.arch !== "x64" || device.device_info?.environment !== "native" ||
        device.device_info?.upgrade_protocol !== "owner-one-shot-v1" ||
        typeof device.device_info?.agent_version !== "string" ||
        typeof device.fingerprint !== "string" || !/^[a-f0-9]{24}$/.test(device.fingerprint)) {
      return { status: "refused" };
    }
    const currentVersion = device.device_info.agent_version;
    try { if (!validTarget(reviewedPin, currentVersion)) return { status: "refused" }; }
    catch { return { status: "refused" }; }
    const occupied = await tx.get<string>(lock(deviceId));
    if (occupied) {
      const previous = await tx.get<StoredUpgrade>(key(occupied));
      if (!previous || previous.state === "claimed" ||
          previous.state === "needs_attention" ||
          ((previous.state === "prepared" || previous.state === "approved") && now < previous.expires_at)) {
        return { status: "refused" };
      }
      if (!["completed", "prepared", "approved"].includes(previous.state)) return { status: "refused" };
    }
    const token = secret();
    const preview: UpgradeApprovalPreview = {
      operation_id: operationId, device_id: deviceId, fingerprint: device.fingerprint,
      current_version: currentVersion, target: { ...reviewedPin },
      expires_at: now + UPGRADE_APPROVAL_TTL_MS,
    };
    await tx.put(key(operationId), { ...preview, state: "prepared",
      confirmation_digest: await digest(token) } satisfies StoredUpgrade);
    await tx.put(lock(deviceId), operationId);
    return { status: "prepared", confirmation: token, preview };
  });
}

/** Call only AFTER validating the Access JWT and its exact owner, issuer and audience.
 * GET issues an independent CSRF token; receiving the preview is not consent.
 */
export async function presentWindowsUpgrade(
  store: Store, operationId: string, confirmation: string, now = Date.now(),
): Promise<{ preview: UpgradeApprovalPreview; form_token: string } | null> {
  if (!OPERATION.test(operationId) || !SHA.test(confirmation)) return null;
  return store.transaction(async tx => {
    const record = await tx.get<StoredUpgrade>(key(operationId));
    if (!record || record.state !== "prepared" || now >= record.expires_at ||
        record.confirmation_digest !== await digest(confirmation) ||
        !matchesLiveDevice(record, await tx.get<V2Device>("device:" + record.device_id)) ||
        await tx.get<string>(lock(record.device_id)) !== operationId) return null;
    const form = secret();
    await tx.put(key(operationId), { ...record, form_digest: await digest(form) });
    return { preview: publicPreview(record), form_token: form };
  });
}

/** Call ONLY after Access owner JWT verification and an explicit POST/Origin/CSRF
 * browser action. A remembered MCP confirmation is never sufficient.
 */
export async function confirmWindowsUpgrade(
  store: Store, operationId: string, confirmation: string, formToken: string, now = Date.now(),
): Promise<boolean> {
  if (!OPERATION.test(operationId) || !SHA.test(confirmation) || !SHA.test(formToken)) return false;
  return store.transaction(async tx => {
    const record = await tx.get<StoredUpgrade>(key(operationId));
    if (!record || record.state !== "prepared" || now >= record.expires_at ||
        record.confirmation_digest !== await digest(confirmation) ||
        !record.form_digest || record.form_digest !== await digest(formToken) ||
        !matchesLiveDevice(record, await tx.get<V2Device>("device:" + record.device_id)) ||
        await tx.get<string>(lock(record.device_id)) !== operationId) return false;
    await tx.put(key(operationId), { ...record, state: "approved", approved_at: now,
      form_digest: undefined, confirmation_digest: "" } satisfies StoredUpgrade);
    return true;
  });
}

/** Claim exactly once before any signed Agent WSS dispatch. A claimed/unknown
 * operation stays guarded even if WSS drops or the caller retries.
 */
export async function claimWindowsUpgrade(
  store: Store, preview: UpgradeApprovalPreview, now = Date.now(),
): Promise<boolean> {
  if (!OPERATION.test(preview.operation_id) || !UUID.test(preview.device_id)) return false;
  return store.transaction(async tx => {
    const record = await tx.get<StoredUpgrade>(key(preview.operation_id));
    if (!record || record.state !== "approved" || now >= record.expires_at ||
        !samePreview(record, preview) || await tx.get<string>(lock(preview.device_id)) !== preview.operation_id ||
        !matchesLiveDevice(record, await tx.get<V2Device>("device:" + record.device_id))) return false;
    await tx.put(key(preview.operation_id), { ...record, state: "claimed" });
    return true;
  });
}

/** Consume one confirmed owner approval and bind the exact immutable
 * payload to a single authenticated Agent WSS dispatch. Never replay after
 * losing the WSS response: the DO record stays claimed/guarded.
 */
export async function claimWindowsUpgradeDispatch(
  store: Store, operationId: string, now = Date.now(),
): Promise<(UpgradeApprovalPreview & { approved_at: number }) | null> {
  if (!OPERATION.test(operationId)) return null;
  return store.transaction(async tx => {
    const record = await tx.get<StoredUpgrade>(key(operationId));
    if (!record || record.state !== "approved" ||
        typeof record.approved_at !== "number" ||
        record.approved_at > now || now >= record.expires_at ||
        await tx.get<string>(lock(record.device_id)) !== operationId ||
        !matchesLiveDevice(record, await tx.get<V2Device>("device:" + record.device_id))) return null;
    await tx.put(key(operationId), { ...record, state: "claimed" });
    return { ...publicPreview(record), approved_at: record.approved_at };
  });
}
export async function markUpgradeDispatchUncertain(
  store: Store, operationId: string,
): Promise<boolean> {
  if (!OPERATION.test(operationId)) return false;
  return store.transaction(async tx => {
    const record = await tx.get<StoredUpgrade>(key(operationId));
    if (!record || record.state !== "claimed") return false;
    await tx.put(key(operationId), { ...record, state: "needs_attention" });
    return true;
  });
}

/** Read-only status: never returns the nonce or CSRF token. */
export async function readWindowsUpgrade(
  store: Store, operationId: string,
): Promise<{ state: UpgradeApprovalState; preview: UpgradeApprovalPreview } | null> {
  if (!OPERATION.test(operationId)) return null;
  const record = await store.get<StoredUpgrade>(key(operationId));
  return record ? { state: record.state, preview: publicPreview(record) } : null;
}
