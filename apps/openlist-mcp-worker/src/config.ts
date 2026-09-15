import type { AppConfig, Env } from "./types";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}

export function loadConfig(env: Env): AppConfig {
  if (!env.OPENLIST_URL || !env.OPENLIST_TOKEN || !env.OPENLIST_ALLOWED_PATHS) {
    throw new Error("OPENLIST_URL, OPENLIST_TOKEN and OPENLIST_ALLOWED_PATHS are required");
  }
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required");
  }

  const openListUrl = new URL(env.OPENLIST_URL);
  if (openListUrl.protocol !== "https:") throw new Error("OPENLIST_URL must use HTTPS in production");

  const allowedPaths = env.OPENLIST_ALLOWED_PATHS.split(",").map((v) => v.trim()).filter(Boolean);
  if (allowedPaths.length === 0) throw new Error("OPENLIST_ALLOWED_PATHS must contain at least one path");

  return {
    openListUrl,
    allowedPaths,
    readonly: (env.OPENLIST_READONLY ?? "true").toLowerCase() !== "false",
    uploadMaxBytes: parsePositiveInt(env.OPENLIST_UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
    timeoutMs: parsePositiveInt(env.OPENLIST_TIMEOUT_MS, 15_000),
    accessTeamDomain: env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    accessAudience: env.CF_ACCESS_AUD,
  };
}
