import type { RegistryMetadata } from '../registry/store.js';
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
    (verb === 'delete' ? '<label>Type connection ID to confirm deletion<input name="confirm_id" required></label>' : '') +
    `<button type="submit">${verb}</button></form>`;
}
export function setupPage(rows: RegistryMetadata[], csrf: string): Response {
  const list = rows.map(row => `<li><strong>${escape(row.id)}</strong> — ${escape(row.dialect)} / ${escape(row.status)} · revision ${row.revision}` +
    (row.status === 'active' ? action(row, csrf, 'disable') : action(row, csrf, 'enable') + action(row, csrf, 'delete')) +
    `<details><summary>Edit or replace credentials</summary><form action="/setup/edit" method="post">${token(csrf)}${ids(row)}` +
    '<label>Credential mode<select name="credential_mode"><option value="keep">Keep previous URL</option><option value="replace">Replace URL</option></select></label>' +
    '<label>New database URL (only for replace; never prefilled)<input type="password" name="url" autocomplete="off" maxlength="8192"></label>' +
    '<label>Certificate authority<select name="ca_mode"><option value="keep">Keep current CA</option><option value="replace">Replace CA</option><option value="clear">Remove CA</option></select></label>' +
    '<label>New CA PEM (only for replace; never prefilled)<textarea name="ca" rows="5" maxlength="16384" autocomplete="off"></textarea></label>' +
    (row.status === 'disabled' ? '<label><input type="checkbox" name="allow_disabled" value="1">Keep disabled if the candidate is unreachable</label>' : '') +
    '<button type="submit">Test and save edit</button></form></details></li>').join('');
  return htmlResponse('<h1>Database connections</h1><p>Access-authorized Owner only. Passwords, complete URLs and CA PEM contents are never displayed. Copy the Aiven service URI without URL query options: verified TLS is enforced by the Worker.</p>' +
    '<p>URL and CA have separate input limits and a combined UTF-8 encrypted-storage limit. Shorten the URL or CA if the combined configuration is too large.</p>' +
    `<ul>${list || '<li>No database connections configured</li>'}</ul>` +
    '<fieldset><legend>Add connection</legend><form method="post" action="/setup/add">' + token(csrf) +
    '<label>Immutable ID<input name="id" maxlength="64" required></label>' +
    '<label>Dialect<select name="dialect"><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select></label>' +
    '<label>Database URL<input type="password" name="url" maxlength="8192" autocomplete="off" required></label>' +
    '<label>Aiven CA certificate PEM (optional; encrypted in D1)<textarea name="ca" rows="5" maxlength="16384" autocomplete="off"></textarea></label>' +
    '<label><input type="checkbox" name="allow_disabled" value="1">Save disabled if health check cannot reach server</label>' +
    '<button type="submit">Validate and add</button></form></fieldset>' +
    '<fieldset><legend>Configuration key rotation</legend><form method="post" action="/setup/rotate">' + token(csrf) +
    '<button type="submit">Rotate next batch</button></form></fieldset>', csrf);
}
export function setupFailure(code: string, status: number): Response {
  return htmlResponse(`<h1>Request rejected</h1><p>${escape(code)}</p><a href="/setup">Back to connections</a>`, undefined, status);
}
export function setupResult(message: string): Response {
  return htmlResponse(`<h1>Connection management</h1><p>${escape(message)}</p><a href="/setup">Back to connections</a>`);
}
