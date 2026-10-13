import { ImaApiError } from "./types.ts";
import { readBoundedText } from "./stream.ts";

const LITTERBOX_API = "https://litterbox.catbox.moe/resources/internals/api.php";
export const TEMP_UPLOAD_RETENTION = "24h" as const;
export const MAX_TEMP_UPLOAD_BYTES = 32 * 1024 * 1024;

export function sanitizeFileName(rawName?: string | null, fallbackExt?: string): string {
  let name = (rawName || "").trim().replace(/[\x00-\x1f\x7f]/g, "");
  const parts = name.split(/[\\/]/).filter(part => part && part !== "." && part !== "..");
  name = (parts.pop() || "").replace(/^[.\s]+|[.\s]+$/g, "") || "exported_file";
  if (fallbackExt) {
    const ext = fallbackExt.replace(/^\./, "").toLowerCase();
    if (ext && !name.toLowerCase().endsWith(`.${ext}`)) name += `.${ext}`;
  }
  return name;
}

export async function uploadTemporaryFile(
  fileName: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<string> {
  if (bytes.byteLength > MAX_TEMP_UPLOAD_BYTES) {
    throw new ImaApiError("临时文件超过 Worker 上传上限 32 MiB", 110013);
  }
  const form = new FormData();
  form.set("reqtype", "fileupload");
  form.set("time", TEMP_UPLOAD_RETENTION);
  form.set("fileToUpload", new File([new Uint8Array(bytes)], sanitizeFileName(fileName), { type: contentType }));

  let response: Response;
  try {
    response = await fetch(LITTERBOX_API, {
      method: "POST",
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new ImaApiError("Litterbox 临时上传连接失败或超时", 110010);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImaApiError(`Litterbox 临时上传失败 HTTP ${response.status}`, 110010);
  }
  let result: string;
  try {
    result = (await readBoundedText(response, 2048)).trim();
  } catch {
    throw new ImaApiError("Litterbox 上传响应过大", 110010);
  }
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new ImaApiError("Litterbox 未返回有效下载链接", 110010);
  }
  if (url.protocol !== "https:" || !["litter.catbox.moe", "litterbox.catbox.moe"].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/[a-zA-Z0-9_.-]+$/.test(url.pathname) || url.href !== result) {
    throw new ImaApiError("Litterbox 返回了非预期下载链接", 110010);
  }
  return url.href;
}
