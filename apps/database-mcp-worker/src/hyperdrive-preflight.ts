import { getRegistryConnection } from "./registry/store.js";
import { resolveHyperdriveConnection } from "./db/hyperdrive.js";
import { healthCheck } from "./db/index.js";
import {withDisabledHyperdriveProbeFence} from "./registry/inflight.js";
import type { Env } from "./types.js";

// Read-only, short-lived Owner Actions probe. D1 stays disabled until this has
// succeeded. The derivation separates HMAC usage from Direct AES-GCM encryption.
const encoder = new TextEncoder();
const MAX_SKEW_MS = 60_000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

async function proofKey(secret: string): Promise<CryptoKey> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(secret)) throw Error("key");
  const raw = Uint8Array.from(atob(secret), char => char.charCodeAt(0));
  if (raw.length !== 32) throw Error("key");
  const key = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: encoder.encode("database-mcp:preflight:salt:v1"),
    info: encoder.encode("database-mcp:hyperdrive-health:v1")
  }, key, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["verify"]);
}

export async function handleHyperdrivePreflight(request: Request, env: Env): Promise<Response> {
  const denied = () => Response.json({ error: "preflight_denied" }, {
    status: 403, headers: { "Cache-Control": "no-store" }
  });
  try {
    if (request.method !== "POST" || request.headers.get("content-type") !== "application/json" ||
        !env.DB || !env.DATABASE_ENCRYPTION_KEY) return denied();
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 256)) return denied();
    if (!request.body) return denied();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256) return denied();
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) return denied();
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "id,revision,timestamp" ||
        typeof record.id !== "string" || !idPattern.test(record.id) ||
        !Number.isSafeInteger(record.revision) || Number(record.revision) < 1 ||
        !Number.isSafeInteger(record.timestamp) ||
        Math.abs(Date.now() - Number(record.timestamp)) > MAX_SKEW_MS) return denied();
    const signature = request.headers.get("x-database-hyperdrive-proof");
    if (!signature || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return denied();
    const mac = Uint8Array.from(atob(signature.replaceAll("-", "+").replaceAll("_", "/") + "="), ch => ch.charCodeAt(0));
    const verified = await crypto.subtle.verify(
      "HMAC", await proofKey(env.DATABASE_ENCRYPTION_KEY), mac,
      encoder.encode(JSON.stringify({ id: record.id, revision: record.revision, timestamp: record.timestamp }))
    );
    if (!verified) return denied();
    const row = await getRegistryConnection(env.DB, record.id);
    if (!row || row.transport !== "hyperdrive" || row.status !== "disabled" ||
        row.revision !== record.revision) return denied();
    const connection = resolveHyperdriveConnection(env, row);
    const result = await withDisabledHyperdriveProbeFence(env,row.id,row.revision,()=>healthCheck(connection));
    if (result.ok !== true) return denied();
    return Response.json({ ok: true, connection: row.id, dialect: row.dialect, transport: row.transport,
      revision: row.revision }, { headers: { "Cache-Control": "no-store" } });
  } catch { return denied(); }
}
