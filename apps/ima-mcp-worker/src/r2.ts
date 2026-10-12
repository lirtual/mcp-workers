import type { Env } from "./types.ts";

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

/**
 * Build the public download URL for an exported R2 object.
 *
 * R2_PUBLIC_BASE_URL is intentionally a normal Worker variable so deployments can
 * use different R2 custom domains without changing source code. The R2 custom
 * domain serves the object directly; the Worker is not in the download path.
 */
export async function buildDownloadUrl(env: Env, key: string): Promise<string> {
  const baseUrl = (env as Env & { R2_PUBLIC_BASE_URL?: string }).R2_PUBLIC_BASE_URL?.trim();
  if (!baseUrl) throw new Error("R2_PUBLIC_BASE_URL is not configured");
  if (!key.startsWith("exports/")) throw new Error("Only exported objects can receive download URLs");

  const base = baseUrl.replace(/\/+$/, "");
  const encodedPath = key.split("/").map(segment => encodeURIComponent(segment)).join("/");
  return `${base}/${encodedPath}`;
}

export function buildContentDisposition(fileName: string): string {
  const safeAscii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encodedUtf8 = encodeURIComponent(fileName);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}
