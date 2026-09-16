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

function getPublicR2Origin(env: Env): string {
  const configured = env.R2_PUBLIC_BASE_URL?.trim();
  if (!configured) throw new Error("R2_PUBLIC_BASE_URL is not configured");

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("R2_PUBLIC_BASE_URL must be a valid HTTPS origin");
  }

  if (url.protocol !== "https:") {
    throw new Error("R2_PUBLIC_BASE_URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("R2_PUBLIC_BASE_URL must be an origin without credentials, path, query, or fragment");
  }

  return url.origin;
}

export async function buildDownloadUrl(env: Env, key: string): Promise<string> {
  if (!key.startsWith("exports/")) {
    throw new Error("Only exported objects can receive public R2 URLs");
  }
  const encodedKey = key.split("/").map(segment => encodeURIComponent(segment)).join("/");
  return `${getPublicR2Origin(env)}/${encodedKey}`;
}

export function buildContentDisposition(fileName: string): string {
  const safeAscii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encodedUtf8 = encodeURIComponent(fileName);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`;
}
