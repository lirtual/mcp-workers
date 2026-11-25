/** Local physical owner intent, separate from the signed WSS protocol and MCP surface. */
import {
  deviceIsAuthorized, deviceStillGranted, migratePermanentGrant, permanentDeadline,
  PERMANENT_IDLE_MS, type V2Device,
} from "./v2-session.ts";
import { secureInputTargetBinding, validateSecureInputSecret, type SecureInputRecord } from "./v2-secure-input.ts";

type Store = Pick<DurableObjectStorage, "get" | "put" | "delete" | "transaction">;
type Action = "stop" | "resume" | "secure_input";
type Challenge = { action: Action; nonce: string; generation: number; expires_at: number; request_id?: string; target_binding?: string };
type CommitResult = { status: number; body: object; secureInput?: { record: SecureInputRecord; secret: string } };
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{24}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const keyFor = (id: string) => "owner:intent:nonce:" + id;
const permanent = (d: V2Device) => d.grant_type === undefined || d.grant_type === "permanent";
const gen = (d: V2Device) => d.owner_generation ?? 0;
const safe = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < Number.MAX_SAFE_INTEGER;
const reject = (status: number, error: string) => ({ status, body: { error } });

export function ownerIntentTranscript(action: "stop" | "resume", id: string, nonce: string, generation: number, publicKey: string): string {
  return "remote-control:v2:owner-intent:v1:" + action + ":" + id + ":" + generation + ":" + nonce + ":" + publicKey;
}
export function secureInputOwnerIntentTranscript(requestId: string, id: string, generation: number, binding: string, nonce: string, publicKey: string): string {
  return "remote-control:v2:secure-input-owner-intent:v1:" + requestId + ":" + id + ":" + generation + ":" + binding + ":" + nonce + ":" + publicKey;
}

export async function issueOwnerIntentChallenge(store: Store, input: unknown, idleMs = PERMANENT_IDLE_MS): Promise<{ status: number; body: object }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return reject(400, "bad_request");
  const p = input as Record<string, unknown>;
  if (p.action === "secure_input") {
    if (Object.keys(p).sort().join(",") !== "action,device_id,request_id" ||
        typeof p.device_id !== "string" || !ID.test(p.device_id) ||
        typeof p.request_id !== "string" || !ID.test(p.request_id)) return reject(400, "bad_request");
    const owner = await migratePermanentGrant(store, await store.get<V2Device>("device:" + p.device_id), Date.now(), idleMs);
    const request = await store.get<SecureInputRecord>("secure-input:" + p.request_id);
    if (!owner || !permanent(owner) || !deviceIsAuthorized(owner) || !safe(gen(owner)) ||
        !request || request.state !== "pending" || request.expires_at <= Date.now()) return reject(404, "not_found");
    const [target, epoch] = await Promise.all([
      store.get<V2Device>("device:" + request.execution.device_id),
      store.get<string>("session:epoch:" + request.execution.device_id),
    ]);
    if (!deviceIsAuthorized(target) || epoch !== request.execution.epoch ||
        await secureInputTargetBinding(request) !== request.target_binding) return reject(409, "target_changed");
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    const nonce = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const rec: Challenge = { nonce, action: "secure_input", request_id: request.request_id,
      target_binding: request.target_binding, generation: gen(owner), expires_at: Date.now() + 60_000 };
    await store.put(keyFor(owner.device_id), rec);
    return { status: 200, body: {
      action: rec.action, device_id: owner.device_id, request_id: request.request_id,
      nonce, generation: rec.generation, expires_at: rec.expires_at, target_binding: rec.target_binding,
      purpose: request.purpose, target: request.target,
      execution: {
        device_id: request.execution.device_id, grant_type: request.execution.grant_type,
        ...(request.execution.session_run_id ? { session_run_id: request.execution.session_run_id } : {}),
        ...(request.execution.session_run_attempt ? { session_run_attempt: request.execution.session_run_attempt } : {}),
        ...(request.execution.session_workflow_name ? { session_workflow_name: request.execution.session_workflow_name } : {}),
      },
      ...(request.provider_principal ? { provider_principal: request.provider_principal } : {}),
    } };
  }
  if (Object.keys(p).sort().join(",") !== "action,device_id" ||
      (p.action !== "stop" && p.action !== "resume") ||
      typeof p.device_id !== "string" || !ID.test(p.device_id)) return reject(400, "bad_request");
  const d = await migratePermanentGrant(store, await store.get<V2Device>("device:" + p.device_id), Date.now(), idleMs);
  if (!d || !permanent(d) || !deviceStillGranted(d) || !safe(gen(d))) return reject(404, "not_found");
  if (p.action === "resume" && d.owner_stopped !== true) return reject(409, "not_stopped");
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const rec: Challenge = { nonce, action: p.action, generation: gen(d), expires_at: Date.now() + 60_000 };
  await store.put(keyFor(d.device_id), rec);
  return { status: 200, body: { device_id: d.device_id, ...rec } };
}

async function validSignature(device: V2Device, rec: Challenge, proof: unknown): Promise<boolean> {
  if (typeof proof !== "string" || !SIG.test(proof)) return false;
  try {
    const der = Uint8Array.from(atob(device.public_key), c => c.charCodeAt(0));
    const sig = Uint8Array.from(atob(proof.replace(/-/g, "+").replace(/_/g, "/") + "=="), c => c.charCodeAt(0));
    if (sig.length !== 64) return false;
    const key = await crypto.subtle.importKey("spki", der.buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
    const transcript = rec.action === "secure_input"
      ? secureInputOwnerIntentTranscript(rec.request_id!, device.device_id, rec.generation, rec.target_binding!, rec.nonce, device.public_key)
      : ownerIntentTranscript(rec.action, device.device_id, rec.nonce, rec.generation, device.public_key);
    return crypto.subtle.verify("Ed25519", key, sig.buffer as ArrayBuffer,
      new TextEncoder().encode(transcript).buffer as ArrayBuffer);
  } catch { return false; }
}

async function commitSecureInputOwnerIntent(store: Store, p: Record<string, unknown>): Promise<CommitResult> {
  if (Object.keys(p).sort().join(",") !== "action,device_id,generation,nonce,proof,request_id,secret" ||
      p.action !== "secure_input" || typeof p.device_id !== "string" || !ID.test(p.device_id) ||
      typeof p.request_id !== "string" || !ID.test(p.request_id) ||
      typeof p.nonce !== "string" || !NONCE.test(p.nonce) || !safe(p.generation) ||
      !validateSecureInputSecret(p.secret)) return reject(400, "bad_request");
  const [device, challenge, request] = await Promise.all([
    store.get<V2Device>("device:" + p.device_id),
    store.get<Challenge>(keyFor(p.device_id)),
    store.get<SecureInputRecord>("secure-input:" + p.request_id),
  ]);
  if (!device || !permanent(device) || !deviceIsAuthorized(device) || !challenge ||
      challenge.action !== "secure_input" || challenge.request_id !== p.request_id ||
      challenge.nonce !== p.nonce || challenge.generation !== p.generation ||
      challenge.expires_at <= Date.now() || !request || request.state !== "pending" ||
      request.expires_at <= Date.now() || await secureInputTargetBinding(request) !== challenge.target_binding ||
      !await validSignature(device, challenge, p.proof)) return reject(401, "unauthorized");

  const secret = p.secret;
  const result = await store.transaction(async tx => {
    const [current, nonce, currentRequest] = await Promise.all([
      tx.get<V2Device>("device:" + device.device_id),
      tx.get<Challenge>(keyFor(device.device_id)),
      tx.get<SecureInputRecord>("secure-input:" + p.request_id),
    ]);
    const now = Date.now();
    if (!current || !permanent(current) || !deviceIsAuthorized(current, now) ||
        current.public_key !== device.public_key || gen(current) !== challenge.generation ||
        !nonce || nonce.action !== "secure_input" || nonce.request_id !== p.request_id ||
        nonce.nonce !== challenge.nonce || nonce.target_binding !== challenge.target_binding ||
        nonce.expires_at <= now || !currentRequest || currentRequest.state !== "pending" ||
        currentRequest.expires_at <= now || currentRequest.target_binding !== challenge.target_binding) {
      return reject(401, "unauthorized");
    }
    const [target, targetEpoch] = await Promise.all([
      tx.get<V2Device>("device:" + currentRequest.execution.device_id),
      tx.get<string>("session:epoch:" + currentRequest.execution.device_id),
    ]);
    if (!deviceIsAuthorized(target, now) || targetEpoch !== currentRequest.execution.epoch) {
      return reject(409, "target_changed");
    }
    const consumed: SecureInputRecord = {
      ...currentRequest, state: "unknown", consumed_at: now, updated_at: now,
    };
    await tx.put("secure-input:" + p.request_id, consumed);
    await tx.delete(keyFor(device.device_id));
    return { status: 200, body: { status: "unknown", request_id: p.request_id }, record: consumed };
  });
  if (result.status !== 200 || !("record" in result)) return result;
  return { status: 200, body: result.body, secureInput: { record: result.record, secret } };
}

/** Consume signed Stop/Resume or a request-bound Secure Input intent. */
export async function commitOwnerIntent(store: Store, input: unknown, idleMs = PERMANENT_IDLE_MS): Promise<CommitResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return reject(400, "bad_request");
  const p = input as Record<string, unknown>;
  if (p.action === "secure_input") return commitSecureInputOwnerIntent(store, p);
  if (Object.keys(p).sort().join(",") !== "action,device_id,generation,nonce,proof" ||
      (p.action !== "stop" && p.action !== "resume") ||
      typeof p.device_id !== "string" || !ID.test(p.device_id) ||
      typeof p.nonce !== "string" || !NONCE.test(p.nonce) || !safe(p.generation)) return reject(400, "bad_request");
  const [device, rec] = await Promise.all([
    store.get<V2Device>("device:" + p.device_id), store.get<Challenge>(keyFor(p.device_id)),
  ]);
  if (!device || !permanent(device) || !deviceStillGranted(device) || !rec ||
      rec.nonce !== p.nonce || rec.action !== p.action || rec.generation !== p.generation ||
      rec.expires_at <= Date.now() || !await validSignature(device, rec, p.proof)) return reject(401, "unauthorized");
  return store.transaction(async tx => {
    const [current, nonce] = await Promise.all([
      tx.get<V2Device>("device:" + device.device_id), tx.get<Challenge>(keyFor(device.device_id)),
    ]);
    const now = Date.now();
    if (!current || !permanent(current) || current.public_key !== device.public_key ||
        !deviceStillGranted(current, now) || gen(current) !== rec.generation ||
        !nonce || nonce.nonce !== rec.nonce || nonce.action !== rec.action || nonce.expires_at <= now) {
      return reject(401, "unauthorized");
    }
    await tx.delete(keyFor(device.device_id));
    if (rec.action === "stop") {
      const prior = permanentDeadline(current, now);
      const expiry = current.owner_stopped ? prior : Math.min(prior ?? now + idleMs, now + idleMs);
      if (!Number.isSafeInteger(expiry) || expiry! <= now) return reject(404, "expired");
      if (!current.owner_stopped) await tx.put("device:" + current.device_id, {
        ...current, owner_stopped: true, owner_resume_pending: false, owner_generation: rec.generation + 1,
        idle_expires_at: expiry, idle_window_ms: current.idle_window_ms ?? idleMs,
      } satisfies V2Device);
      await tx.delete("session:epoch:" + current.device_id);
      await tx.delete("session:nonce:" + current.device_id);
      return { status: 200, body: { status: "stopped", device_id: current.device_id, idle_expires_at: expiry } };
    }
    if (current.owner_stopped !== true) return reject(409, "not_stopped");
    const deadline = permanentDeadline(current, now);
    if (!Number.isSafeInteger(deadline) || deadline! <= now) return reject(404, "expired");
    await tx.put("device:" + current.device_id, {
      ...current, owner_stopped: false, owner_resume_pending: true, owner_generation: rec.generation + 1,
    } satisfies V2Device);
    await tx.delete("session:epoch:" + current.device_id);
    return { status: 200, body: { status: "resume_pending", device_id: current.device_id, idle_expires_at: deadline } };
  });
}
