import type { RegistryMetadata } from '../registry/store.js';
import { isAvailableMode } from '../registry/availability.js';
import { csrfCookie } from './access.js';

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
const csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
export function htmlResponse(body: string, csrf?: string, status = 200): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': csp, 'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin', 'x-frame-options': 'DENY'
  });
  if (csrf) headers.set('set-cookie', csrfCookie(csrf));
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Database MCP connections</title><style>html{color-scheme:light dark}body{max-width:840px;margin:24px auto;padding:0 16px;font:16px/1.5 system-ui}' +
    'fieldset{margin:20px 0;border:1px solid #999;border-radius:8px;padding:16px}form{display:grid;gap:10px;margin:12px 0}' +
    'input,select,textarea,button{padding:8px;font:inherit}label{display:grid;gap:4px}details{margin:12px 0}li{margin:20px 0}</style><main>' + body + '</main></html>',
    { status, headers });
}
function token(csrf: string): string { return `<input type="hidden" name="csrf" value="${escape(csrf)}">`; }
function ids(row: RegistryMetadata): string {
  return `<input type="hidden" name="id" value="${escape(row.id)}"><input type="hidden" name="revision" value="${row.revision}">`;
}
function action(row: RegistryMetadata, csrf: string, verb: 'enable' | 'disable' | 'delete'): string {
  return `<form action="/setup/${verb}" method="post">${token(csrf)}${ids(row)}` +
    (verb === 'delete' ? '<label>Type connection ID to confirm retirement<input name="confirm_id" required></label>' : '') +
    (verb === 'enable' && row.transport === 'direct' ? '<label><input type="checkbox" name="plaintext_ack" value="1" required>I accept that enabling Direct sends credentials and SQL over plaintext TCP.</label>' : '') +
    `<button type="submit">${verb}</button></form>`;
}
const plaintextAck = '<label><input type="checkbox" name="plaintext_ack" value="1">I understand Direct sends database passwords and queries without TLS; traffic may be intercepted.</label>';
const plaintextAckRequired = '<label><input type="checkbox" name="plaintext_ack" value="1" required>I explicitly accept unencrypted Direct transport.</label>';
const directUrlHint = '<p>URL format: <code>mysql://USERNAME:PASSWORD@db.yourdomain.com:3306/DATABASE</code>. ' +
  'A public DNS hostname is required (no literal IP, localhost or private address). ' +
  'Do not append query parameters. Percent-encode URL-reserved characters in usernames or passwords.</p>';
export function setupPage(rows: RegistryMetadata[], csrf: string): Response {
  const list = rows.map(row => `<li><strong>${escape(row.id)}</strong> — ${escape(row.dialect)} / ${escape(row.transport)} / ${escape(row.status)} · revision ${row.revision}` +
    (row.status === 'active' ? action(row, csrf, 'disable') :
      (isAvailableMode(row.transport, row.dialect) ? action(row, csrf, 'enable') : '') + action(row, csrf, 'delete')) +
    (!isAvailableMode(row.transport, row.dialect) ? '<p>This connection mode is not enabled in the current release. Existing records cannot be enabled or edited.</p>' :
    `<details><summary>Edit or replace Direct credentials</summary><form action="/setup/edit" method="post">${token(csrf)}${ids(row)}` +
    '<label>Credential mode<select name="credential_mode"><option value="keep">Keep URL</option><option value="replace">Replace URL</option></select></label>' +
    '<label>Replacement URL (never prefilled)<input type="password" name="url" autocomplete="off" maxlength="8192"></label>' +
    plaintextAck +
    (row.status === 'disabled' ? '<label><input type="checkbox" name="allow_disabled" value="1">Keep disabled if unreachable</label>' : '') +
    '<button type="submit">Test and save edit</button></form></details>') + '</li>').join('');
  return htmlResponse('<h1>Database connections</h1><p>Owner-only. Passwords and origin URLs are never displayed. At most 10 connections; removed IDs are never reused.</p>' +
    '<p><strong>Available now:</strong> MySQL Direct plaintext only (explicit consent). PostgreSQL Direct and Hyperdrive require separate acceptance before activation. No fallback.</p>' +
    `<ul>${list || '<li>No database connections configured</li>'}</ul>` +
    '<fieldset><legend>Add connection</legend><form method="post" action="/setup/add">' + token(csrf) +
    '<label>Immutable ID<input name="id" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" required placeholder="b2b"></label>' +
    '<label>Dialect<select name="dialect"><option value="mysql">MySQL</option></select></label>' +
    '<label>Transport<select name="transport"><option value="direct">Direct plaintext</option></select></label>' +
    directUrlHint +
    '<label>Direct URL (credentials are never displayed)<input type="password" name="url" maxlength="8192" autocomplete="off" required></label>' +
    plaintextAckRequired +
    '<label><input type="checkbox" name="allow_disabled" value="1">Save Direct candidate disabled if unreachable</label>' +
    '<button type="submit">Validate and add</button></form></fieldset>' +
    '<fieldset><legend>Direct key rotation</legend><form method="post" action="/setup/rotate">' + token(csrf) +
    '<button type="submit">Rotate next bounded batch</button></form></fieldset>', csrf);
}
export function setupFailure(code: string, status: number, reference?: string): Response {
  // References are fixed internal codes supplied by the handler, never raw exceptions.
  const detail = reference && /^[a-z_]{1,40}$/.test(reference)
    ? `<p>Diagnostic: ${escape(reference)}</p>` : '';
  return htmlResponse(`<h1>Request rejected</h1><p>${escape(code)}</p>${detail}<a href="/setup">Back to connections</a>`, undefined, status);
}
export function setupResult(message: string): Response {
  return htmlResponse(`<h1>Connection management</h1><p>${escape(message)}</p><a href="/setup">Back to connections</a>`);
}
