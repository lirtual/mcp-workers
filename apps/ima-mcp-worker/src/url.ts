import { CONTENT_TYPE_MAP, MEDIA_TYPE_DEFAULT_EXT, SUPPORTED_FILE_EXTENSIONS } from "./preflight.ts";

export interface UrlClassification {
  url: string;
  scheme: string;
  isSafeHttps: boolean;
  type: "web" | "wechat" | "file_download" | "video_unsupported" | "local_unsupported" | "unsupported";
  reason?: string;
  suggestedAction?: "import_urls" | "upload_file" | "reject";
  inferredFileName?: string;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function contentDispositionFileName(value?: string | null): string | undefined {
  if (!value) return undefined;
  const match = value.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1].trim()).split(/[\\/]/).pop() || undefined;
  } catch {
    return undefined;
  }
}

export function inferRemoteFileName(rawUrl: string, contentType?: string, contentDisposition?: string | null): string {
  const fromDisposition = contentDispositionFileName(contentDisposition);
  if (fromDisposition) return fromDisposition;

  const pathName = (() => {
    try {
      const segment = new URL(rawUrl).pathname.split("/").filter(Boolean).pop();
      return segment ? decodeURIComponent(segment).split(/[\\/]/).pop() || "downloaded_file" : "downloaded_file";
    } catch {
      return "downloaded_file";
    }
  })();
  if (/\.[^.]+$/.test(pathName)) return pathName;

  const normalizedType = (contentType || "").split(";", 1)[0].trim().toLowerCase();
  const mediaType = CONTENT_TYPE_MAP[normalizedType];
  const ext = mediaType === undefined ? undefined : MEDIA_TYPE_DEFAULT_EXT[mediaType];
  return ext ? `${pathName}.${ext}` : pathName;
}

export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  return (
    h === "::1" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("fe8") ||
    h.startsWith("fe9") ||
    h.startsWith("fea") ||
    h.startsWith("feb")
  );
}

export function classifyUrl(raw: string, probeMetadata?: { contentType?: string; fileName?: string }): UrlClassification {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      url: raw,
      scheme: "",
      isSafeHttps: false,
      type: "unsupported",
      reason: "URL 格式解析失败",
      suggestedAction: "reject",
    };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme === "file:") {
    return {
      url: raw,
      scheme,
      isSafeHttps: false,
      type: "local_unsupported",
      reason: "不支持 file:// 协议，仅支持在 ima 桌面端内添加进知识库或通过公网 HTTPS 上传",
      suggestedAction: "reject",
    };
  }

  if (scheme !== "https:") {
    return {
      url: raw,
      scheme,
      isSafeHttps: false,
      type: "unsupported",
      reason: `不支持协议 ${scheme}，IMA 知识库仅支持安全的 https:// 链接`,
      suggestedAction: "reject",
    };
  }

  if (parsed.username || parsed.password) {
    return {
      url: raw,
      scheme,
      isSafeHttps: false,
      type: "unsupported",
      reason: "URL 中不可包含用户名或密码凭据",
      suggestedAction: "reject",
    };
  }

  if (isBlockedHost(parsed.hostname)) {
    return {
      url: raw,
      scheme,
      isSafeHttps: false,
      type: "unsupported",
      reason: "禁止访问内网或保留 IP 地址",
      suggestedAction: "reject",
    };
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // Video platform check
  if ((host === "www.bilibili.com" || host === "bilibili.com") && (path.startsWith("/video/") || path.startsWith("/video"))) {
    return {
      url: raw,
      scheme,
      isSafeHttps: true,
      type: "video_unsupported",
      reason: "Bilibili 视频链接仅支持在 ima 桌面端内添加进知识库",
      suggestedAction: "reject",
    };
  }

  if ((host === "www.youtube.com" || host === "youtube.com") && (path.startsWith("/watch") || path.startsWith("/shorts/"))) {
    return {
      url: raw,
      scheme,
      isSafeHttps: true,
      type: "video_unsupported",
      reason: "YouTube 视频链接仅支持在 ima 桌面端内添加进知识库",
      suggestedAction: "reject",
    };
  }

  // WeChat article
  if (host === "mp.weixin.qq.com" && (path.startsWith("/s/") || path === "/s" || parsed.searchParams.has("sn"))) {
    return {
      url: raw,
      scheme,
      isSafeHttps: true,
      type: "wechat",
      suggestedAction: "import_urls",
    };
  }

  // Check file extension by path using shared SUPPORTED_FILE_EXTENSIONS
  const lastDot = path.lastIndexOf(".");
  const pathExt = lastDot >= 0 ? path.slice(lastDot + 1).toLowerCase() : "";
  const isDirectFileByPath = SUPPORTED_FILE_EXTENSIONS.has(pathExt);

  if (
    isDirectFileByPath ||
    (host.includes("arxiv.org") && path.startsWith("/pdf/")) ||
    (host === "raw.githubusercontent.com" && pathExt && SUPPORTED_FILE_EXTENSIONS.has(pathExt))
  ) {
    const filename = probeMetadata?.fileName || path.split("/").pop() || "downloaded_file";
    return {
      url: raw,
      scheme,
      isSafeHttps: true,
      type: "file_download",
      reason: "该链接为可下载文件，请使用 upload_file_to_knowledge_base 工具进行上传",
      suggestedAction: "upload_file",
      inferredFileName: filename,
    };
  }

  // Check probed metadata if provided
  if (probeMetadata?.contentType) {
    const ct = probeMetadata.contentType.toLowerCase();
    if (CONTENT_TYPE_MAP[ct] !== undefined && !ct.includes("text/html")) {
      const filename = probeMetadata.fileName || path.split("/").pop() || "downloaded_file";
      return {
        url: raw,
        scheme,
        isSafeHttps: true,
        type: "file_download",
        reason: "探测到该链接返回直接下载文件，请使用 upload_file_to_knowledge_base 工具进行上传",
        suggestedAction: "upload_file",
        inferredFileName: filename,
      };
    }
  }

  return {
    url: raw,
    scheme,
    isSafeHttps: true,
    type: "web",
    suggestedAction: "import_urls",
  };
}

export async function fetchWithSafeRedirects(
  rawUrl: string,
  init: RequestInit = {},
  timeoutMs: number = 3000,
  maxRedirects: number = 5
): Promise<Response> {
  let current = rawUrl;
  let headers = new Headers(init.headers);

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const classification = classifyUrl(current);
    if (!classification.isSafeHttps || classification.suggestedAction === "reject") {
      throw new UnsafeUrlError(classification.reason || "禁止访问不安全 URL");
    }

    const response = await fetch(current, {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Redirect missing Location");
    if (redirects === maxRedirects) throw new Error("Too many redirects");

    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) headers = new Headers();
    current = next.toString();
  }

  throw new Error("Too many redirects");
}

export async function probeUrlMetadata(rawUrl: string, timeoutMs: number = 3000): Promise<{
  contentType?: string;
  fileName?: string;
}> {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" || isBlockedHost(u.hostname)) return {};
    const res = await fetchWithSafeRedirects(u.toString(), {
      method: "HEAD",
    }, timeoutMs);
    if (!res.ok) return {};
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const fileName = contentDispositionFileName(res.headers.get("content-disposition"));
    return { contentType: ct, fileName };
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw error;
    return {};
  }
}

export async function classifyUrlWithProbe(rawUrl: string, timeoutMs: number = 3000): Promise<UrlClassification> {
  const initial = classifyUrl(rawUrl);
  if (initial.type !== "web") return initial;

  // For generic web URLs with no extension, probe headers to detect extensionless downloadable files
  let probed: Awaited<ReturnType<typeof probeUrlMetadata>>;
  try {
    probed = await probeUrlMetadata(rawUrl, timeoutMs);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return {
        ...initial,
        isSafeHttps: false,
        type: "unsupported",
        reason: error.message,
        suggestedAction: "reject",
      };
    }
    throw error;
  }
  if (probed.contentType || probed.fileName) {
    return classifyUrl(rawUrl, probed);
  }
  return initial;
}
