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
    '<title>Database MCP connections</title><style>html{color-scheme:light dark}body{max-width:720px;margin:24px auto;padding:0 16px;font:16px/1.5 system-ui}' +
    'h1{margin:0 0 6px}p{margin:8px 0}.muted,.meta{opacity:.72;font-size:.9em}fieldset{margin:18px 0;padding:16px;border:1px solid #888;border-radius:8px}' +
    'form{display:grid;gap:12px;margin:12px 0}input,select,button{padding:8px;font:inherit;border-radius:5px}label{display:grid;gap:4px}' +
    'label:not(.check)>input{box-sizing:border-box;width:100%}.check{display:flex;align-items:center;gap:8px}.check input{margin:0;width:17px;height:17px;flex:none}' +
    'button{justify-self:start;cursor:pointer;padding:8px 16px}summary{cursor:pointer}details{margin:10px 0}.connections{padding-left:22px}' +
    '.connections li{margin:12px 0;padding:0 0 12px;border-bottom:1px solid #7775}.connections form{margin:8px 0}.maintenance{margin:16px 0}</style><main>' + body + '</main></html>',
    { status, headers });
}
function token(csrf: string): string { return `<input type="hidden" name="csrf" value="${escape(csrf)}">`; }
function ids(row: RegistryMetadata): string {
  return `<input type="hidden" name="id" value="${escape(row.id)}"><input type="hidden" name="revision" value="${row.revision}">`;
}
function action(row: RegistryMetadata, csrf: string, verb: 'enable' | 'disable' | 'delete'): string {
  return `<form action="/setup/${verb}" method="post">${token(csrf)}${ids(row)}` +
    (verb === 'delete' ? '<label>Type connection ID to confirm retirement<input name="confirm_id" required></label>' : '') +
    (verb === 'enable' && row.transport === 'direct' ? '<label class="check"><input type="checkbox" name="plaintext_ack" value="1" required>I accept unencrypted Direct transport.</label>' : '') +
    `<button type="submit">${verb}</button></form>`;
}
const plaintextAck = '<label class="check"><input type="checkbox" name="plaintext_ack" value="1">I accept unencrypted Direct transport.</label>';
const plaintextAckRequired = '<label class="check"><input type="checkbox" name="plaintext_ack" value="1" required>I accept unencrypted Direct transport.</label>';
const directUrlHint = '<details><summary>URL format help</summary><p class="muted">' +
  '<code>mysql://USER:PASSWORD@HOST:3306/DATABASE</code> or ' +
  '<code>postgres://USER:PASSWORD@HOST:5432/DATABASE</code>. ' +
  'Use a public IP or hostname; no URL query parameters. Direct is unencrypted.</p></details>';
export function setupPage(rows: RegistryMetadata[], csrf: string): Response {
  const list = rows.map(row => `<li><strong>${escape(row.id)}</strong> <span class="meta">${escape(row.dialect)} / ${escape(row.transport)} · ${escape(row.status)}</span>` +
    (row.status === 'active' ? action(row, csrf, 'disable') :
      row.transport === 'direct' && isAvailableMode(row.transport, row.dialect)
        ? action(row, csrf, 'enable') + action(row, csrf, 'delete') :
      row.transport === 'hyperdrive' ? '' : action(row, csrf, 'delete')) +
    (row.transport === 'hyperdrive'
      ? '<p class="muted">Hyperdrive actions run in protected GitHub Actions after exact binding, CA and cache verification. A successful request does not confirm completion.</p>' +
        (row.status === 'disabled'
          ? '<details><summary>Manage Hyperdrive via GitHub Actions</summary>' +
            '<p class="muted">Enable requires a published, reviewed binding. Retirement requires a prior unbinding release and no remaining rollback dependency.</p>' +
            '<form method="post" action="/setup/hyperdrive-action">' + token(csrf) + ids(row) +
            '<input type="hidden" name="hyperdrive_action" value="enable">' +
            '<button type="submit">Request enable</button></form>' +
            '<form method="post" action="/setup/hyperdrive-action">' + token(csrf) + ids(row) +
            '<input type="hidden" name="hyperdrive_action" value="retire">' +
            '<label>Type connection ID to confirm retirement<input name="confirm_id" required></label>' +
            '<button type="submit">Request retirement</button></form></details>'
          : '') +
        '<p class="muted"><a href="https://github.com/lirtual/mcp-workers/actions/workflows/release.yml" rel="noreferrer">View GitHub Actions results</a></p>'
      : !isAvailableMode(row.transport, row.dialect) ? '<p class="muted">This connection mode is not yet enabled.</p>' :
    `<details><summary>Edit connection</summary><form action="/setup/edit" method="post">${token(csrf)}${ids(row)}` +
    '<label>Credentials<select name="credential_mode"><option value="keep">Keep URL</option><option value="replace">Replace URL</option></select></label>' +
    '<label>New URL (only when replacing)<input type="password" name="url" autocomplete="off" maxlength="8192"></label>' +
    '<p class="muted">Host, port and database cannot change for this ID. Use a new ID for a new target.</p>' +
    plaintextAck +
    (row.status === 'disabled' ? '<label class="check"><input type="checkbox" name="allow_disabled" value="1">Keep disabled if unreachable</label>' : '') +
    '<button type="submit">Test and save</button></form></details>') + '</li>').join('');
  return htmlResponse('<h1>Database connections</h1><p class="muted">Manage up to 10 connections. Credentials are never displayed.</p>' +
    `<ul class="connections">${list || '<li>No database connections configured</li>'}</ul>` +
    '<fieldset><legend>Add Direct connection</legend><form method="post" action="/setup/add">' + token(csrf) +
    '<label>Connection ID<input name="id" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" required></label>' +
    '<input type="hidden" name="transport" value="direct">' +
    '<label>Dialect<select name="dialect"><option value="mysql">MySQL</option><option value="postgres">PostgreSQL</option></select></label>' +
    '<label>Database URL<input type="password" name="url" maxlength="8192" autocomplete="off" required></label>' +
    directUrlHint + plaintextAckRequired +
    '<details><summary>Advanced options</summary><label class="check"><input type="checkbox" name="allow_disabled" value="1">Save disabled if connection test fails</label>' +
    '<p class="muted">A disabled connection cannot be used until it passes a connection check.</p></details>' +
    '<button type="submit">Add Direct connection</button></form></fieldset>' +
    '<details><summary>Add Hyperdrive reference</summary><p class="muted">First create a dedicated Hyperdrive config with strict CA/hostname verification and caching disabled. The reference starts disabled; only protected Actions may activate it.</p>' +
    '<form method="post" action="/setup/add">' + token(csrf) +
    '<input type="hidden" name="transport" value="hyperdrive">' +
    '<label>Connection ID<input name="id" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" required></label>' +
    '<label>Dialect<select name="dialect"><option value="mysql">MySQL</option><option value="postgres">PostgreSQL</option></select></label>' +
    '<label>Cloudflare config ID<input name="config_id" maxlength="64" required></label>' +
    '<label>Binding name<input name="binding_name" pattern="HYPERDRIVE_[A-Z0-9_]{1,54}" maxlength="65" required></label>' +
    '<button type="submit">Save disabled reference</button></form></details>' +
    '<details class="maintenance"><summary>Maintenance</summary><p class="muted">Re-encrypt saved connections when changing encryption keys; this does not change MySQL passwords.</p>' +
    '<p class="muted">Before rotating, independently verify that every rollback-eligible Worker version can decrypt the new key, and retain historical keys until D1 snapshots and backups no longer need them. This page cannot verify those external requirements.</p>' +
    '<form method="post" action="/setup/rotate">' + token(csrf) +
    '<label class="check"><input type="checkbox" name="rotation_ack" value="verified" required>I verified rollback compatibility and retained-key recovery.</label>' +
    '<button type="submit">Rotate encryption keys</button></form></details>', csrf);
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
