/** Authentication-only v2 WSS. This module never dispatches remote tools. */
import { parseDeviceInfo, type DeviceInfo } from "./device-info.ts";
const DOMAIN = "remote-control:v2:session:";
const TTL_MS = 60_000;
const te = new TextEncoder();

export interface V2Device {
  device_id: string;
  name: string;
  public_key: string;
  fingerprint: string;
  approved_at: number;
  revoked: boolean;
  device_info?: DeviceInfo;
  device_info_epoch?: string;
  last_seen?: number;
  grant_type?: "permanent" | "temporary";
  expires_at?: number;
}
export const TEMPORARY_GRANT_MS = 86_400_000;

/** Old v2 Preview grants had no grant_type; they remain permanent. */
export function deviceIsAuthorized(device: V2Device | undefined, now = Date.now()): device is V2Device & { revoked: false } {
  if (!device || device.revoked !== false) return false;
  if (device.grant_type === undefined || device.grant_type === "permanent") return true;
  return device.grant_type === "temporary" &&
    Number.isSafeInteger(device.approved_at) && Number.isSafeInteger(device.expires_at) &&
    device.expires_at === device.approved_at + TEMPORARY_GRANT_MS && now < device.expires_at;
}
/** A bounded lazy sweep; expired grants never consume the 64 active slots.
 * No alarm, historical blacklist, or new persistent index. */
export async function listLiveGrants(
  store: Pick<DurableObjectStorage, "list" | "delete">,
  now = Date.now(),
): Promise<{ active: Map<string, V2Device>; complete: boolean }> {
  // A full page may hide more active grants after expired rows. Fail closed
  // for this request while lazily cleaning the page, then allow a safe retry.
  const rows = await store.list<V2Device>({ prefix: "device:", limit: 65 });
  const complete = rows.size < 65;
  const active = new Map<string, V2Device>();
  for (const [key, row] of rows) {
    if (deviceIsAuthorized(row, now)) {
      active.set(key, row);
    } else {
      await store.delete(key);
      if (row?.device_id && key === "device:" + row.device_id) {
        await store.delete("session:nonce:" + row.device_id);
        await store.delete("session:epoch:" + row.device_id);
      }
    }
  }
  return { active, complete };
}

type DurableStore = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list" | "transaction">;
type NonceRecord = { nonce: string; expires_at: number };
type Budget = { reset_at: number; count: number };
const nonceKey = (id: string) => "session:nonce:" + id;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const isSpki = (value: unknown): value is string => typeof value === "string" &&
  /^[A-Za-z0-9+/]{59}=$/.test(value);

function decode64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{86}$/.test(text)) return null;
  try {
    const conventional = text.replace(/-/g, "+").replace(/_/g, "/") + "==";
    const bytes = Uint8Array.from(atob(conventional), c => c.charCodeAt(0));
    if (bytes.length !== 64) return null;
    return bytes;
  } catch { return null; }
}

async function consumeBudget(store: DurableStore): Promise<boolean> {
  return store.transaction(async tx => {
    const now = Date.now(), key = "budget:session";
    const current = await tx.get<Budget>(key);
    if (current && current.reset_at > now && current.count >= 60) return false;
    await tx.put(key, current && current.reset_at > now
      ? { reset_at: current.reset_at, count: current.count + 1 }
      : { reset_at: now + 60_000, count: 1 });
    return true;
  });
}

export async function issueSessionChallenge(store: DurableStore, body: unknown):
  Promise<{ status: number; body: object }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  const { device_id, public_key } = body as { device_id?: unknown; public_key?: unknown };
  if (!(isId(device_id) && public_key === undefined) &&
      !(device_id === undefined && isSpki(public_key))) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (!await consumeBudget(store)) return { status: 429, body: { error: "rate_limited" } };
  let device: V2Device | undefined;
  if (isId(device_id)) {
    device = await store.get<V2Device>("device:" + device_id);
  } else {
    // Small single-owner fleet only; bounded scan, not a new index/service.
    const grants = await listLiveGrants(store);
    if (!grants.complete || grants.active.size > 64) return { status: 503, body: { error: "capacity" } };
    device = [...grants.active.values()].find(d => d.public_key === public_key);
  }
  if (!deviceIsAuthorized(device)) return { status: 404, body: { error: "not_found" } };
  const entropy = new Uint8Array(18);
  crypto.getRandomValues(entropy);
  const nonce = btoa(String.fromCharCode(...entropy)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  await store.put(nonceKey(device.device_id), { nonce, expires_at: Date.now() + TTL_MS } satisfies NonceRecord);
  return { status: 200, body: { device_id: device.device_id, nonce, expires_at: Date.now() + TTL_MS } };
}

export function sessionTranscript(deviceId: string, nonce: string, publicKey: string): string {
  return DOMAIN + deviceId + ":" + nonce + ":" + publicKey;
}

async function verifyProof(store: DurableStore, deviceId: unknown, nonce: unknown, proof: unknown):
  Promise<{ device: V2Device; record: NonceRecord } | null> {
  if (!isId(deviceId) || typeof nonce !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(nonce) ||
      typeof proof !== "string") return null;
  const sig = decode64(proof);
  if (!sig) return null;
  const [device, record] = await Promise.all([
    store.get<V2Device>("device:" + deviceId),
    store.get<NonceRecord>(nonceKey(deviceId)),
  ]);
  if (!deviceIsAuthorized(device) || !record ||
      record.expires_at <= Date.now() || record.nonce !== nonce) return null;
  try {
    const der = Uint8Array.from(atob(device.public_key), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(der).buffer as ArrayBuffer,
      { name: "Ed25519" }, false, ["verify"]);
    const signature = Uint8Array.from(sig).buffer as ArrayBuffer;
    const content = Uint8Array.from(te.encode(sessionTranscript(deviceId, nonce, device.public_key))).buffer as ArrayBuffer;
    if (!await crypto.subtle.verify("Ed25519", key, signature, content)) return null;
    return { device, record };
  } catch { return null; }
}

/**
 * A signed nonce may be used either to recover a device ID or to activate a
 * socket. For sockets, the new fencing epoch MUST be committed in the very
 * same transaction as consuming the nonce and rechecking the device record.
 */
async function consumeAuthorizedProof(
  store: DurableStore, body: unknown, activateSocket: boolean,
): Promise<{ device_id: string; epoch?: string } | null> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const p = body as Record<string, unknown>;
  const verified = await verifyProof(store, p.device_id, p.nonce, p.proof);
  if (!verified) return null;
  const epoch = activateSocket ? crypto.randomUUID() : undefined;
  const success = await store.transaction(async tx => {
    const [nonce, current] = await Promise.all([
      tx.get<NonceRecord>(nonceKey(verified.device.device_id)),
      tx.get<V2Device>("device:" + verified.device.device_id),
    ]);
    if (!nonce || nonce.nonce !== verified.record.nonce || nonce.expires_at <= Date.now() ||
        !deviceIsAuthorized(current) || current.public_key !== verified.device.public_key) return false;
    await tx.delete(nonceKey(verified.device.device_id));
    if (epoch) await tx.put("session:epoch:" + verified.device.device_id, epoch);
    return true;
  });
  return success ? { device_id: verified.device.device_id, ...(epoch ? { epoch } : {}) } : null;
}

/** Identity recovery verifies a key but does NOT displace an existing socket. */
export async function authorizeSession(store: DurableStore, body: unknown):
  Promise<{ status: number; body: object }> {
  const result = await consumeAuthorizedProof(store, body, false);
  return result
    ? { status: 200, body: { device_id: result.device_id, status: "verified" } }
    : { status: 401, body: { error: "unauthorized" } };
}

/** A socket's epoch and proof consumption are an inseparable durable commit. */
export async function authorizeSocketSession(store: DurableStore, body: unknown):
  Promise<{ device_id: string; epoch: string } | null> {
  const result = await consumeAuthorizedProof(store, body, true);
  return result?.epoch ? { device_id: result.device_id, epoch: result.epoch } : null;
}

/** WSS proof belongs in a protocol header, not URL query strings or logs. */
export function readWebSocketProof(request: Request): { device_id: string; nonce: string; proof: string } | null {
  const url = new URL(request.url);
  const device_id = url.pathname.startsWith("/ws/") ? url.pathname.slice(4) : "";
  const offered = (request.headers.get("sec-websocket-protocol") || "").split(",").map(x => x.trim());
  if (!isId(device_id) || offered[0] !== "rc-v2" || offered.length !== 2) return null;
  const match = /^rcv2\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{86})$/.exec(offered[1] || "");
  return match ? { device_id, nonce: match[1]!, proof: match[2]! } : null;
}

export async function acceptAuthenticatedSocket(
  store: DurableStore, state: DurableObjectState, request: Request,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Upgrade required.", { status: 426 });
  }
  const proof = readWebSocketProof(request);
  if (!proof) return new Response("Unauthorized.", { status: 401 });
  const auth = await authorizeSocketSession(store, proof);
  if (!auth) return new Response("Unauthorized.", { status: 401 });
  // Another signed connection, or a revocation, could have committed after
  // this request's transaction completed. Recheck before accepting the socket.
  // There are NO awaits between this read and acceptWebSocket, so the older
  // login cannot attach after a newer epoch has superseded it.
  const [currentEpoch, currentDevice] = await Promise.all([
    store.get<string>("session:epoch:" + auth.device_id),
    store.get<V2Device>("device:" + auth.device_id),
  ]);
  if (currentEpoch !== auth.epoch || !deviceIsAuthorized(currentDevice)) {
    return new Response("Unauthorized.", { status: 401 });
  }
  // Only the most recently committed signed session remains authorized.
  const older = state.getWebSockets("device:" + auth.device_id);
  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  try {
    state.acceptWebSocket(server, ["device:" + proof.device_id]);
    server.serializeAttachment({ device_id: auth.device_id, epoch: auth.epoch, last_auth_check_at: Date.now() });
  } catch {
    // An accepted socket without a persisted Hibernation identity must never
    // remain live. Refuse the HTTP upgrade and close any accepted half with a
    // retryable internal-error code, without revealing the underlying failure.
    try { server.close(1011, "authorization unavailable"); } catch { /* not accepted or already closed */ }
    return new Response("Service unavailable.", { status: 503 });
  }
  for (const socket of older) {
    try { socket.close(1000, "superseded"); } catch { /* already closed */ }
  }
  return new Response(null, { status: 101, webSocket: client, headers: {
    "sec-websocket-protocol": "rc-v2",
  } });
}


/** Accept only bounded metadata from the currently authenticated signed socket. */
export async function handleDeviceInfoMessage(
  state: DurableObjectState, socket: WebSocket, message: string | ArrayBuffer,
): Promise<boolean> {
  if (typeof message !== "string" || !message.includes('"kind":"device_info"')) return false;
  const info = message.length <= 1200 ? parseDeviceInfo(message) : null;
  if (!info) { socket.close(1008, "invalid device info"); return true; }
  try {
    const attached = socket.deserializeAttachment() as {
      device_id?: unknown; epoch?: unknown; last_auth_check_at?: unknown; device_info_reported?: unknown;
    } | null;
    if (!attached || !isId(attached.device_id) || typeof attached.epoch !== "string" ||
        attached.device_info_reported === true || socket.readyState !== WebSocket.OPEN) {
      socket.close(1008, "invalid session");
      return true;
    }
    const stored = await state.storage.transaction(async tx => {
      const [device, epoch] = await Promise.all([
        tx.get<V2Device>("device:" + attached.device_id),
        tx.get<string>("session:epoch:" + attached.device_id),
      ]);
      if (!deviceIsAuthorized(device) || epoch !== attached.epoch) return false;
      await tx.put("device:" + attached.device_id, {
        ...device, device_info: info, device_info_epoch: attached.epoch, last_seen: Date.now(),
      } satisfies V2Device);
      return true;
    });
    if (!stored) { socket.close(1008, "revoked"); return true; }
    socket.serializeAttachment({ ...attached, device_info_reported: true });
  } catch {
    try { socket.close(1011, "metadata unavailable"); } catch { /* already closed */ }
  }
  return true;
}

const AUTH_PROBE = /^rc-v2:auth:([a-f0-9]{32})$/;
const AUTH_PROBE_MIN_INTERVAL_MS = 30_000;

export async function handleIdleSocketMessage(state: DurableObjectState, socket: WebSocket, message: string | ArrayBuffer):
  Promise<void> {
  // T04 has NO remote tool execution capability. Reject binary/unknown frames
  // *before* deserializing state or paying for durable device/epoch reads.
  const probe = typeof message === "string" ? AUTH_PROBE.exec(message) : null;
  if (!probe) {
    socket.close(1008, "no remote operations enabled");
    return;
  }
  let attachment: { device_id?: unknown; epoch?: unknown; last_auth_check_at?: unknown } | null;
  try {
    attachment = socket.deserializeAttachment() as typeof attachment;
  } catch {
    try { socket.close(1011, "authorization unavailable"); } catch { /* already closed */ }
    return;
  }
  if (!attachment || !isId(attachment.device_id) || typeof attachment.epoch !== "string") {
    socket.close(1008, "invalid session");
    return;
  }
  // The Agent sends an authorization probe every 15 minutes. Persist a tiny
  // per-socket rate gate in the Hibernation attachment so a compromised Agent
  // cannot repeatedly wake the DO and charge storage reads on every message.
  // Record before yielding for storage I/O to also reject concurrent probes.
  const now = Date.now();
  if (typeof attachment.last_auth_check_at === "number" &&
      now - attachment.last_auth_check_at < AUTH_PROBE_MIN_INTERVAL_MS) {
    socket.close(1008, "authorization rate limited");
    return;
  }
  try {
    socket.serializeAttachment({ ...attachment, last_auth_check_at: now });
    const [device, epoch] = await Promise.all([
      state.storage.get<V2Device>("device:" + attachment.device_id),
      state.storage.get<string>("session:epoch:" + attachment.device_id),
    ]);
    if (!deviceIsAuthorized(device) || epoch !== attachment.epoch) {
      socket.close(1008, "revoked");
      return;
    }
    // Transport pongs are not authorization. Only a persisted current device
    // and current session epoch can answer this specifically tagged probe.
    socket.send("rc-v2:auth-ok:" + probe[1]);
  } catch {
    // Temporary storage/socket failure is NOT a successful authorization.
    // 1011 permits the Agent's bounded fresh-nonce recovery, unlike a
    // permanent 1008 policy rejection. Never expose internal error details.
    try { socket.close(1011, "authorization unavailable"); } catch { /* socket already closed */ }
  }
}

// The Agent sends a persisted auth check every 15 min. A blackholed TCP/WebSocket
// can remain OPEN at Cloudflare long after its Agent has disconnected. Bound the
// observable status without waking a hibernating DO or adding a timer.
const ONLINE_AUTH_LEASE_MS = 16 * 60_000;

/** Bounded, observational device status. No heartbeat, session mutation or secret disclosure. */
export async function listApprovedDevices(state: DurableObjectState):
  Promise<{ status: number; body: object }> {
  const grants = await listLiveGrants(state.storage);
  if (!grants.complete || grants.active.size > 64) return { status: 503, body: { error: "capacity" } };
  const stored = grants.active;
  const devices: Array<{ device_id: string; name: string; status: "online" | "offline"; expires_at?: number; display_name?: string; name_ambiguous?: boolean; device_info?: DeviceInfo; last_seen?: number; capabilities?: DeviceInfo["capabilities"] }> = [];
  for (const [key, device] of stored) {
    if (!device || !isId(device.device_id) || key !== "device:" + device.device_id ||
        typeof device.name !== "string" || typeof device.revoked !== "boolean") continue;
    if (!deviceIsAuthorized(device)) continue; // Deleted/expired/legacy revoked rows are never selectable.
    let online = false;
    let infoCurrent = false;
    const now = Date.now();
    // Socket attachments can survive DO Hibernation, while JS Map state cannot.
    // A socket alone does not establish current authority: check its stored epoch.
    const sockets = state.getWebSockets?.("device:" + device.device_id) ?? [];
    if (sockets.length) {
      const currentEpoch = await state.storage.get<string>("session:epoch:" + device.device_id);
      for (const socket of sockets) {
        try {
          const attachment = socket.deserializeAttachment() as {
              device_id?: unknown; epoch?: unknown; last_auth_check_at?: unknown;
            } | null;
          const age = now - Number(attachment?.last_auth_check_at);
          if (socket.readyState === WebSocket.OPEN && currentEpoch &&
              typeof attachment?.last_auth_check_at === "number" &&
              Number.isFinite(age) && age >= 0 && age < ONLINE_AUTH_LEASE_MS &&
              attachment.device_id === device.device_id && attachment.epoch === currentEpoch) {
            online = true;
            infoCurrent = device.device_info_epoch === currentEpoch;
            break;
          }
        } catch { /* Corrupt or unavailable socket is never considered online. */ }
      }
    }
    devices.push({ device_id: device.device_id, name: device.name,
      status: online ? "online" : "offline",
      ...(device.grant_type === "temporary" ? { expires_at: device.expires_at } : {}),
      ...(device.device_info ? { device_info: device.device_info } : {}),
      ...(Number.isSafeInteger(device.last_seen) ? { last_seen: device.last_seen } : {}),
      ...(online && infoCurrent && device.device_info ? { capabilities: device.device_info.capabilities } : {}) });
  }
  // Keep the original label and full UUID intact. Duplicate labels get a hint,
  // but a caller must still use the full device_id for remote operations.
  const labelCounts = new Map<string, number>();
  for (const device of devices) labelCounts.set(device.name, (labelCounts.get(device.name) ?? 0) + 1);
  for (const device of devices) {
    if ((labelCounts.get(device.name) ?? 0) > 1) {
      const platform = device.device_info ? ` · ${device.device_info.os}/${device.device_info.environment}` : "";
      device.display_name = `${device.name}${platform} (${device.device_id.slice(0, 8)})`;
      device.name_ambiguous = true;
    }
  }
  devices.sort((a, b) => a.device_id.localeCompare(b.device_id));
  return { status: 200, body: devices };
}
