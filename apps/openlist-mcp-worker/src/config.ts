import type { AppConfig, Env } from "./types";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

export function loadConfig(env: Env): AppConfig {
  if (!env.OPENLIST_URL || !env.OPENLIST_TOKEN) {
    throw new Error("OPENLIST_URL and OPENLIST_TOKEN are required");
  }

  const openListUrl = new URL(env.OPENLIST_URL);
  if (openListUrl.protocol !== "https:") throw new Error("OPENLIST_URL must use HTTPS in production");

  const allowedPathsValue = env.OPENLIST_ALLOWED_PATHS?.trim() || "/";
  const allowedPaths = allowedPathsValue.split(",").map((v) => v.trim()).filter(Boolean);

  return {
    openListUrl,
    allowedPaths,
    readonly: (env.OPENLIST_READONLY ?? "true").toLowerCase() !== "false",
    uploadMaxBytes: parsePositiveInt(env.OPENLIST_UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
    timeoutMs: parsePositiveInt(env.OPENLIST_TIMEOUT_MS, 15_000),
  };
}
