import { MediaType } from "./types.ts";

const MB = 1024 * 1024;

export const EXT_MAP: Record<string, { media_type: number; content_type: string }> = {
  pdf: { media_type: MediaType.PDF, content_type: "application/pdf" },
  doc: { media_type: MediaType.Word, content_type: "application/msword" },
  docx: { media_type: MediaType.Word, content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ppt: { media_type: MediaType.PPT, content_type: "application/vnd.ms-powerpoint" },
  pptx: { media_type: MediaType.PPT, content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
  xls: { media_type: MediaType.Excel, content_type: "application/vnd.ms-excel" },
  xlsx: { media_type: MediaType.Excel, content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  csv: { media_type: MediaType.Excel, content_type: "text/csv" },
  md: { media_type: MediaType.MarkDown, content_type: "text/markdown" },
  markdown: { media_type: MediaType.MarkDown, content_type: "text/markdown" },
  png: { media_type: MediaType.Image, content_type: "image/png" },
  jpg: { media_type: MediaType.Image, content_type: "image/jpeg" },
  jpeg: { media_type: MediaType.Image, content_type: "image/jpeg" },
  webp: { media_type: MediaType.Image, content_type: "image/webp" },
  txt: { media_type: MediaType.TXT, content_type: "text/plain" },
  xmind: { media_type: MediaType.Xmind, content_type: "application/x-xmind" },
  mp3: { media_type: MediaType.SoundRecording, content_type: "audio/mpeg" },
  m4a: { media_type: MediaType.SoundRecording, content_type: "audio/x-m4a" },
  wav: { media_type: MediaType.SoundRecording, content_type: "audio/wav" },
  aac: { media_type: MediaType.SoundRecording, content_type: "audio/aac" },
  html: { media_type: MediaType.HTML, content_type: "text/html" },
  epub: { media_type: MediaType.EPUB, content_type: "application/epub+zip" },
};

export const SUPPORTED_FILE_EXTENSIONS = new Set(Object.keys(EXT_MAP));

export const CONTENT_TYPE_MAP: Record<string, number> = {};
for (const [, val] of Object.entries(EXT_MAP)) {
  if (!CONTENT_TYPE_MAP[val.content_type]) {
    CONTENT_TYPE_MAP[val.content_type] = val.media_type;
  }
}
Object.assign(CONTENT_TYPE_MAP, {
  "text/x-markdown": MediaType.MarkDown,
  "application/md": MediaType.MarkDown,
  "application/markdown": MediaType.MarkDown,
  "application/vnd.xmind.workbook": MediaType.Xmind,
});

export const MEDIA_TYPE_DEFAULT_EXT: Record<number, string> = {
  [MediaType.PDF]: "pdf",
  [MediaType.Word]: "docx",
  [MediaType.PPT]: "pptx",
  [MediaType.Excel]: "xlsx",
  [MediaType.MarkDown]: "md",
  [MediaType.Image]: "png",
  [MediaType.TXT]: "txt",
  [MediaType.Xmind]: "xmind",
  [MediaType.SoundRecording]: "mp3",
  [MediaType.HTML]: "html",
  [MediaType.EPUB]: "epub",
};

export const SIZE_LIMITS: Record<number, number> = {
  [MediaType.Excel]: 10 * MB,
  [MediaType.MarkDown]: 10 * MB,
  [MediaType.TXT]: 10 * MB,
  [MediaType.Xmind]: 10 * MB,
  [MediaType.HTML]: 10 * MB,
  [MediaType.Image]: 30 * MB,
  [MediaType.EPUB]: 50 * MB,
};
export const DEFAULT_SIZE_LIMIT = 200 * MB;

export function getSizeLimitForMediaType(mediaType: number): number {
  return SIZE_LIMITS[mediaType] || DEFAULT_SIZE_LIMIT;
}

const UNSUPPORTED_VIDEO_EXT = new Set([
  "mp4", "avi", "mov", "mkv", "wmv", "flv", "webm", "m4v", "rmvb", "rm", "3gp",
]);

const UNSUPPORTED_VIDEO_CT = new Set([
  "video/mp4",
  "video/x-msvideo",
  "video/quicktime",
  "video/x-matroska",
  "video/x-ms-wmv",
  "video/x-flv",
  "video/webm",
]);

const NON_FILE_EXT: Record<string, string> = {
  mhtml: "Web pages must be added via URL (import_urls), not as a file upload.",
};

const NON_FILE_CT: Record<string, string> = {
  "application/xhtml+xml": "Web pages must be added via URL (import_urls), not as a file upload.",
};

export function formatSize(bytes: number): string {
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

export function normalizeContentType(val?: string): string {
  return (val || "").split(";", 1)[0].trim().toLowerCase();
}

export interface UploadMetadataInput {
  fileName: string;
  contentType?: string;
  fileSize: number;
}

export interface UploadMetadataResult {
  fileName: string;
  fileExt: string;
  fileSize: number;
  mediaType: number;
  contentType: string;
}

export function preflightFileType(fileName: string, inputContentType?: string): {
  mediaType: number;
  fileExt: string;
  contentType: string;
  sizeLimit: number;
} {
  const trimmed = fileName.trim();
  const extMatch = trimmed.match(/\.([^.]+)$/);
  let ext = extMatch ? extMatch[1].toLowerCase() : "";
  const ct = normalizeContentType(inputContentType);

  if (UNSUPPORTED_VIDEO_EXT.has(ext)) {
    throw new Error(`Video files (.${ext}) are not supported as uploads. Videos must be added via URL (MediaType.WebVideo), and Bilibili/YouTube are unsupported — use the IMA desktop app.`);
  }
  if (UNSUPPORTED_VIDEO_CT.has(ct)) {
    throw new Error(`Video content (${ct}) is not supported as upload. Videos must be added via URL (MediaType.WebVideo), and Bilibili/YouTube are unsupported — use the IMA desktop app.`);
  }

  if (ext && NON_FILE_EXT[ext]) {
    throw new Error(NON_FILE_EXT[ext]);
  }
  if (ct && NON_FILE_CT[ct]) {
    throw new Error(NON_FILE_CT[ct]);
  }

  let mediaType: number | null = null;
  let resolvedContentType: string | null = null;

  const ctMediaType = ct ? CONTENT_TYPE_MAP[ct] : undefined;
  const extMapping = ext ? EXT_MAP[ext] : undefined;

  if (ct === "application/zip") {
    if (ext === "xmind") {
      mediaType = MediaType.Xmind;
      resolvedContentType = "application/x-xmind";
    } else {
      throw new Error("Generic ZIP files are not supported. application/zip is accepted only for files with the .xmind extension.");
    }
  } else if (ctMediaType != null) {
    mediaType = ctMediaType;
    resolvedContentType = ct;
  } else if (ct) {
    if (extMapping) {
      mediaType = extMapping.media_type;
      resolvedContentType = extMapping.content_type;
    } else {
      throw new Error(`Unrecognized content type ${ct}${ext ? ` and file extension .${ext}` : ""}. This file type is not supported.`);
    }
  } else {
    if (extMapping) {
      mediaType = extMapping.media_type;
      resolvedContentType = extMapping.content_type;
    } else if (ext) {
      throw new Error(`Unrecognized file extension .${ext}. This file type is not supported.`);
    } else {
      throw new Error("File has no extension and no content-type provided. Cannot determine file type.");
    }
  }

  if (!ext && mediaType && MEDIA_TYPE_DEFAULT_EXT[mediaType]) {
    ext = MEDIA_TYPE_DEFAULT_EXT[mediaType];
  }

  const sizeLimit = getSizeLimitForMediaType(mediaType);
  return {
    mediaType,
    fileExt: ext,
    contentType: resolvedContentType,
    sizeLimit,
  };
}

export function resolveUploadMetadata(input: UploadMetadataInput): UploadMetadataResult {
  const pre = preflightFileType(input.fileName, input.contentType);
  if (input.fileSize > pre.sizeLimit) {
    throw new Error(`File size ${formatSize(input.fileSize)} exceeds the ${formatSize(pre.sizeLimit)} limit for this file type.`);
  }

  return {
    fileName: input.fileName.trim(),
    fileExt: pre.fileExt,
    fileSize: input.fileSize,
    mediaType: pre.mediaType,
    contentType: pre.contentType,
  };
}
