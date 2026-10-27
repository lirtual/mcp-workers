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

function parseVersion(input: string): { core: number[]; pre: string[] } {
  // Metadata originates with a bounded signed device report or a reviewed pin.
  // Still cap cost before parsing numeric prerelease components as BigInt.
  if (input.length > 64) throw new Error("Unbounded Agent version.");
  const match = RELEASE.exec(input);
  if (!match) throw new Error("Unsupported Agent version.");
  const core = [match[1]!, match[2]!, match[3]!].map(Number);
  if (core.some(n => !Number.isSafeInteger(n))) throw new Error("Invalid Agent version.");
  return { core, pre: match[4]?.split(".") ?? [] };
}
function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]! ? 1 : -1;
  if (!x.pre.length) return y.pre.length ? 1 : 0;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const numericA = /^(0|[1-9][0-9]*)$/.test(x.pre[i]!);
    const numericB = /^(0|[1-9][0-9]*)$/.test(y.pre[i]!);
    if (numericA && numericB) {
      const na = BigInt(x.pre[i]!), nb = BigInt(y.pre[i]!);
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (numericA !== numericB) return numericA ? -1 : 1;
    else if (x.pre[i] !== y.pre[i]) return x.pre[i]! > y.pre[i]! ? 1 : -1;
  }
  return 0;
}
function validTarget(pin: ReviewedUpgradePin, current: string): boolean {
  return Boolean(pin && typeof pin.tag === "string" && typeof pin.commit === "string" &&
    typeof pin.windows_asset_sha256 === "string" &&
    COMMIT.test(pin.commit) && SHA.test(pin.windows_asset_sha256) &&
    compareVersions(pin.tag, current) > 0);
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
    device.device_info?.agent_version === row.current_version;
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

/** Read-only status: never returns the nonce or CSRF token. */
export async function readWindowsUpgrade(
  store: Store, operationId: string,
): Promise<{ state: UpgradeApprovalState; preview: UpgradeApprovalPreview } | null> {
  if (!OPERATION.test(operationId)) return null;
  const record = await store.get<StoredUpgrade>(key(operationId));
  return record ? { state: record.state, preview: publicPreview(record) } : null;
}
