export interface Env {
  OPENLIST_URL: string;
  OPENLIST_TOKEN: string;
  OPENLIST_ALLOWED_PATHS: string;
  OPENLIST_READONLY?: string;
  OPENLIST_UPLOAD_MAX_BYTES?: string;
  OPENLIST_TIMEOUT_MS?: string;
  /** Expand-phase Portal -> Worker credential. */
  MCP_ORIGIN_TOKEN?: string;
  /** Legacy client-facing Cloudflare Access configuration retained until contract cutover. */
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
}

export interface AppConfig {
  openListUrl: URL;
  allowedPaths: string[];
  readonly: boolean;
  uploadMaxBytes: number;
  timeoutMs: number;
  accessTeamDomain: string;
  accessAudience: string;
}
