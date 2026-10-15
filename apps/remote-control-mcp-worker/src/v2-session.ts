/** Authentication-only v2 WSS. This module never dispatches remote tools. */
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
    const devices = await store.list<V2Device>({ prefix: "device:", limit: 65 });
    if (devices.size > 64) return { status: 503, body: { error: "capacity" } };
    device = [...devices.values()].find(d => d.public_key === public_key);
  }
  if (!device || device.revoked !== false) return { status: 404, body: { error: "not_found" } };
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
  if (!device || device.revoked !== false || !record ||
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

export async function authorizeSession(store: DurableStore, body: unknown):
  Promise<{ status: number; body: object }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const p = body as Record<string, unknown>;
  const verified = await verifyProof(store, p.device_id, p.nonce, p.proof);
  if (!verified) return { status: 401, body: { error: "unauthorized" } };
  // The nonce and approval must be re-checked inside the same DO transaction.
  const success = await store.transaction(async tx => {
    const [nonce, current] = await Promise.all([
      tx.get<NonceRecord>(nonceKey(verified.device.device_id)),
      tx.get<V2Device>("device:" + verified.device.device_id),
    ]);
    if (!nonce || nonce.nonce !== verified.record.nonce || nonce.expires_at <= Date.now() ||
        !current || current.revoked !== false || current.public_key !== verified.device.public_key) return false;
    await tx.delete(nonceKey(verified.device.device_id));
    return true;
  });
  return success
    ? { status: 200, body: { device_id: verified.device.device_id, status: "verified" } }
    : { status: 401, body: { error: "unauthorized" } };
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
  const auth = await authorizeSession(store, proof);
  if (auth.status !== 200) return new Response("Unauthorized.", { status: 401 });
  // A newly established socket fences existing connections for the same device;
  // only one currently authenticated idle socket per device is permitted.
  const older = state.getWebSockets("device:" + proof.device_id);
  // Durable epoch fences old sessions even when network close frames are delayed.
  const epoch = crypto.randomUUID();
  const currentDevice = await store.get<V2Device>("device:" + proof.device_id);
  if (!currentDevice || currentDevice.revoked !== false) return new Response("Unauthorized.", { status: 401 });
  await store.put("session:epoch:" + proof.device_id, epoch);
  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  state.acceptWebSocket(server, ["device:" + proof.device_id]);
  server.serializeAttachment({ device_id: proof.device_id, epoch });
  for (const socket of older) {
    try { socket.close(1000, "superseded"); } catch { /* already closed */ }
  }
  return new Response(null, { status: 101, webSocket: client, headers: {
    "sec-websocket-protocol": "rc-v2",
  } });
}

export async function handleIdleSocketMessage(state: DurableObjectState, socket: WebSocket, message: string | ArrayBuffer):
  Promise<void> {
  // T04 has NO tool execution capability. Even authenticated sockets never dispatch commands.
  const attachment = socket.deserializeAttachment() as { device_id?: unknown; epoch?: unknown } | null;
  if (!attachment || !isId(attachment.device_id) || typeof attachment.epoch !== "string") {
    socket.close(1008, "invalid session");
    return;
  }
  const [device, epoch] = await Promise.all([
    state.storage.get<V2Device>("device:" + attachment.device_id),
    state.storage.get<string>("session:epoch:" + attachment.device_id),
  ]);
  if (!device || device.revoked !== false || epoch !== attachment.epoch) {
    socket.close(1008, "revoked");
    return;
  }
  socket.close(1008, "no remote operations enabled");
}
