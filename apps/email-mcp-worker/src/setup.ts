import { csrfCookie, validateCsrf, verifyAccess } from './access.ts';
import { encrypt, nonce } from './crypto.ts';
import { validateProtocolCredentials, verifyImapCredentials } from './imap.ts';
import { verifySmtpCredentials } from './smtp.ts';
import { rotateCredentials } from './rotation.ts';
import { listAccounts } from './tools.ts';
import { fail, MailError, SETUP_HOST } from './types.ts';
import type { Env, MailAccount } from './types.ts';

function escapeHtml(input: unknown): string {
  return String(input ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]!);
}
function imapForm(csrf: string, id?: string, address?: string): string {
  const credentials = id
    ? '<input type="hidden" name="account_id" value="' + escapeHtml(id) + '">' +
      '<input type="hidden" name="address" value="' + escapeHtml(address) + '">'
    : '<label>Email <input type="email" name="address" required maxlength="320"></label>';
  return '<form method="post" action="/setup/imap/add">' +
    '<input type="hidden" name="csrf" value="' + csrf + '">' + credentials +
    '<label>IMAP host <input name="imap_host" required maxlength="253"></label>' +
    '<label>SMTP host <input name="smtp_host" required maxlength="253"></label>' +
    '<label>SMTP port <select name="smtp_port"><option value="465">465 TLS</option>' +
    '<option value="587">587 STARTTLS</option></select></label>' +
    '<label>Username <input name="username" required maxlength="320"></label>' +
    '<label>App password <input type="password" name="password" autocomplete="off" required maxlength="512"></label>' +
    '<button type="submit">Verify IMAP and SMTP TLS</button></form>';
}
export const SETUP_CSP = "default-src 'none'; style-src 'unsafe-inline'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function securedHtml(body: string, cookie?: string): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': SETUP_CSP,
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Email Accounts</title>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>html{color-scheme:light dark}body{max-width:720px;margin:24px auto;' +
    'font:16px/1.5 system-ui;padding:0 16px;overflow-wrap:anywhere}' +
    'fieldset{min-width:0;margin:16px 0;padding:16px;border:1px solid #8888;border-radius:10px}' +
    'form{display:grid;gap:12px;margin:12px 0}label{display:grid;gap:5px}' +
    'input,select,button{box-sizing:border-box;font:inherit;max-width:100%;padding:9px 10px}' +
    'input,select{width:100%}button{justify-self:start;cursor:pointer}' +
    'details{margin:12px 0}li{margin-bottom:16px}</style><main>' + body + '</main></html>', { headers });
}
async function formValues(request: Request): Promise<URLSearchParams> {
  if (Number(request.headers.get('content-length') ?? 0) > 4096) fail('request_too_large');
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) fail('invalid_content_type');
  const text = await request.text();
  if (text.length > 4096) fail('request_too_large');
  return new URLSearchParams(text);
}
export async function handleSetup(request: Request, env: Env, requestFetch: typeof fetch = fetch): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.hostname !== SETUP_HOST || url.port) return new Response('Not found', { status: 404 });
    await verifyAccess(request, env, requestFetch);
    if (url.pathname === '/setup' && request.method === 'GET') {
      const csrf = nonce();
      const accounts = await listAccounts(env);
      const rows = accounts.map(entry => {
        const item = entry as Pick<MailAccount, 'account_id' | 'provider' | 'address' | 'alias' | 'status'>;
        return '<li><strong>' + escapeHtml(item.address) + '</strong> (' + escapeHtml(item.provider) + ' / ' +
          escapeHtml(item.status) + ') ' + escapeHtml(item.alias) +
          '<form method="post" action="/setup/remove"><input type="hidden" name="csrf" value="' + csrf + '">' +
          '<input type="hidden" name="account_id" value="' + escapeHtml(item.account_id) + '">' +
          '<button type="submit">Remove</button></form>' +
          '<details><summary>Reconnect IMAP/SMTP</summary>' +
          imapForm(csrf, item.account_id, item.address) + '</details>' +
          '<form method="post" action="/setup/alias"><input type="hidden" name="csrf" value="' + csrf + '">' +
          '<input type="hidden" name="account_id" value="' + escapeHtml(item.account_id) + '">' +
          '<label>Alias <input name="alias" maxlength="80" value="' + escapeHtml(item.alias ?? '') + '"></label>' +
          '<button type="submit">Save alias</button></form></li>';
      }).join('');
      return securedHtml('<h1>Mail accounts</h1><p>Only the Access-authorized owner can manage connected mailboxes.</p>' +
        '<ul>' + (rows || '<li>No accounts</li>') + '</ul>' +
        '<fieldset><legend>Add IMAP/SMTP account</legend>' + imapForm(csrf) + '</fieldset>' +
        '<fieldset><legend>Credential key rotation</legend><form method="post" action="/setup/rotate">' +
        '<input type="hidden" name="csrf" value="' + csrf + '">' +
        '<button type="submit">Re-encrypt with current key</button></form></fieldset>',
      csrfCookie(csrf));
    }
    if (url.pathname === '/setup/imap/add' && request.method === 'POST') {
      const data = await formValues(request);
      validateCsrf(request, data.get('csrf') ?? '');
      const address = (data.get('address') ?? '').trim().toLowerCase();
      if (!/^[^@\s,<>]{1,100}@[^@\s,<>]{3,200}$/.test(address)) fail('invalid_mail_identity');
      if (/^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|msn\.com)$/i.test(address.split('@')[1] ?? '')) fail('unsupported_provider');
      const cfg = validateProtocolCredentials({
        imap_host: data.get('imap_host') ?? '', imap_port: 993,
        smtp_host: data.get('smtp_host') ?? '',
        smtp_port: Number(data.get('smtp_port')) as 465 | 587,
        username: data.get('username') ?? '', password: data.get('password') ?? '',
      });
      // No D1 credentials are saved unless IMAP TLS and authentication actually succeed.
      await verifyImapCredentials(cfg);
      await verifySmtpCredentials(cfg);
      const now = Math.floor(Date.now() / 1000);
      const requestedId = data.get('account_id');
      if (requestedId && !/^[0-9a-f-]{36}$/i.test(requestedId)) fail('invalid_account');
      if (requestedId) {
        const existing = await env.DB.prepare(
          'SELECT provider,address,status FROM mail_accounts WHERE account_id=?',
        ).bind(requestedId).first<Pick<MailAccount, 'provider' | 'address' | 'status'>>();
        if (!existing || existing.provider !== 'imap_smtp' || existing.status === 'disabled' ||
          existing.address.toLowerCase() !== address) fail('reauthorization_identity_mismatch');
      }
      const accountId = requestedId ?? crypto.randomUUID();
      const sealed = await encrypt(env, 'account:' + accountId + ':imap_smtp', cfg);
      if (requestedId) {
        const updated = await env.DB.prepare(
          'UPDATE mail_accounts SET status=?,credential_ciphertext=?,credential_key_id=?,updated_at=? WHERE account_id=? AND provider=? AND lower(address)=? AND status!=?',
        ).bind('active', sealed.ciphertext, sealed.keyId, now, accountId, 'imap_smtp', address, 'disabled').run();
        if (updated.meta.changes !== 1) fail('reauthorization_identity_mismatch');
      } else {
        await env.DB.prepare('INSERT INTO mail_accounts(account_id,provider,address,alias,status,credential_ciphertext,credential_key_id,created_at,updated_at) VALUES(?,?,?,NULL,?,?,?,?,?)')
          .bind(accountId, 'imap_smtp', address, 'active', sealed.ciphertext, sealed.keyId, now, now).run();
      }
      return new Response(null, { status: 303, headers: { location: '/setup', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/setup/alias' && request.method === 'POST') {
      const data = await formValues(request);
      validateCsrf(request, data.get('csrf') ?? '');
      const accountId = data.get('account_id') ?? '';
      const alias = (data.get('alias') ?? '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(accountId) || alias.length > 80 ||
        /[\u0000-\u001f\u007f]/.test(alias)) fail('invalid_account_alias');
      const updated = await env.DB.prepare('UPDATE mail_accounts SET alias=?,updated_at=? WHERE account_id=? AND status!=?')
        .bind(alias || null, Math.floor(Date.now() / 1000), accountId, 'disabled').run();
      if (updated.meta.changes !== 1) fail('account_not_found');
      return new Response(null, { status: 303, headers: {
        location: '/setup', 'cache-control': 'no-store',
      } });
    }
    if (url.pathname === '/setup/rotate' && request.method === 'POST') {
      const data = await formValues(request);
      validateCsrf(request, data.get('csrf') ?? '');
      const result = await rotateCredentials(env);
      return securedHtml('<h1>Key rotation readback</h1><p>Rotated: ' + result.rotated +
        ', remaining: ' + result.pending + '.</p><p>Keep the previous key until remaining reaches zero and provider tests pass.</p>' +
        '<p><a href="/setup">Back to accounts</a></p>');
    }
    if (url.pathname === '/setup/remove' && request.method === 'POST') {
      const data = await formValues(request);
      validateCsrf(request, data.get('csrf') ?? '');
      const id = data.get('account_id') ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) fail('invalid_account');
      const account = await env.DB.prepare('SELECT account_id FROM mail_accounts WHERE account_id=?').bind(id).first<{ account_id: string }>();
      if (!account) fail('account_not_found');
      // D1 batch runs transactionally; local authorization removal is not gated by upstream availability.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM send_attempts WHERE account_id=?').bind(id),
        env.DB.prepare('DELETE FROM mail_accounts WHERE account_id=?').bind(id),
      ]);
      return securedHtml('<h1>Local account removed</h1><p>IMAP/SMTP credentials erased from the local registry.</p>' +
        '<p><a href="/setup">Back to accounts</a></p>');
    }
    return new Response('Not found', { status: 404 });
  } catch (err) {
    const code = err instanceof MailError ? err.code : 'setup_unavailable';
    const status = code === 'not_found' ? 404 : code === 'unauthorized' ? 403 : code === 'auth_misconfigured' ? 503 : 400;
    const explanation = code === 'csrf_rejected'
      ? '<p>The form session expired or the request was blocked. Reopen the page to get a fresh form, then try again.</p>' +
        '<p><a href="/setup">Reload the account setup form</a></p>' : '';
    return new Response('<!doctype html><html><h1>Request failed</h1><p>' + escapeHtml(code) + '</p>' + explanation + '</html>', {
      status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' },
    });
  }
}
