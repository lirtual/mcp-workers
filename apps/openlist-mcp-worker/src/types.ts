export interface Env {
  OPENLIST_URL: string;
  OPENLIST_TOKEN: string;
  OPENLIST_ALLOWED_PATHS: string;
  OPENLIST_READONLY?: string;
  OPENLIST_UPLOAD_MAX_BYTES?: string;
  OPENLIST_TIMEOUT_MS?: string;
  MCP_ACCESS_TOKEN?: string;
}

export interface AppConfig {
  openListUrl: URL;
  allowedPaths: string[];
  readonly: boolean;
  uploadMaxBytes: number;
  timeoutMs: number;
}
