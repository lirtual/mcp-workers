import { base64url, decrypt, encrypt, nonce, sha256 } from './crypto.ts';
import { fail, SETUP_ORIGIN } from './types.ts';
import type { Env, Provider, MailAccount } from './types.ts';
type Credentials = { access_token: string; refresh_token?: string; expires_at?: number };
type OAuthConfig = { clientId: string; secret: string; auth: string; token: string; scope: string };
const callback = SETUP_ORIGIN + '/oauth/callback';
function config(env: Env, provider: Provider): OAuthConfig {
  if (provider === 'gmail' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return {
    clientId: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET,
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.compose',
  };
  if (provider === 'graph' && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    const tenant = env.MICROSOFT_TENANT ?? 'common';
    if (!/^(common|consumers|organizations|[a-f0-9-]{36})$/.test(tenant)) fail('oauth_misconfigured');
    return {
      clientId: env.MICROSOFT_CLIENT_ID, secret: env.MICROSOFT_CLIENT_SECRET,
      auth: 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/authorize',
      token: 'https://login.microsoftonline.com/' + tenant + '/oauth2/v2.0/token',
      scope: 'offline_access User.Read Mail.ReadWrite Mail.Send',
    };
  }
  return fail('oauth_misconfigured');
}
export async function beginOAuth(env: Env, provider: Provider, ownerSub: string): Promise<string> {
  if (provider !== 'gmail' && provider !== 'graph') fail('unsupported');
  const cfg = config(env, provider), state = nonce(), verifier = nonce() + nonce();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const hash = await sha256(state), encrypted = await encrypt(env, 'oauth:' + hash, { verifier });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM oauth_sessions WHERE state_hash IN (SELECT state_hash FROM oauth_sessions WHERE expires_at<? LIMIT 20)')
    .bind(now).run();
  await env.DB.prepare('INSERT INTO oauth_sessions(state_hash,provider,owner_sub,pkce_ciphertext,key_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
    .bind(hash, provider, ownerSub, encrypted.ciphertext, encrypted.keyId, now, now + 600).run();
  const url = new URL(cfg.auth);
  for (const [k, v] of Object.entries({
    client_id: cfg.clientId, redirect_uri: callback, response_type: 'code', scope: cfg.scope,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  })) url.searchParams.set(k, v);
  if (provider === 'gmail') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}
async function exchange(env: Env, provider: Provider, form: URLSearchParams, requestFetch: typeof fetch): Promise<Credentials> {
  const cfg = config(env, provider);
  form.set('client_id', cfg.clientId);
  form.set('client_secret', cfg.secret);
  form.set('redirect_uri', callback);
  const response = await requestFetch(cfg.token, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) fail('reauthorization_required');
  const value = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!value.access_token || typeof value.access_token !== 'string') fail('reauthorization_required');
  return {
    access_token: value.access_token, refresh_token: value.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + Math.max(60, Math.min(value.expires_in ?? 3600, 86400 * 30)),
  };
}
async function identity(provider: Provider, token: string, requestFetch: typeof fetch): Promise<string> {
  const url = provider === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName';
  const resp = await requestFetch(url, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) fail('reauthorization_required');
  const data = await resp.json() as { emailAddress?: string; mail?: string; userPrincipalName?: string };
  const address = (data.emailAddress ?? data.mail ?? data.userPrincipalName ?? '').trim().toLowerCase();
  if (!/^[^@\s]{1,100}@[^@\s]{3,200}$/.test(address)) fail('invalid_mail_identity');
  return address;
}
export async function completeOAuth(env: Env, state: string, code: string, ownerSub: string, requestFetch: typeof fetch = fetch): Promise<string> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !code || code.length > 4096) fail('invalid_oauth_state');
  const hash = await sha256(state), now = Math.floor(Date.now() / 1000);
  const changed = await env.DB.prepare('UPDATE oauth_sessions SET consumed_at=? WHERE state_hash=? AND owner_sub=? AND consumed_at IS NULL AND expires_at>?')
    .bind(now, hash, ownerSub, now).run();
  if (changed.meta.changes !== 1) fail('invalid_oauth_state');
  const row = await env.DB.prepare('SELECT * FROM oauth_sessions WHERE state_hash=?').bind(hash)
    .first<{ provider: Provider; pkce_ciphertext: string; key_id: string }>();
  if (!row) fail('invalid_oauth_state');
  const { verifier } = await decrypt<{ verifier: string }>(env, 'oauth:' + hash, row.pkce_ciphertext, row.key_id);
  const creds = await exchange(env, row.provider, new URLSearchParams({
    grant_type: 'authorization_code', code, code_verifier: verifier,
  }), requestFetch);
  if (!creds.refresh_token) fail('refresh_token_missing');
  const address = await identity(row.provider, creds.access_token, requestFetch);
  const accountId = crypto.randomUUID(), encrypted = await encrypt(env, 'account:' + accountId + ':' + row.provider, creds);
  await env.DB.prepare('INSERT INTO mail_accounts(account_id,provider,address,alias,status,credential_ciphertext,credential_key_id,token_expires_at,created_at,updated_at) VALUES(?,?,?,NULL,?,?,?,?,?,?)')
    .bind(accountId, row.provider, address, 'active', encrypted.ciphertext, encrypted.keyId, creds.expires_at, now, now).run();
  return accountId;
}
export async function accessToken(env: Env, account: MailAccount, requestFetch: typeof fetch = fetch): Promise<string> {
  if (account.status !== 'active') fail('reauthorization_required');
  if (account.provider !== 'gmail' && account.provider !== 'graph') fail('unsupported');
  const context = 'account:' + account.account_id + ':' + account.provider;
  const credentials = await decrypt<Credentials>(env, context, account.credential_ciphertext, account.credential_key_id);
  if ((account.token_expires_at ?? 0) > Math.floor(Date.now() / 1000) + 90) return credentials.access_token;
  if (!credentials.refresh_token) fail('reauthorization_required');
  const now = Math.floor(Date.now() / 1000);
  const claim = await env.DB.prepare('UPDATE mail_accounts SET refresh_lock_until=? WHERE account_id=? AND status=? AND token_version=? AND (refresh_lock_until IS NULL OR refresh_lock_until<?)')
    .bind(now + 25, account.account_id, 'active', account.token_version, now).run();
  if (claim.meta.changes !== 1) fail('refresh_in_progress');
  try {
    const refreshed = await exchange(env, account.provider, new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: credentials.refresh_token,
    }), requestFetch);
    refreshed.refresh_token ??= credentials.refresh_token;
    const encrypted = await encrypt(env, context, refreshed);
    const applied = await env.DB.prepare('UPDATE mail_accounts SET credential_ciphertext=?,credential_key_id=?,token_expires_at=?,token_version=token_version+1,refresh_lock_until=NULL,updated_at=? WHERE account_id=? AND token_version=? AND status=?')
      .bind(encrypted.ciphertext, encrypted.keyId, refreshed.expires_at, now, account.account_id, account.token_version, 'active').run();
    if (applied.meta.changes !== 1) fail('refresh_in_progress');
    return refreshed.access_token;
  } catch (err) {
    const code = err instanceof Error ? err.message : '';
    if (code === 'reauthorization_required') {
      await env.DB.prepare('UPDATE mail_accounts SET status=?,refresh_lock_until=NULL WHERE account_id=? AND token_version=?')
        .bind('reauthorization_required', account.account_id, account.token_version).run();
    } else {
      await env.DB.prepare('UPDATE mail_accounts SET refresh_lock_until=NULL WHERE account_id=? AND token_version=?')
        .bind(account.account_id, account.token_version).run();
    }
    throw err;
  }
}
export async function revokeIfSupported(env: Env, account: MailAccount, requestFetch: typeof fetch = fetch): Promise<boolean> {
  if (account.provider !== 'gmail') return false;
  try {
    const credentials = await decrypt<Credentials>(env, 'account:' + account.account_id + ':' + account.provider, account.credential_ciphertext, account.credential_key_id);
    const result = await requestFetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: credentials.refresh_token ?? credentials.access_token }),
      signal: AbortSignal.timeout(5000),
    });
    return result.ok;
  } catch { return false; }
}
