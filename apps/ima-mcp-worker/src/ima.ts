import type {
  AddKnowledgeResponse,
  CheckRepeatedNamesResponse,
  CreateMediaResponse,
  Env,
  ExportFileResult,
  GetDocContentResponse,
  GetMediaInfoResponse,
  ImaCredentials,
  ImportUrlData,
  ImportUrlsResponse,
  ImportUrlsResultSummary,
  ListNotebookResponse,
  ListNoteResponse,
  NoteMutationResponse,
  SearchNoteResponse,
} from "./types.ts";
import { ImaApiError, MediaType } from "./types.ts";
import { hmacSha1Hex, sha1Hex } from "./crypto.ts";
import { classifyUrl, classifyUrlWithProbe, fetchWithSafeRedirects, inferRemoteFileName } from "./url.ts";
import { DEFAULT_SIZE_LIMIT, MEDIA_TYPE_DEFAULT_EXT, resolveUploadMetadata } from "./preflight.ts";
import { bufferToBase64, readBinaryChunk, readBoundedBuffer, readBoundedText } from "./stream.ts";
import { buildContentDisposition, buildDownloadUrl, buildR2Key, sanitizeFileName } from "./r2.ts";

export const DEFAULT_IMA_BASE_URL = "https://ima.qq.com";
export const DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const DEFAULT_FILE_DOWNLOAD_MAX_REDIRECTS = 5;
export const DEFAULT_FILE_DOWNLOAD_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const DEFAULT_IMA_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

export class ImaClient {
  env: Env;
  credentials: ImaCredentials;
  constructor(env: Env, credentials: ImaCredentials) {
    this.env = env;
    this.credentials = credentials;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    const base = (this.env.IMA_BASE_URL || DEFAULT_IMA_BASE_URL).replace(/\/$/, "");
    const response = await fetch(`${base}/${path.replace(/^\//, "")}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "ima-openapi-clientid": this.credentials.clientId,
        "ima-openapi-apikey": this.credentials.apiKey,
        "ima-openapi-ctx": "plugin_version=0.5.0",
      },
      body: JSON.stringify(body),
    });
    const configuredLimit = Number(this.env.IMA_RESPONSE_MAX_BYTES || DEFAULT_IMA_RESPONSE_MAX_BYTES);
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
      const code = typeof envelope.code === "number" ? envelope.code : response.status;
      const msg = typeof envelope.msg === "string" ? envelope.msg : `IMA request failed: ${code}`;
      throw new ImaApiError(msg, code, parsed);
    }
    return envelope.data as T;
  }
}

export class ImaNotes {
  api: ImaClient;
  constructor(api: ImaClient) {
    this.api = api;
  }
  search(a: { query: string; search_type?: 0 | 1; sort_type?: number; start?: number; end?: number }): Promise<SearchNoteResponse> {
    const search_type = a.search_type ?? 0;
    const query_info = search_type === 1 ? { content: a.query } : { title: a.query };
    const start = a.start ?? 0;
    const end = a.end ?? (start + 20);
    if (end <= start) throw new ImaApiError("Invalid pagination: end must be greater than start", 210001);
    if (end - start > 20) throw new ImaApiError("Invalid pagination: maximum page size 20", 210001);
    return this.api.post<SearchNoteResponse>("openapi/note/v1/search_note", {
      search_type,
      sort_type: a.sort_type ?? 0,
      query_info,
      start,
      end,
    });
  }
  list(a: { folder_id?: string; cursor?: string; limit?: number }): Promise<ListNoteResponse> {
    return this.api.post<ListNoteResponse>("openapi/note/v1/list_note", {
      ...(a.folder_id ? { folder_id: a.folder_id } : {}),
      sort_type: 0,
      cursor: a.cursor ?? "",
      limit: a.limit ?? 20,
    });
  }
  notebooks(a: { cursor?: string; limit?: number }): Promise<ListNotebookResponse> {
    return this.api.post<ListNotebookResponse>("openapi/note/v1/list_notebook", {
      cursor: a.cursor ?? "0",
      limit: a.limit ?? 20,
    });
  }
  async get(note_id: string, target_content_format: 0 | 1 | 2 = 1): Promise<GetDocContentResponse> {
    if (target_content_format !== 0 && target_content_format !== 1 && target_content_format !== 2) {
      throw new ImaApiError("Invalid target_content_format: must be 0, 1, or 2", 210001);
    }
    const res = await this.api.post<GetDocContentResponse>("openapi/note/v1/get_doc_content", {
      note_id,
      target_content_format,
    });
    if (target_content_format === 1 && typeof res?.content === "string") {
      return { ...res, content: unescapeMarkdownUrlAmpersands(res.content) };
    }
    return res;
  }
  async create(a: { content: string; folder_id?: string; folder_name?: string }): Promise<NoteMutationResponse> {
    const res = await this.api.post<NoteMutationResponse>("openapi/note/v1/import_doc", {
      content_format: 1,
      content: a.content,
      ...(a.folder_id ? { folder_id: a.folder_id } : {}),
      ...(a.folder_name ? { folder_name: a.folder_name } : {}),
    });
    if (!res?.note_id) throw new ImaApiError("IMA 未返回有效的 note_id", 210003);
    return res;
  }
  async append(note_id: string, content: string): Promise<NoteMutationResponse> {
    const res = await this.api.post<NoteMutationResponse>("openapi/note/v1/append_doc", {
      note_id,
      content_format: 1,
      content,
    });
    if (!res?.note_id) throw new ImaApiError("IMA 未返回有效的 note_id", 210003);
    return res;
  }
  async exportNote(note_id: string, options: { file_name?: string } = {}): Promise<ExportFileResult> {
    if (!this.api.env.R2_BUCKET) {
      throw new ImaApiError("R2 bucket 未配置，无法导出文件", 110002);
    }
    const cleanNoteId = (note_id || "").trim();
    if (!cleanNoteId) {
      throw new ImaApiError("note_id 不能为空", 110001);
    }
    const noteData = await this.get(cleanNoteId, 1);
    const content = noteData?.content ?? "";

    let derivedName = options.file_name?.trim();
    if (!derivedName) {
      const headerMatch = content.match(/^#+\s+([^\r\n]+)/m);
      if (headerMatch?.[1]) {
        derivedName = headerMatch[1].trim();
      } else {
        derivedName = `Note_${cleanNoteId}`;
      }
    }
    const fileName = sanitizeFileName(derivedName, "md");
    const key = buildR2Key("notes", cleanNoteId, fileName);
    const contentType = "text/markdown; charset=utf-8";
    const contentDisposition = buildContentDisposition(fileName);

    const encoder = new TextEncoder();
    const encodedBytes = encoder.encode(content);

    await this.api.env.R2_BUCKET.put(key, encodedBytes, {
      httpMetadata: {
        contentType,
        contentDisposition,
      },
      customMetadata: {
        note_id: cleanNoteId,
        exported_at: new Date().toISOString(),
      },
    });

    const download_url = buildDownloadUrl(this.api.env, key);
    return {
      download_url,
      file_name: fileName,
      file_size: encodedBytes.byteLength,
      content_type: contentType,
      note_id: cleanNoteId,
      key,
    };
  }
}

function unescapeMarkdownUrlAmpersands(content: string): string {
  return content.replace(/\\&/g, "&");
}

async function openFileStream(env: Env, raw: string, max = DEFAULT_SIZE_LIMIT) {
  let current = raw;
  const maxRedirects = Number(env.FILE_DOWNLOAD_MAX_REDIRECTS || DEFAULT_FILE_DOWNLOAD_MAX_REDIRECTS);
  for (let i = 0; i <= maxRedirects; i++) {
    const c = classifyUrl(current);
    if (!c.isSafeHttps || c.suggestedAction === "reject") {
      throw new Error(`Unsafe file URL: ${c.reason || "blocked"}`);
    }
    const u = new URL(current);
    const r = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(Number(env.FILE_DOWNLOAD_TIMEOUT_MS || DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS)),
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get("location");
      if (!loc) throw new Error("Redirect missing Location");
      await r.body?.cancel();
      current = new URL(loc, u).toString();
      continue;
    }
    if (!r.ok) throw new Error(`File download failed HTTP ${r.status}`);
    const lengthHeader = r.headers.get("content-length");
    let length = lengthHeader ? Number(lengthHeader) : 0;
    const contentType = r.headers.get("content-type") || undefined;
    const inferredFileName = inferRemoteFileName(current, contentType, r.headers.get("content-disposition"));

    if (Number.isSafeInteger(length) && length > 0) {
      if (length > max) {
        await r.body?.cancel();
        throw new Error(`File exceeds IMA size limit (${(max / (1024 * 1024)).toFixed(1)} MB)`);
      }
      if (!r.body) throw new Error("Remote file has no body");
      const source = r.body;
      return {
        source,
        length,
        contentType,
        inferredFileName,
        cancel: () => source.cancel("Upload stopped before COS transfer").catch(() => undefined),
      };
    }

    // A body without Content-Length must be buffered to sign the COS request.
    // Keep the buffer well below the Worker's 128 MB memory ceiling.
    const configuredBufferLimit = Number(env.FILE_DOWNLOAD_MAX_BUFFER_BYTES || DEFAULT_FILE_DOWNLOAD_MAX_BUFFER_BYTES);
    const safeBufferLimit = Number.isSafeInteger(configuredBufferLimit) && configuredBufferLimit > 0
      ? configuredBufferLimit
      : DEFAULT_FILE_DOWNLOAD_MAX_BUFFER_BYTES;
    const maxBuffer = Math.min(max, safeBufferLimit);
    const buf = await readBoundedBuffer(r, maxBuffer);
    length = buf.byteLength;
    if (length <= 0) throw new Error("Remote file is empty");
    return {
      source: buf,
      length,
      contentType,
      inferredFileName,
      cancel: async () => undefined,
    };
  }
  throw new Error("Too many redirects");
}

async function cosAuthorization(
  secretId: string,
  secretKey: string,
  pathname: string,
  host: string,
  length: number,
  start: number,
  expiry: number
) {
  const keyTime = `${start};${expiry}`;
  const signKey = await hmacSha1Hex(secretKey, keyTime);
  const headers = `content-length=${length}&host=${encodeURIComponent(host)}`;
  const httpString = `put\n${pathname}\n\n${headers}\n`;
  const stringToSign = `sha1\n${keyTime}\n${await sha1Hex(httpString)}\n`;
  const signature = await hmacSha1Hex(signKey, stringToSign);
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=content-length;host&q-url-param-list=&q-signature=${signature}`;
}

export interface UploadFileInput {
  file_url: string;
  file_name?: string;
  content_type?: string;
  keep_both?: boolean;
}

export interface UploadFileResult {
  media_id: string;
  file_name: string;
  file_size: number;
  media_type: number;
}

export interface UploadFileItemOutcome {
  file_name: string;
  status: "success" | "failed";
  media_id?: string;
  file_size?: number;
  media_type?: number;
  error?: string;
}

export interface BatchUploadResult {
  results: UploadFileItemOutcome[];
  succeeded: UploadFileItemOutcome[];
  failed: UploadFileItemOutcome[];
  summary: string;
}

export class ImaKnowledge {
  env: Env;
  api: ImaClient;
  constructor(env: Env, api: ImaClient) {
    this.env = env;
    this.api = api;
  }
  searchBases(query: string, cursor = "", limit = 20) {
    return this.api.post("openapi/wiki/v1/search_knowledge_base", { query, cursor, limit });
  }
  addable(cursor = "", limit = 50) {
    return this.api.post("openapi/wiki/v1/get_addable_knowledge_base_list", { cursor, limit });
  }
  getBases(ids: string[]) {
    return this.api.post("openapi/wiki/v1/get_knowledge_base", { ids });
  }
  list(id: string, cursor = "", limit = 50, folder_id?: string) {
    return this.api.post("openapi/wiki/v1/get_knowledge_list", {
      knowledge_base_id: id,
      cursor,
      limit,
      ...(folder_id ? { folder_id } : {}),
    });
  }
  search(id: string, query: string, cursor = "") {
    return this.api.post("openapi/wiki/v1/search_knowledge", {
      knowledge_base_id: id,
      query,
      cursor,
    });
  }
  async media(media_id: string): Promise<GetMediaInfoResponse> {
    const info = await this.api.post<GetMediaInfoResponse>("openapi/wiki/v1/get_media_info", { media_id });
    return {
      media_type: info.media_type,
      ...(info.url_info?.url ? { url_info: { url: info.url_info.url } } : {}),
      ...(info.notebook_ext_info ? { notebook_ext_info: info.notebook_ext_info } : {}),
    };
  }
  async exportSource(
    media_id: string,
    notes: ImaNotes,
    options: { file_name?: string } = {}
  ): Promise<ExportFileResult> {
    if (!this.env.R2_BUCKET) {
      throw new ImaApiError("R2 bucket 未配置，无法导出文件", 110002);
    }
    const cleanMediaId = (media_id || "").trim();
    if (!cleanMediaId) {
      throw new ImaApiError("media_id 不能为空", 110001);
    }

    const info = await this.api.post<GetMediaInfoResponse>("openapi/wiki/v1/get_media_info", { media_id: cleanMediaId });
    const media_type = Number(info?.media_type ?? 0);

    // Scenario 1: Note type in knowledge base (media_type = 11)
    if (media_type === MediaType.Note) {
      const noteId = info?.notebook_ext_info?.notebook_id;
      if (!noteId) {
        throw new ImaApiError("该知识库条目为笔记类型，但未获取到关联的 notebook_id", 110011);
      }
      return notes.exportNote(noteId, options);
    }

    // Scenario 2: URL accessible media
    const urlInfo = info?.url_info;
    if (!urlInfo?.url) {
      throw new ImaApiError("该知识库条目无法直接通过链接获取原文，请使用 IMA 客户端查看", 110011);
    }

    const timeoutMs = Number(this.env.FILE_DOWNLOAD_TIMEOUT_MS || DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS);
    const reqHeaders: Record<string, string> = {
      ...(urlInfo.headers || {}),
    };
    const res = await fetchWithSafeRedirects(urlInfo.url, { headers: reqHeaders }, timeoutMs);
    if (!res.ok) {
      throw new ImaApiError(`拉取媒体原文失败 HTTP ${res.status}`, 110010);
    }

    const contentType = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const lengthHeader = res.headers.get("content-length");
    const fileSize = lengthHeader ? Number(lengthHeader) : undefined;

    // Determine filename
    let derivedName = options.file_name?.trim();
    if (!derivedName) {
      derivedName = inferRemoteFileName(urlInfo.url, contentType, res.headers.get("content-disposition"));
    }
    const fallbackExt = MEDIA_TYPE_DEFAULT_EXT[media_type];
    const fileName = sanitizeFileName(derivedName, fallbackExt);
    const key = buildR2Key("media", cleanMediaId, fileName);
    const contentDisposition = buildContentDisposition(fileName);

    if (!res.body) {
      throw new ImaApiError("拉取媒体原文响应体为空", 110010);
    }

    // Stream directly into R2
    await this.env.R2_BUCKET.put(key, res.body, {
      httpMetadata: {
        contentType,
        contentDisposition,
      },
      customMetadata: {
        media_id: cleanMediaId,
        media_type: String(media_type),
        exported_at: new Date().toISOString(),
      },
    });

    const download_url = buildDownloadUrl(this.env, key);
    return {
      download_url,
      file_name: fileName,
      file_size: Number.isSafeInteger(fileSize) ? fileSize : undefined,
      content_type: contentType,
      media_id: cleanMediaId,
      key,
    };
  }

  async readSource(
    media_id: string,
    notes: ImaNotes,
    options: { offset?: number; max_bytes?: number; target_content_format?: 0 | 1 | 2; export_to_r2?: boolean } = {}
  ): Promise<{
    media_id: string;
    media_type: number;
    content?: string;
    url?: string;
    download_url?: string;
    file_name?: string;
    content_type?: string;
    fallback_message?: string;
    offset?: number;
    bytes_returned?: number;
    next_offset?: number;
    is_end?: boolean;
  }> {
    if (options.export_to_r2) {
      const exported = await this.exportSource(media_id, notes);
      return {
        media_id,
        media_type: 0,
        download_url: exported.download_url,
        file_name: exported.file_name,
        content_type: exported.content_type,
        bytes_returned: exported.file_size,
        is_end: true,
      };
    }

    const info = await this.api.post<GetMediaInfoResponse>("openapi/wiki/v1/get_media_info", { media_id });
    const media_type = Number(info?.media_type ?? 0);

    // Scenario 1: Note type (media_type = 11)
    if (media_type === MediaType.Note) {
      const noteId = info?.notebook_ext_info?.notebook_id;
      if (!noteId) {
        return {
          media_id,
          media_type,
          fallback_message: "该条目为笔记类型，但未获取到关联的 notebook_id，请在 IMA 客户端查看。",
        };
      }
      const noteData = await notes.get(noteId, options.target_content_format);
      return {
        media_id,
        media_type,
        content: noteData?.content ?? "",
      };
    }

    // Scenario 2: URL accessible media
    const urlInfo = info?.url_info;
    if (urlInfo?.url) {
      try {
        const timeoutMs = Number(this.env.FILE_DOWNLOAD_TIMEOUT_MS || DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS);
        // Do NOT leak urlInfo.headers in returned object. Use only for upstream fetch:
        const offset = options.offset ?? 0;
        const maxBytes = options.max_bytes ?? 2 * 1024 * 1024;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new ImaApiError("offset 必须是非负整数", 110001);
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) {
          throw new ImaApiError("max_bytes 必须介于 1 和 2097152 之间", 110001);
        }
        const reqHeaders: Record<string, string> = {
          ...(urlInfo.headers || {}),
          range: `bytes=${offset}-${offset + maxBytes - 1}`,
        };
        const res = await fetchWithSafeRedirects(urlInfo.url, { headers: reqHeaders }, timeoutMs);
        if (res.ok) {
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          const isText =
            ct.includes("text") ||
            ct.includes("json") ||
            ct.includes("markdown") ||
            ct.includes("xml") ||
            ct.includes("javascript");

          if (this.env.R2_BUCKET && !isText && options.export_to_r2 !== false && options.offset === undefined && options.max_bytes === undefined) {
            const exported = await this.exportSource(media_id, notes);
            return {
              media_id,
              media_type,
              download_url: exported.download_url,
              file_name: exported.file_name,
              content_type: exported.content_type,
              bytes_returned: exported.file_size,
              is_end: true,
            };
          }

          const rangeMatch = res.headers.get("content-range")?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
          const rangeHonored = res.status === 206 && Boolean(rangeMatch);
          const total = rangeMatch?.[3] && rangeMatch[3] !== "*"
            ? Number(rangeMatch[3])
            : res.status === 200 && res.headers.get("content-length")
              ? Number(res.headers.get("content-length"))
              : undefined;
          const chunk = await readBinaryChunk(res, rangeHonored ? 0 : offset, maxBytes);
          const nextOffset = offset + chunk.bytes.byteLength;
          const isEnd = Number.isSafeInteger(total) ? nextOffset >= Number(total) : !chunk.hasMore;
          return {
            media_id,
            media_type,
            ...(isText ? { url: urlInfo.url } : {}),
            content: isText
              ? new TextDecoder().decode(chunk.bytes)
              : `data:${ct || "application/octet-stream"};base64,${bufferToBase64(chunk.bytes)}`,
            content_type: ct,
            offset,
            bytes_returned: chunk.bytes.byteLength,
            next_offset: isEnd ? undefined : nextOffset,
            is_end: isEnd,
          };
        }
      } catch {
        // Fall through to fallback
      }
    }

    // Scenario 3: Inaccessible media
    return {
      media_id,
      media_type,
      fallback_message: "该知识库条目无法直接通过链接获取原文，请使用 IMA 客户端查看。",
    };
  }

  async importUrls(
    id: string,
    urls: string[],
    folder_id?: string
  ): Promise<ImportUrlsResultSummary> {
    for (const u of urls) {
      const c = await classifyUrlWithProbe(u);
      if (!c.isSafeHttps || c.suggestedAction === "reject") {
        throw new ImaApiError(`URL "${u}" 不合法: ${c.reason || "不支持的 URL"}`, 110001);
      }
      if (c.suggestedAction === "upload_file") {
        throw new ImaApiError(`URL "${u}" 为可下载文件，请使用 upload_file_to_knowledge_base 工具进行上传`, 110001);
      }
    }

    const data = await this.api.post<ImportUrlsResponse>("openapi/wiki/v1/import_urls", {
      knowledge_base_id: id,
      folder_id: folder_id || id,
      urls,
    });

    const rawResults = data?.results;
    if (!rawResults || typeof rawResults !== "object" || Array.isArray(rawResults)) {
      throw new ImaApiError("import_urls 未返回有效的 results 映射", 110011);
    }
    const entries = Object.entries(rawResults);
    if (entries.length === 0) {
      throw new ImaApiError("import_urls 对请求的 URL 未返回任何结果", 110011);
    }
    const missingUrls = urls.filter(url => !Object.prototype.hasOwnProperty.call(rawResults, url));
    if (missingUrls.length > 0) {
      throw new ImaApiError(`import_urls 未返回完整结果: ${missingUrls.join(", ")}`, 110011);
    }

    const resultMap: Record<string, ImportUrlData> = {};
    const succeeded: ImportUrlData[] = [];
    const failed: ImportUrlData[] = [];

    for (const [urlKey, item] of entries) {
      if (!item || typeof item !== "object" || !Number.isFinite(item.ret_code)) {
        throw new ImaApiError(`import_urls 返回了无效结果: ${urlKey}`, 110011);
      }
      const url = item.url || urlKey;
      const dataItem: ImportUrlData = {
        url,
        ret_code: Number(item.ret_code ?? -1),
        ret_msg: item.ret_msg,
        media_id: item.media_id,
      };
      resultMap[url] = dataItem;
      if (dataItem.ret_code === 0) {
        succeeded.push(dataItem);
      } else {
        failed.push(dataItem);
      }
    }

    if (failed.length > 0) {
      if (succeeded.length === 0) {
        throw new ImaApiError(
          `所有 URL 导入失败: ${failed.map((f) => `${f.url} (${f.ret_code}: ${f.ret_msg || "失败"})`).join("; ")}`,
          110011,
          { failed }
        );
      }
      return {
        results: resultMap,
        succeeded,
        failed,
        partial_failure: true,
        summary: `成功导入 ${succeeded.length} 个 URL，失败 ${failed.length} 个 URL: ${failed
          .map((f) => `${f.url}: ${f.ret_msg || f.ret_code}`)
          .join("; ")}`,
      };
    }

    return {
      results: resultMap,
      succeeded,
      failed: [],
      partial_failure: false,
      summary: `全部 ${succeeded.length} 个 URL 导入成功`,
    };
  }

  async addNote(id: string, note_id: string, title: string, folder_id?: string): Promise<AddKnowledgeResponse> {
    const res = await this.api.post<AddKnowledgeResponse>("openapi/wiki/v1/add_knowledge", {
      media_type: MediaType.Note,
      title,
      knowledge_base_id: id,
      note_info: { content_id: note_id },
      ...(folder_id ? { folder_id } : {}),
    });
    if (!res?.media_id) throw new ImaApiError("add_knowledge 关联笔记未返回有效 media_id", 210036);
    return res;
  }

  async upload(a: {
    knowledge_base_id: string;
    file_url: string;
    file_name?: string;
    folder_id?: string;
    content_type?: string;
    keep_both?: boolean;
  }): Promise<UploadFileResult> {
    // The remote response is authoritative for MIME when the caller does not
    // provide an explicit override. Downloading is capped at the largest IMA
    // file limit; type-specific limits are enforced before COS transfer.
    const d = await openFileStream(this.env, a.file_url, DEFAULT_SIZE_LIMIT);
    let transferStarted = false;
    try {
    const requestedName = a.file_name?.trim() || d.inferredFileName;
    const meta = resolveUploadMetadata({
      fileName: requestedName,
      contentType: a.content_type || d.contentType,
      fileSize: d.length,
    });
    let name = meta.fileName;

    // 3. Duplicate check
    const dupe = await this.api.post<CheckRepeatedNamesResponse>("openapi/wiki/v1/check_repeated_names", {
      knowledge_base_id: a.knowledge_base_id,
      params: [{ name, media_type: meta.mediaType }],
      ...(a.folder_id ? { folder_id: a.folder_id } : {}),
    });

    const duplicateResult = dupe?.results?.[0];
    if (!duplicateResult || typeof duplicateResult.is_repeated !== "boolean") {
      throw new ImaApiError("重名检查未返回有效结果", 110011);
    }
    if (duplicateResult.is_repeated) {
      if (!a.keep_both) throw new ImaApiError(`知识库中已存在同名文件 "${name}"，如需保留二者请设置 keep_both=true`, 110001);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(
        now.getMinutes()
      )}${pad(now.getSeconds())}`;
      const dot = name.lastIndexOf(".");
      name = dot > 0 ? `${name.slice(0, dot)}_${stamp}${name.slice(dot)}` : `${name}_${stamp}`;
    }

    // 4. Create media
    const created = await this.api.post<CreateMediaResponse>("openapi/wiki/v1/create_media", {
      file_name: name,
      file_size: d.length,
      content_type: meta.contentType,
      knowledge_base_id: a.knowledge_base_id,
      file_ext: meta.fileExt,
    });

    const c = created?.cos_credential;
    if (!created?.media_id || !c?.secret_id || !c?.secret_key || !c?.token || !c?.bucket_name || !c?.region || !c?.cos_key) {
      throw new ImaApiError("IMA returned incomplete COS credentials", 210007);
    }

    const startTime = Number(c.start_time);
    const expiredTime = Number(c.expired_time);
    if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(expiredTime) || expiredTime <= startTime) {
      throw new ImaApiError("IMA 返回的 COS 凭据时间戳非法 (expired_time <= start_time)", 210007);
    }

    // 5. COS PUT
    const host = `${c.bucket_name}.cos.${c.region}.myqcloud.com`;
    const pathname = `/${c.cos_key}`;
    const authorization = await cosAuthorization(
      c.secret_id,
      c.secret_key,
      pathname,
      host,
      d.length,
      startTime,
      expiredTime
    );

    let uploadBody: BodyInit;
    let pipePromise: Promise<void> = Promise.resolve();
    let abortPipe: () => void = () => {};
    if (d.source instanceof Uint8Array) {
      uploadBody = d.source as BodyInit;
    } else if (typeof FixedLengthStream !== "undefined") {
      const fixed = new FixedLengthStream(d.length);
      const abortController = new AbortController();
      abortPipe = () => abortController.abort("COS transfer stopped");
      pipePromise = d.source.pipeTo(fixed.writable, { signal: abortController.signal });
      uploadBody = fixed.readable;
    } else {
      uploadBody = d.source as BodyInit;
    }
    transferStarted = true;

    const putPromise = fetch(`https://${host}${pathname}`, {
      method: "PUT",
      headers: {
        "content-type": meta.contentType,
        authorization,
        "x-cos-security-token": c.token,
      },
      body: uploadBody,
    });

    let put: Response;
    try {
      [put] = await Promise.all([putPromise, pipePromise]);
    } catch (error) {
      abortPipe();
      await pipePromise.catch(() => undefined);
      throw error;
    }
    if (!put.ok) throw new ImaApiError(`COS upload failed HTTP ${put.status}`, 210007);

    // 6. Register knowledge
    const added = await this.api.post<AddKnowledgeResponse>("openapi/wiki/v1/add_knowledge", {
      media_type: meta.mediaType,
      media_id: created.media_id,
      title: name,
      knowledge_base_id: a.knowledge_base_id,
      ...(a.folder_id ? { folder_id: a.folder_id } : {}),
      file_info: {
        cos_key: c.cos_key,
        file_size: d.length,
        last_modify_time: Math.floor(Date.now() / 1000),
        password: "",
        file_name: name,
      },
    });

    if (!added?.media_id) {
      throw new ImaApiError("add_knowledge 未返回有效的 media_id", 210036);
    }

    return {
      media_id: added.media_id,
      file_name: name,
      file_size: d.length,
      media_type: meta.mediaType,
    };
    } finally {
      if (!transferStarted) await d.cancel();
    }
  }

  async uploadBatch(
    knowledge_base_id: string,
    files: UploadFileInput[],
    folder_id?: string
  ): Promise<BatchUploadResult> {
    const results: UploadFileItemOutcome[] = [];
    const succeeded: UploadFileItemOutcome[] = [];
    const failed: UploadFileItemOutcome[] = [];

    for (const f of files) {
      try {
        const res = await this.upload({
          knowledge_base_id,
          folder_id,
          file_url: f.file_url,
          file_name: f.file_name,
          content_type: f.content_type,
          keep_both: f.keep_both,
        });
        const item: UploadFileItemOutcome = {
          file_name: res.file_name,
          status: "success",
          media_id: res.media_id,
          file_size: res.file_size,
          media_type: res.media_type,
        };
        results.push(item);
        succeeded.push(item);
      } catch (err: unknown) {
        const item: UploadFileItemOutcome = {
          file_name: f.file_name || inferRemoteFileName(f.file_url, f.content_type),
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
        results.push(item);
        failed.push(item);
      }
    }

    const summary = `上传完成: 成功 ${succeeded.length} 个，失败 ${failed.length} 个${
      failed.length > 0 ? ` (失败项: ${failed.map((x) => `${x.file_name}: ${x.error}`).join("; ")})` : ""
    }`;

    return { results, succeeded, failed, summary };
  }
}
