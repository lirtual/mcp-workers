export type Provider = 'imap_smtp';
export type Env = {
  DB: D1Database;
  MCP_ACCESS_TOKEN: string;
  MAIL_ENCRYPTION_KEY: string;
  MAIL_ENCRYPTION_PREVIOUS_KEY?: string;
  MAIL_PREVIOUS_KEY_ID?: string;
  MAIL_KEY_ID?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
};
export type MailAccount = {
  account_id: string;
  provider: Provider;
  address: string;
  alias: string | null;
  status: 'active' | 'reauthorization_required' | 'disabled';
  credential_ciphertext: string;
  credential_key_id: string;
  created_at: number;
  updated_at: number;
};
export class MailError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function fail(code: string): never { throw new MailError(code); }
export const SETUP_HOST = 'email.lirtual.dpdns.org';
