import type { Env, ImaCredentials, GetMediaInfoResponse } from "./types.ts";
import { ImaApiError } from "./types.ts";
import { readBoundedText } from "./stream.ts";

const IMA_NOTE_IMAGE_HOST = "ima-notebook-prod.image.myqcloud.com";
const EXPIRY_MARGIN_SECONDS = 60;
const RATE_LIMIT_INITIAL_BACKOFF_MS = 500;
const MAX_RESIGN_ATTEMPTS = 3;
const DEFAULT_IMA_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const IMA_MARKDOWN_IMAGE_PATTERN = /(!\[[^\]]*\]\(\s*)(https:\/\/ima-notebook-prod\.image\.myqcloud\.com\/[^\s)]+)([^)]*\))/g;

export const MAX_IMAGE_REFRESH_BATCH_SIZE = 9;

export type ImageRefreshWorkItem = {
  sourceUrl: string;
  mediaId: string;
  mode: "refresh" | "probe";
};

export type ImageRefreshBatchRequest = {
  credentials: ImaCredentials;
  items: ImageRefreshWorkItem[];
};

export type ImageRefreshBatchResult = {
  sourceUrl: string;
  freshUrl?: string;
  preserved: boolean;
};

type ImaApi = {
  env: Env;
  credentials: ImaCredentials;
  post<T>(path: string, body: unknown): Promise<T>;
};

type CloudImageRef = {
  mediaId: string;
  cosKey: string;
};

export async function refreshExpiredImaImageUrls(
  api: ImaApi,
  noteId: string,
  markdown: string
): Promise<string> {
  const imageUrls = [...new Set(extractImaMarkdownImageUrls(markdown))];
  if (imageUrls.length === 0) return markdown;

  const pending = imageUrls.flatMap<ImageRefreshWorkItem>((sourceUrl) => {
    const signEnd = parseSignEnd(sourceUrl);
    if (signEnd !== undefined && signEnd > Math.floor(Date.now() / 1000) + EXPIRY_MARGIN_SECONDS) {
      return [];
    }
    return [{ sourceUrl, mediaId: "", mode: signEnd === undefined ? "probe" : "refresh" }];
  });
  if (pending.length === 0) return markdown;

  const format2 = await api.post<{ content?: unknown }>("openapi/note/v1/get_doc_content", {
    note_id: noteId,
    target_content_format: 2,
  });
  const mediaByCosKey = collectCloudImageRefs(format2?.content);

  const workItems = pending.map((item) => {
    const expectedPath = new URL(item.sourceUrl).pathname;
    const mediaId = mediaByCosKey.get(expectedPath);
    if (!mediaId) {
      throw new ImaApiError(`IMA 图片重签失败：format=2 未找到 ${expectedPath} 对应的 mediaId`, 110011);
    }
    return { ...item, mediaId };
  });

  const namespace = api.env.IMA_IMAGE_REFRESH_SHARD;
  if (!namespace) {
    throw new ImaApiError("IMA 图片重签失败：Durable Object binding 未配置", 110012);
  }

  const replacements = new Map<string, string>();
  for (let start = 0; start < workItems.length; start += MAX_IMAGE_REFRESH_BATCH_SIZE) {
    const items = workItems.slice(start, start + MAX_IMAGE_REFRESH_BATCH_SIZE);
    const stub = namespace.get(namespace.newUniqueId());
    const results = await stub.processBatch({ credentials: api.credentials, items });
    mergeShardResults(items, results, replacements);
  }

  return replaceImaMarkdownImageUrls(markdown, replacements);
}

export async function processImageRefreshBatch(
  env: Env,
  credentials: ImaCredentials,
  items: ImageRefreshWorkItem[]
): Promise<ImageRefreshBatchResult[]> {
  if (items.length > MAX_IMAGE_REFRESH_BATCH_SIZE) {
    throw new ImaApiError(`IMA 图片重签批次过大：最多 ${MAX_IMAGE_REFRESH_BATCH_SIZE} 张`, 110013);
  }

  const results: ImageRefreshBatchResult[] = [];
  for (const item of items) {
    if (item.mode === "probe" && await headDirect(env, item.sourceUrl)) {
      results.push({ sourceUrl: item.sourceUrl, preserved: true });
      continue;
    }

    const expectedPath = new URL(item.sourceUrl).pathname;
    const freshUrl = await refreshMedia(env, credentials, item.mediaId, expectedPath);
    if (!(await headDirect(env, freshUrl))) {
      throw new ImaApiError(`IMA 图片重签失败：新签名 URL 无法访问 ${expectedPath}`, 110011);
    }
    results.push({ sourceUrl: item.sourceUrl, freshUrl, preserved: false });
  }
  return results;
}

function mergeShardResults(
  items: ImageRefreshWorkItem[],
  results: ImageRefreshBatchResult[],
  replacements: Map<string, string>
): void {
  const bySource = new Map<string, ImageRefreshBatchResult>();
  for (const result of results) {
    if (bySource.has(result.sourceUrl)) {
      throw new ImaApiError(`IMA 图片重签失败：shard 返回重复结果 ${new URL(result.sourceUrl).pathname}`, 110014);
    }
    bySource.set(result.sourceUrl, result);
  }
  if (results.length !== items.length || bySource.size !== items.length) {
    throw new ImaApiError("IMA 图片重签失败：shard 返回结果数量不完整", 110014);
  }

  for (const item of items) {
    const result = bySource.get(item.sourceUrl);
    if (!result) {
      throw new ImaApiError(`IMA 图片重签失败：shard 缺少 ${new URL(item.sourceUrl).pathname} 的结果`, 110014);
    }
    if (result.preserved) {
      if (item.mode !== "probe" || result.freshUrl) {
        throw new ImaApiError(`IMA 图片重签失败：shard 返回无效 preserve 结果 ${new URL(item.sourceUrl).pathname}`, 110014);
      }
      continue;
    }
    if (!result.freshUrl) {
      throw new ImaApiError(`IMA 图片重签失败：shard 未返回 ${new URL(item.sourceUrl).pathname} 的新 URL`, 110014);
    }
    replacements.set(item.sourceUrl, result.freshUrl);
  }
}

function extractImaMarkdownImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  for (const match of markdown.matchAll(IMA_MARKDOWN_IMAGE_PATTERN)) {
    if (match[2]) urls.push(match[2]);
  }
  return urls;
}

function replaceImaMarkdownImageUrls(markdown: string, replacements: Map<string, string>): string {
  return markdown.replace(IMA_MARKDOWN_IMAGE_PATTERN, (full, prefix: string, url: string, suffix: string) => {
    const freshUrl = replacements.get(url);
    return freshUrl ? `${prefix}${freshUrl}${suffix}` : full;
  });
}

async function headDirect(env: Env, rawUrl: string): Promise<boolean> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== IMA_NOTE_IMAGE_HOST) return false;
    const timeoutMs = Number(env.FILE_DOWNLOAD_TIMEOUT_MS || 30_000);
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

function parseSignEnd(rawUrl: string): number | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== IMA_NOTE_IMAGE_HOST) return undefined;
    const signTime = url.searchParams.get("q-sign-time");
    if (!signTime) return undefined;
    const [, endRaw] = signTime.split(";");
    const end = Number(endRaw);
    return Number.isSafeInteger(end) && end > 0 ? end : undefined;
  } catch {
    return undefined;
  }
}

function collectCloudImageRefs(rawContent: unknown): Map<string, string> {
  let root = rawContent;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      throw new ImaApiError("IMA 图片重签失败：format=2 返回的 content 不是有效 JSON", 110011);
    }
  }

  const refs = new Map<string, string>();
  visit(root, (value) => {
    if (value.type !== "cloud_image") return;
    if (typeof value.mediaId !== "string" || typeof value.cosKey !== "string") return;
    const ref: CloudImageRef = {
      mediaId: value.mediaId,
      cosKey: normalizeCosKey(value.cosKey),
    };
    refs.set(ref.cosKey, ref.mediaId);
  });
  return refs;
}

function visit(value: unknown, onObject: (value: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onObject);
    return;
  }
  const record = value as Record<string, unknown>;
  onObject(record);
  for (const child of Object.values(record)) visit(child, onObject);
}

function normalizeCosKey(cosKey: string): string {
  return cosKey.startsWith("/") ? cosKey : `/${cosKey}`;
}

async function refreshMedia(
  env: Env,
  credentials: ImaCredentials,
  mediaId: string,
  expectedPath: string
): Promise<string> {
  let data: GetMediaInfoResponse | undefined;

  for (let attempt = 0; attempt < MAX_RESIGN_ATTEMPTS; attempt++) {
    try {
      data = await getMediaInfo(env, credentials, mediaId);
      break;
    } catch (error) {
      const retryable = error instanceof ImaApiError && error.code === 200001;
      if (!retryable || attempt === MAX_RESIGN_ATTEMPTS - 1) throw error;
      await sleep(RATE_LIMIT_INITIAL_BACKOFF_MS * 2 ** attempt);
    }
  }

  const freshUrl = data?.url_info?.url;
  if (!freshUrl || !isFreshSignedUrl(freshUrl, expectedPath)) {
    throw new ImaApiError(`IMA 图片重签失败：get_media_info 未返回 ${expectedPath} 的可用新签名 URL`, 110011);
  }
  return freshUrl;
}

async function getMediaInfo(
  env: Env,
  credentials: ImaCredentials,
  mediaId: string
): Promise<GetMediaInfoResponse> {
  const base = (env.IMA_BASE_URL || "https://ima.qq.com").replace(/\/$/, "");
  const response = await fetch(`${base}/openapi/wiki/v1/get_media_info`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "ima-openapi-clientid": credentials.clientId,
      "ima-openapi-apikey": credentials.apiKey,
      "ima-openapi-ctx": "plugin_version=0.5.0",
    },
    body: JSON.stringify({ media_id: mediaId }),
  });

  const configuredLimit = Number(env.IMA_RESPONSE_MAX_BYTES || DEFAULT_IMA_RESPONSE_MAX_BYTES);
  const responseLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : DEFAULT_IMA_RESPONSE_MAX_BYTES;
  const text = await readBoundedText(response, responseLimit);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImaApiError(`IMA returned non-JSON HTTP ${response.status}`, response.status);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ImaApiError(`IMA returned invalid JSON envelope over HTTP ${response.status}`, response.status);
  }
  const envelope = parsed as Record<string, unknown>;
  if (!response.ok || envelope.code !== 0) {
    const code = !response.ok
      ? response.status
      : typeof envelope.code === "number" ? envelope.code : response.status;
    const msg = typeof envelope.msg === "string" ? envelope.msg : `IMA request failed: ${code}`;
    throw new ImaApiError(msg, code, parsed);
  }
  return envelope.data as GetMediaInfoResponse;
}

function isFreshSignedUrl(rawUrl: string, expectedPath: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== IMA_NOTE_IMAGE_HOST || url.pathname !== expectedPath) return false;
    const signEnd = parseSignEnd(rawUrl);
    return signEnd !== undefined && signEnd > Math.floor(Date.now() / 1000) + EXPIRY_MARGIN_SECONDS;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
