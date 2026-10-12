export interface Env {
  IMA_IMAGE_REFRESH_SHARD?: DurableObjectNamespace<import("./image-refresh-shard.ts").ImaImageRefreshShard>;
  R2_BUCKET?: R2Bucket;
  R2_PUBLIC_BASE_URL?: string;
  IMA_BASE_URL?: string;
  CLIENT_ID?: string;
  API_KEY?: string;
  MCP_ACCESS_TOKEN?: string;
  FILE_DOWNLOAD_TIMEOUT_MS?: string;
  FILE_DOWNLOAD_MAX_REDIRECTS?: string;
  FILE_DOWNLOAD_MAX_BUFFER_BYTES?: string;
  IMA_RESPONSE_MAX_BYTES?: string;
}

export type ImaCredentials = { clientId: string; apiKey: string };

export const MediaType = {
  Unknown: 0,
  PDF: 1,
  Web: 2,
  Word: 3,
  PPT: 4,
  Excel: 5,
  WeChatArticle: 6,
  MarkDown: 7,
  Image: 9,
  Note: 11,
  AISession: 12,
  TXT: 13,
  Xmind: 14,
  SoundRecording: 15,
  WebVideo: 16,
  Podcast: 19,
  HTML: 20,
  EPUB: 21,
  Code: 98,
  Folder: 99,
} as const;

export class ImaApiError extends Error {
  code: number;
  details?: unknown;
  constructor(message: string, code: number, details?: unknown) {
    super(`[IMA-${code}] ${message}`);
    this.name = "ImaApiError";
    this.code = code;
    this.details = details;
  }
}

export interface ApiResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

export interface SearchNoteItem {
  note_book_info: {
    note_id: string;
    title: string;
    summary?: string;
    create_time?: number;
    modify_time?: number;
    cover_image?: string;
    note_ext_info?: {
      folder_id?: string;
      folder_name?: string;
    };
  };
  highlightInfo?: Record<string, string>;
}

export interface SearchNoteResponse {
  search_note_infos: SearchNoteItem[];
  is_end: boolean;
  total_hit_num: number;
}

export interface NoteFolderInfo {
  folder_id: string;
  name: string;
  create_time?: number;
  modify_time?: number;
  note_number?: number;
  parent_folder_id?: string;
  folder_type?: number;
}

export interface ListNoteResponse {
  note_book_list: Array<{
    note_id: string;
    title: string;
    summary?: string;
    create_time?: number;
    modify_time?: number;
    note_ext_info?: {
      folder_id?: string;
      folder_name?: string;
    };
  }>;
  next_cursor?: string;
  is_end: boolean;
}

export interface ListNotebookResponse {
  note_folder_infos: NoteFolderInfo[];
  next_cursor?: string;
  is_end: boolean;
}

export interface GetDocContentResponse {
  content: string;
}

export interface NoteMutationResponse {
  note_id: string;
}

export interface UrlInfo {
  url: string;
  headers?: Record<string, string>;
}

export interface NotebookExtInfo {
  notebook_id: string;
}

export interface GetMediaInfoResponse {
  media_type: number;
  url_info?: UrlInfo;
  notebook_ext_info?: NotebookExtInfo;
}

export interface ImportUrlData {
  url: string;
  ret_code: number;
  ret_msg?: string;
  media_id?: string;
}

export interface ImportUrlsResponse {
  results: Record<string, ImportUrlData>;
}

export interface ImportUrlsResultSummary {
  results: Record<string, ImportUrlData>;
  succeeded: ImportUrlData[];
  failed: ImportUrlData[];
  partial_failure: boolean;
  summary: string;
}

export interface CosCredential {
  secret_id: string;
  secret_key: string;
  token: string;
  bucket_name: string;
  region: string;
  cos_key: string;
  start_time: number | string;
  expired_time: number | string;
}

export interface CreateMediaResponse {
  media_id: string;
  cos_credential: CosCredential;
}

export interface AddKnowledgeResponse {
  media_id: string;
}

export interface CheckRepeatedNamesResult {
  name: string;
  is_repeated: boolean;
}

export interface CheckRepeatedNamesResponse {
  results: CheckRepeatedNamesResult[];
}

export interface ExportFileResult {
  download_url: string;
  file_name: string;
  file_size?: number;
  content_type?: string;
  media_id?: string;
  note_id?: string;
  key: string;
}
