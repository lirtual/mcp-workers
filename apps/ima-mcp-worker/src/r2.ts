import type { Env } from "./types.ts";

/**
 * Sanitizes a filename to prevent directory traversal and illegal characters
 * in R2 keys and Content-Disposition headers.
 */
export function sanitizeFileName(rawName?: string | null, fallbackExt?: string): string {
  let name = (rawName || "").trim();
  // Strip null bytes and control characters
  name = name.replace(/[\x00-\x1f\x7f]/g, "");
  // Take last path component if path separators exist to eliminate directory traversal
  const segments = name.split(/[\\/]/).filter(s => s && s !== "." && s !== "..");
  name = segments.pop() || "";
  // Remove leading/trailing dots and spaces
  name = name.replace(/^[.\s]+|[.\s]+$/g, "");

  if (!name) {
    name = "exported_file";
  }

  if (fallbackExt) {
    const cleanExt = fallbackExt.replace(/^\./, "").toLowerCase();
    if (cleanExt && !name.toLowerCase().endsWith(`.${cleanExt}`)) {
      name = `${name}.${cleanExt}`;
    }
  }

  return name;
}

/**
 * Constructs a unique, predictable R2 object key.
 */
export function buildR2Key(prefix: "media" | "notes", id: string, fileName: string): string {
  const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanName = sanitizeFileName(fileName);
  return `exports/${prefix}/${cleanId}/${cleanName}`;
}

/**
 * Builds the download URL. If R2_CUSTOM_DOMAIN is set, returns the custom domain URL.
 * Otherwise, falls back to the Worker's own /download/:key route.
 */
export function buildDownloadUrl(env: Env, key: string, fallbackOrigin?: string): string {
  const cleanKey = key.replace(/^\//, "");
  const custom = env.R2_CUSTOM_DOMAIN?.trim();

  if (custom) {
    const base = custom.startsWith("http://") || custom.startsWith("https://")
      ? custom.replace(/\/+$/, "")
      : `https://${custom.replace(/\/+$/, "")}`;
    return `${base}/${cleanKey}`;
  }

  const base = (env.PUBLIC_BASE_URL || fallbackOrigin || "").replace(/\/+$/, "");
  return base ? `${base}/download/${cleanKey}` : `/download/${cleanKey}`;
}

/**
 * Formats a Content-Disposition header with RFC 5987 UTF-8 encoded filename support.
 */
export function buildContentDisposition(fileName: string): string {
  const safeAscii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encodedUtf8 = encodeURIComponent(fileName);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}
