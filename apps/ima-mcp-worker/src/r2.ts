import type { Env } from "./types.ts";

export const DEFAULT_DOWNLOAD_TTL_SECONDS = 60 * 60;
export const DEFAULT_EXPORT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export type DownloadSignatureResult =
  | { ok: true }
  | { ok: false; reason: "misconfigured" | "invalid" | "expired" };

export function sanitizeFileName(rawName?: string | null, fallbackExt?: string): string {
  let name = (rawName || "").trim();
  name = name.replace(/[\x00-\x1f\x7f]/g, "");
  const segments = name.split(/[\\/]/).filter(s => s && s !== "." && s !== "..");
  name = segments.pop() || "";
  name = name.replace(/^[.\s]+|[.\s]+$/g, "");

  if (!name) name = "exported_file";

  if (fallbackExt) {
    const cleanExt = fallbackExt.replace(/^\./, "").toLowerCase();
    if (cleanExt && !name.toLowerCase().endsWith(`.${cleanExt}`)) {
      name = `${name}.${cleanExt}`;
    }
  }

  return name;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function getExportRetentionPolicy(env: Env): { downloadTtlSeconds: number; retentionSeconds: number } {
  const downloadTtlSeconds = positiveInteger(
    env.IMA_DOWNLOAD_TTL_SECONDS,
    DEFAULT_DOWNLOAD_TTL_SECONDS,
    "IMA_DOWNLOAD_TTL_SECONDS",
  );
  const retentionSeconds = positiveInteger(
    env.IMA_EXPORT_RETENTION_SECONDS,
    DEFAULT_EXPORT_RETENTION_SECONDS,
    "IMA_EXPORT_RETENTION_SECONDS",
  );
  if (retentionSeconds < downloadTtlSeconds) {
    throw new Error("IMA_EXPORT_RETENTION_SECONDS must be greater than or equal to IMA_DOWNLOAD_TTL_SECONDS");
  }
  return { downloadTtlSeconds, retentionSeconds };
}

export function buildR2Key(
  prefix: "media" | "notes",
  id: string,
  fileName: string,
  exportId = crypto.randomUUID(),
): string {
  const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanExportId = exportId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanName = sanitizeFileName(fileName);
  return `exports/${prefix}/${cleanId}/${cleanExportId}/${cleanName}`;
}

function canonicalDownloadRequest(key: string, expires: number): string {
  return `v1\nGET\n${key}\n${expires}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signDownload(secret: string, key: string, expires: number): Promise<string> {
  const signingKey = await importSigningKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    new TextEncoder().encode(canonicalDownloadRequest(key, expires)),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function buildDownloadUrl(
  env: Env,
  key: string,
  fallbackOrigin?: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const secret = env.IMA_DOWNLOAD_SIGNING_KEY?.trim();
  if (!secret) throw new Error("IMA_DOWNLOAD_SIGNING_KEY is not configured");
  if (!key.startsWith("exports/")) throw new Error("Only exported objects can receive signed download URLs");

  const { downloadTtlSeconds } = getExportRetentionPolicy(env);
  const expiresAt = nowSeconds + downloadTtlSeconds;
  const signature = await signDownload(secret, key, expiresAt);
  const base = (env.PUBLIC_BASE_URL || fallbackOrigin || "").replace(/\/+$/, "");
  const path = `/download/${encodeURIComponent(key)}`;
  const query = `expires=${expiresAt}&sig=${encodeURIComponent(signature)}`;
  return base ? `${base}${path}?${query}` : `${path}?${query}`;
}

export async function verifySignedDownload(
  env: Env,
  key: string,
  expiresRaw: string | null,
  signatureRaw: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<DownloadSignatureResult> {
  const secret = env.IMA_DOWNLOAD_SIGNING_KEY?.trim();
  if (!secret) return { ok: false, reason: "misconfigured" };
  if (!key.startsWith("exports/")) return { ok: false, reason: "invalid" };
  if (!expiresRaw || !/^\d+$/.test(expiresRaw) || !signatureRaw) return { ok: false, reason: "invalid" };

  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return { ok: false, reason: "invalid" };
  if (expiresAt <= nowSeconds) return { ok: false, reason: "expired" };

  const signature = base64UrlDecode(signatureRaw);
  if (!signature) return { ok: false, reason: "invalid" };

  const signingKey = await importSigningKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    signingKey,
    signature,
    new TextEncoder().encode(canonicalDownloadRequest(key, expiresAt)),
  );
  return valid ? { ok: true } : { ok: false, reason: "invalid" };
}

export function buildContentDisposition(fileName: string): string {
  const safeAscii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encodedUtf8 = encodeURIComponent(fileName);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}
