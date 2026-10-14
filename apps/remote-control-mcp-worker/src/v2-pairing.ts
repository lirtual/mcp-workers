/** v2 pending enrollment only. No connection or remote-command permission exists here. */
const PAIRING_DOMAIN = "remote-control:v2:pending:";
const MAX_BOOTSTRAP_BODY = 4096;
const MAX_PENDING = 24;
const TTL_MS = 600_000;
const te = new TextEncoder();

export interface PendingDevice {
  name: string;
  public_key: string;
  fingerprint: string;
  expires_at: number;
  created_at: number;
}

type PendingStorage = Pick<DurableObjectStorage, "get" | "put" | "list" | "delete" | "transaction">;
type Registration = { name: string; public_key: string; code_verifier: string; proof: string };

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
      p.public_key.length > 96 || typeof p.proof !== "string" || p.proof.length > 128) return null;
  try {
    const keyBytes = asBytes(p.public_key);
    if (keyBytes.byteLength !== 44) return null; // DER SPKI wrapper of Ed25519 key.
    const signature = asBytes(p.proof);
    if (signature.length !== 64) return null;
    const key = await crypto.subtle.importKey("spki", Uint8Array.from(keyBytes).buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
    const challenge = te.encode(PAIRING_DOMAIN + p.code_verifier + ":" + p.public_key + ":" + p.name);
    const ok = await crypto.subtle.verify("Ed25519", key, Uint8Array.from(signature).buffer as ArrayBuffer, Uint8Array.from(challenge).buffer as ArrayBuffer);
    if (!ok) return null;
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(keyBytes).buffer as ArrayBuffer);
    const fingerprint = [...new Uint8Array(digest)].slice(0, 12).map((c) => c.toString(16).padStart(2, "0")).join("");
    const time = Date.now();
    return {
      verifier: p.code_verifier,
      record: { name: p.name, public_key: p.public_key, fingerprint, expires_at: time + TTL_MS, created_at: time },
    };
  } catch {
    return null;
  }
}

export async function registerPending(storage: PendingStorage, payload: unknown): Promise<{ status: number; body: object }> {
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
    if (existing.has(key)) return { status: 409, body: { error: "already_pending" } };
    await txn.put(key, verified.record);
    return { status: 202, body: { status: "pending", expires_at: verified.record.expires_at } };
  });
}

export async function lookupPending(storage: PendingStorage, verifier: string): Promise<{ status: number; body: object }> {
  if (!/^[a-f0-9]{64}$/.test(verifier)) return { status: 400, body: { error: "invalid_code" } };
  const record = await storage.get<PendingDevice>("pending:" + verifier);
  if (!record || record.expires_at <= Date.now()) return { status: 404, body: { error: "not_found" } };
  // Public key only appears as an immutable fingerprint to the authenticated MCP owner.
  return { status: 200, body: { pairing_id: verifier, name: record.name, fingerprint: record.fingerprint, expires_at: record.expires_at } };
}

async function limitedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BOOTSTRAP_BODY) throw new Error("oversize");
  if (!request.body) throw new Error("missing");
  const reader = request.body.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BOOTSTRAP_BODY) throw new Error("oversize");
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
  constructor(state: DurableObjectState) { this.state = state; }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (path !== "/register" && path !== "/lookup") return new Response(null, { status: 404 });
    let payload: unknown;
    try { payload = await limitedJson(request); } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    try {
      const output = path === "/register"
        ? await registerPending(this.state.storage, payload)
        : await lookupPending(this.state.storage, (payload as { verifier?: unknown })?.verifier as string);
      return Response.json(output.body, { status: output.status, headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
  }
}
