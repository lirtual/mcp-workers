import { csrfCookie, validateCsrf, verifyAccess } from './access.ts';
import { nonce } from './crypto.ts';
import { beginOAuth, completeOAuth, revokeIfSupported } from './oauth.ts';
import { listAccounts } from './tools.ts';
import { fail, MailError, SETUP_HOST } from './types.ts';
import type { Env, MailAccount, Provider } from './types.ts';

function escapeHtml(input: unknown): string {
  return String(input ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]!);
}
function securedHtml(body: string, cookie?: string): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  });
  if (cookie) headers.set('set-cookie', cookie);
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Email Accounts</title>' +
    '<style>body{max-width:720px;margin:40px auto;font:16px system-ui;line-height:1.5;padding:0 20px}' +
    'fieldset{margin:20px 0;padding:16px}button{padding:8px 12px}</style><main>' + body + '</main></html>', { headers });
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
    const owner = await verifyAccess(request, env, requestFetch);
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
          (item.provider !== 'imap_smtp'
            ? '<form method="post" action="/setup/oauth/start"><input type="hidden" name="csrf" value="' + csrf + '">' +
              '<input type="hidden" name="provider" value="' + escapeHtml(item.provider) + '">' +
              '<input type="hidden" name="account_id" value="' + escapeHtml(item.account_id) + '">' +
              '<button type="submit">Reauthorize</button></form>' : '') +
          '<form method="post" action="/setup/alias"><input type="hidden" name="csrf" value="' + csrf + '">' +
          '<input type="hidden" name="account_id" value="' + escapeHtml(item.account_id) + '">' +
          '<label>Alias <input name="alias" maxlength="80" value="' + escapeHtml(item.alias ?? '') + '"></label>' +
          '<button type="submit">Save alias</button></form></li>';
      }).join('');
      return securedHtml('<h1>Mail accounts</h1><p>Only the Access-authorized owner can manage connected mailboxes.</p>' +
        '<ul>' + (rows || '<li>No accounts</li>') + '</ul>' +
        '<fieldset><legend>Add OAuth mailbox</legend><form method="post" action="/setup/oauth/start">' +
        '<input type="hidden" name="csrf" value="' + csrf + '">' +
        '<select name="provider"><option value="gmail">Gmail</option><option value="graph">Microsoft Graph</option></select>' +
        '<button type="submit">Authorize mailbox</button></form></fieldset>' +
        '<p>Generic IMAP/SMTP onboarding is disabled until Workers-native TLS and destination filtering pass real integration tests.</p>',
      csrfCookie(csrf));
    }
    if (url.pathname === '/setup/oauth/start' && request.method === 'POST') {
      const data = await formValues(request);
      validateCsrf(request, data.get('csrf') ?? '');
      const provider = data.get('provider') as Provider;
      if (provider !== 'gmail' && provider !== 'graph') fail('unsupported');
      const accountId = data.get('account_id') ?? undefined;
      if (accountId && !/^[0-9a-f-]{36}$/i.test(accountId)) fail('invalid_account');
      const redirect = await beginOAuth(env, provider, owner.sub, accountId);
      return new Response(null, { status: 303, headers: { location: redirect, 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/oauth/callback' && request.method === 'GET') {
      if (url.searchParams.has('error')) fail('reauthorization_required');
      const accountId = await completeOAuth(env, url.searchParams.get('state') ?? '',
        url.searchParams.get('code') ?? '', owner.sub, requestFetch);
      return securedHtml('<h1>Mailbox authorized</h1><p>Account ID: <code>' + escapeHtml(accountId) +
        '</code></p><p><a href="/setup">Back to accounts</a></p>');
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
    if (url.pathname === '/setup/remove' && request.method === 'POST') {
      const data = await formValues(request);
      validateCsrf(request, data.get('csrf') ?? '');
      const id = data.get('account_id') ?? '';
      if (!/^[0-9a-f-]{36}$/i.test(id)) fail('invalid_account');
      const account = await env.DB.prepare('SELECT * FROM mail_accounts WHERE account_id=?').bind(id).first<MailAccount>();
      if (!account) fail('account_not_found');
      // D1 batch runs transactionally; local authorization removal is not gated by upstream availability.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM send_attempts WHERE account_id=?').bind(id),
        env.DB.prepare('DELETE FROM mail_accounts WHERE account_id=?').bind(id),
      ]);
      const revoked = await revokeIfSupported(env, account, requestFetch);
      return securedHtml('<h1>Local account removed</h1><p>Upstream revocation: ' +
        (revoked ? 'confirmed' : 'not confirmed; revoke provider access manually if needed') +
        '.</p><p><a href="/setup">Back to accounts</a></p>');
    }
    return new Response('Not found', { status: 404 });
  } catch (err) {
    const code = err instanceof MailError ? err.code : 'setup_unavailable';
    const status = code === 'not_found' ? 404 : code === 'unauthorized' ? 403 : code === 'auth_misconfigured' ? 503 : 400;
    return new Response('<!doctype html><html><h1>Request failed</h1><p>' + escapeHtml(code) + '</p></html>', {
      status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' },
    });
  }
}
