export type BindingState =
  'unbound' | 'qr_pending' | 'bound_unverified' | 'ready' |
  'needs_interaction' | 'reauth_required' | 'temporarily_unavailable';
export type Env = {
  DB: D1Database;
  MCP_ACCESS_TOKEN: string;
  MCP_HOST: string;
  ADMIN_HOST: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
  WEIXIN_ENCRYPTION_KEY: string;
  WEIXIN_ENCRYPTION_PREVIOUS_KEY?: string;
  WEIXIN_PREVIOUS_KEY_ID?: string;
  WEIXIN_KEY_ID?: string;
};
export type Binding = {
  id: number; generation: number; state: BindingState;
  session_ciphertext: string | null; session_key_id: string | null;
  last_verified_context_at: number | null; last_sync_at: number | null;
  updated_at: number;
  lease_holder: string | null;
  lease_until: number | null;
};
export type IlinkSession = {
  botToken: string; ownerId: string; botId: string;
  contextToken: string; cursor: string;
};
export class WeixinError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function fail(code: string): never { throw new WeixinError(code); }
