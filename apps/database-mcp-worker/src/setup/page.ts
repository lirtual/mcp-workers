import { canApplyHyperdrive } from './hyperdrive-operations.js';
import type { RegistryMetadata } from '../registry/store.js';
import type { HyperdriveOperationSummary } from './hyperdrive-operations.js';
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
    '.connections li{margin:12px 0;padding:0 0 12px;border-bottom:1px solid #7775}.connections form{margin:8px 0}.maintenance{margin:16px 0}.choices{display:flex;flex-wrap:wrap;gap:12px}.choices label{display:flex;align-items:center;gap:5px}.add-connection .fields-input,.add-connection .hyperdrive-ca{display:none}.add-connection:has(input[name=input_mode][value=fields]:checked) .fields-input{display:grid;gap:12px}.add-connection:has(input[name=input_mode][value=fields]:checked) .url-input{display:none}.add-connection:has(input[name=transport][value=hyperdrive]:checked) .hyperdrive-ca{display:block}.add-connection:has(input[name=transport][value=hyperdrive]:checked) .direct-warning{display:none}.add-connection.replacement .hyperdrive-ca{display:block}.add-connection.replacement .direct-warning{display:none}.add-connection .hyperdrive-ca textarea{box-sizing:border-box;width:100%}</style><main>' + body + '</main></html>',
    { status, headers });
}
function token(csrf: string): string { return `<input type="hidden" name="csrf" value="${escape(csrf)}">`; }
function ids(row: RegistryMetadata): string {
  return `<input type="hidden" name="id" value="${escape(row.id)}"><input type="hidden" name="revision" value="${row.revision}">`;
}
function action(row: RegistryMetadata, csrf: string, verb: 'enable' | 'disable' | 'delete'): string {
  return `<form action="/setup/${verb}" method="post">${token(csrf)}${ids(row)}` +
    (verb === 'delete' && row.transport === 'hyperdrive'
      ? '<p class="muted">Retire this disabled logical connection only. Its immutable ID is never reusable. Hyperdrive config, Binding and CA remain for separate cleanup.</p>' : '') +
    (verb === 'delete' ? '<label>Type connection ID to confirm retirement<input name="confirm_id" required></label>' : '') +
    `<button type="submit">${verb}</button></form>`;
}
export interface ReplacementOrigin { host: string; port: number; database: string; }
function addConnectionForm(csrf: string, replacing?: RegistryMetadata, origin?: ReplacementOrigin): string {
  return `<fieldset><legend>${replacing ? 'Edit Hyperdrive (new Connection ID)' : 'Add connection'}</legend><form class="add-connection${replacing ? ' replacement' : ''}" id="add-connection" method="post" action="/setup/add">${token(csrf)}
    ${replacing ? '<p class="muted">Replace ' + escape(replacing.id) + ' with a new Connection ID using the same database target. The existing connection stays active during preparation. After protected release and verified activation, update each client to the new Connection ID, verify usage, then disable the old ID. Old bindings and rollback resources must be retained until separately proven unused.</p>' : ''}
    <label>Connection ID<input name="id" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" required></label>
    ${replacing ? '<p>Database: ' + escape(replacing.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL') + '</p><input type="hidden" name="dialect" value="' + escape(replacing.dialect) + '">' : '<label>Database<select name="dialect"><option value="mysql">MySQL</option><option value="postgres">PostgreSQL</option></select></label>'}
    ${replacing ? '<p>Transport: Hyperdrive (strict TLS)</p><input type="hidden" name="transport" value="hyperdrive">' : '<div class="choices" role="group" aria-label="Connection transport"><label><input type="radio" name="transport" value="direct" checked>Direct (plaintext)</label><label><input type="radio" name="transport" value="hyperdrive">Hyperdrive (strict TLS)</label></div>'}
    <div class="choices" role="group" aria-label="Connection input"><label><input type="radio" name="input_mode" value="url"${replacing ? '' : ' checked'}>Connection URL</label><label><input type="radio" name="input_mode" value="fields"${replacing ? ' checked' : ''}>Host and credentials</label></div>
    <div class="url-input"><label>Connection URL<input name="url" type="password" autocomplete="off" maxlength="8192" placeholder="postgresql://user:password@host/database"></label></div>
    <div class="fields-input"><label>Host<input name="host" autocomplete="off" maxlength="253"${origin ? ' value="' + escape(origin.host) + '" readonly' : ''}></label>
    <label>Port (optional; MySQL 3306 / PostgreSQL 5432)<input name="port" inputmode="numeric" type="number" min="1" max="65535"${origin ? ' value="' + origin.port + '" readonly' : ''}></label>
    <label>Database<input name="database" maxlength="128"${origin ? ' value="' + escape(origin.database) + '" readonly' : ''}></label><label>Username<input name="username" maxlength="128" autocomplete="off"></label>
    <label>Password<input name="password" type="password" maxlength="2048" autocomplete="off"></label></div>
    <div class="direct-warning"><p><strong>Direct is unencrypted TCP.</strong> Credentials and SQL travel without transport encryption. Use Hyperdrive when TLS is required.</p>
    <label class="check"><input type="checkbox" name="plaintext_ack" value="1">I accept plaintext Direct transport for this new connection.</label></div>
    <div class="hyperdrive-ca"><p class="muted">Hyperdrive strictly verifies certificates and hostnames with caching disabled. Provide the origin CA PEM where needed. Protected GitHub Actions prepares the config and Binding; a reviewed production release requires one separate approval.</p>
    <details><summary>CA PEM (only if no suitable CA is on record)</summary>
    <label>Certificate PEM<textarea name="ca_pem" rows="3" maxlength="16384" autocomplete="off"></textarea></label></details>
    ${replacing ? '<input type="hidden" name="replacement_for" value="' + escape(replacing.id) + '">' : '<details><summary>Prepare a Hyperdrive replacement (new ID)</summary><p class="muted">Use a new Connection ID and the same database host, port and database. You may change the username, password and CA while the original stays active. The old config and rollback references remain unchanged; protected release and health verification still apply.</p><label>Existing Hyperdrive Connection ID (active or disabled)<input name="replacement_for" maxlength="64" autocomplete="off"></label></details>'}
</div>
    <button type="submit">Save connection</button></form></fieldset>`;
}
export function setupPage(rows: RegistryMetadata[], csrf: string,
  operations: HyperdriveOperationSummary[] = [], retiredHyperdriveIds: string[] = [], replacing?: RegistryMetadata,
  replacementOrigin?: ReplacementOrigin): Response {
  const list = rows.map(row => `<li><strong>${escape(row.id)}</strong> <span class="meta">${escape(row.dialect)} / ${escape(row.transport)} · ${escape(row.status)}</span>` +
    (row.transport === 'hyperdrive' && (row.in_flight_count ?? 0) > 0
      ? `<p><strong>Blocked: ${row.in_flight_count} unresolved execution(s).</strong> New SQL is disabled when this connection is disabled. Do not delete or rotate its resources without independently verified completion; no automatic timeout or count reset is performed.</p>` : '') +
    (row.status === 'active' ? action(row, csrf, 'disable') :
      row.transport === 'direct' && isAvailableMode(row.transport, row.dialect)
        ? action(row, csrf, 'enable') + action(row, csrf, 'delete') :
      row.status === 'disabled' ? (row.transport === 'direct'
        ? action(row, csrf, 'enable') : '') +
        ((row.in_flight_count ?? 0) === 0 ? action(row, csrf, 'delete') : '') : '') +
    (row.transport === 'hyperdrive'
      ? (row.status === 'disabled'
        ? '<form method="post" action="/setup/hyperdrive-action">' + token(csrf) + ids(row) +
          '<input type="hidden" name="hyperdrive_action" value="enable">' +
          '<button type="submit">Enable</button></form>' +
          '<details><summary>Edit connection</summary>' +
          '<p class="muted">Only isolated, disabled and unbound credentials can be updated without affecting a live or rollback Worker. Existing credentials are never shown. Unsafe changes are blocked.</p>' +
          '<form method="post" action="/setup/hyperdrive-credentials">' + token(csrf) + ids(row) +
          '<label>New password<input name="new_password" type="password" maxlength="2048" autocomplete="off" required></label>' +
          '<label>Type connection ID to confirm password update<input name="confirm_id" required></label>' +
          '<label class="check"><input type="checkbox" name="confirm_credentials" value="1" required>Update password only after protected isolation checks</label>' +
          '<button type="submit">Save new password</button></form>' +
          '<p class="muted">To change the username or CA safely, <a href="/setup?edit=' + encodeURIComponent(row.id) + '#add-connection">Edit through a new Connection ID</a>. Existing rollback references stay unchanged until separately verified cutover.</p></details>' +
          '<details><summary>Advanced resource cleanup</summary><p class="muted">Logical Delete above does not remove Cloudflare resources. Release or delete historical bindings and certificates only after independently verifying all active and rollback references.</p>' +
          '<form method="post" action="/setup/hyperdrive-action">' + token(csrf) + ids(row) +
          '<input type="hidden" name="hyperdrive_action" value="retire">' +
          '<label>Type connection ID to request an unbinding review<input name="confirm_id" required></label>' +
          '<button type="submit">Stage unbinding review</button></form>' +
          '<form method="post" action="/setup/hyperdrive-unbind-status">' + token(csrf) + ids(row) +
          '<button type="submit">Read unbinding status</button></form></details>'
        : '<p class="muted"><a href="/setup?edit=' + encodeURIComponent(row.id) + '#add-connection">Edit connection</a> using a new Connection ID while the original remains available. Disable the original only before retirement.</p>') +
        '<p class="muted">Hyperdrive operations require protected Binding/TLS/CA verification. A request being accepted never proves completion.</p>' +
        '<p class="muted"><a href="https://github.com/lirtual/mcp-workers/actions/workflows/release.yml" rel="noreferrer">View operation runs</a></p>'
      : !isAvailableMode(row.transport, row.dialect) ? '<p class="muted">This connection mode is not yet enabled.</p>' :
    `<details><summary>Edit connection</summary><form class="add-connection" action="/setup/edit" method="post">${token(csrf)}${ids(row)}` +
    '<label>Credentials<select name="credential_mode"><option value="keep">Keep URL</option><option value="replace">Replace URL</option></select></label>' +
    '<div class="choices"><label><input type="radio" name="input_mode" value="url" checked>Connection URL</label><label><input type="radio" name="input_mode" value="fields">Host and credentials</label></div>' +
    '<div class="url-input"><label>New URL (when replacing)<input type="password" name="url" autocomplete="off" maxlength="8192"></label></div>' +
    '<div class="fields-input"><label>Host<input name="host"></label><label>Port<input name="port" type="number" min="1" max="65535"></label><label>Database<input name="database"></label><label>Username<input name="username"></label><label>Password<input type="password" name="password" autocomplete="off"></label></div>' +
    '<p class="muted">Host, port and database cannot change for this ID. Use a new ID for a new target.</p>' +
    '<p class="muted">Direct uses plaintext TCP. This Connection ID retains its original transport.</p>' +
    (row.status === 'disabled' ? '<label class="check"><input type="checkbox" name="allow_disabled" value="1">Keep disabled if unreachable</label>' : '') +
    '<button type="submit">Test and save</button></form></details>') + '</li>').join('');
  const history = operations.map(op => '<li><strong>' + escape(op.logical_id) + '</strong> · ' +
    escape(op.action) + ' · ' + escape(op.phase) + ' · operation ' + escape(op.operation_id) +
    (op.pr_number ? ' · <a rel="noreferrer" href="https://github.com/lirtual/mcp-workers/pull/' + op.pr_number + '">PR ' + op.pr_number + '</a>' : '') +
    [op.prepare_run_id,op.apply_run_id,op.ci_run_id,op.release_run_id].filter(Boolean).map(run => ' · <a rel="noreferrer" href="https://github.com/lirtual/mcp-workers/actions/runs/' + run + '">Run ' + run + '</a>').join('') +
    (op.error_class ? ' · ' + escape(op.error_class) : '') +
    (op.error_class === 'postrelease_disabled' ? ' · Published reference stored disabled at revision 1. Use protected activation below; live health must pass before SQL is enabled.' : '') +
    (canApplyHyperdrive(op) ? '<form method="post" action="/setup/hyperdrive-apply">' + token(csrf) +
      '<input type="hidden" name="operation_id" value="' + escape(op.operation_id) + '">' +
      '<label>Type logical ID ' + escape(op.logical_id) + '<input name="confirm_id" required autocomplete="off"></label>' +
      '<label class="check"><input type="checkbox" name="confirm_apply" value="1" required>Confirm final apply: merge reviewed source and request protected production release</label>' +
      '<p>PR must be ready for review with required reviews and checks satisfied. Acceptance does not confirm release or activation.</p>' +
      '<button type="submit">Confirm final apply</button></form>' : '') + '</li>').join('');
  return htmlResponse('<h1>Database connections</h1><p class="muted">Manage up to 10 connections. Credentials are never displayed.</p>' +
    `<ul class="connections">${list || '<li>No database connections configured</li>'}</ul>` +
    addConnectionForm(csrf, replacing, replacementOrigin) +
    '<details><summary>Recent operations</summary><ul>' + (history || '<li>No operations</li>') + '</ul></details>' +
    (retiredHyperdriveIds.length ? '<details><summary>Cloudflare cleanup unverified (' + retiredHyperdriveIds.length + ')</summary>' +
      '<p class="muted">These retired connection IDs no longer admit MCP SQL. Historical Hyperdrive/CA resources are retained; physical cleanup needs separate live and rollback reference proof.</p><ul>' +
      retiredHyperdriveIds.map(id=>'<li>'+escape(id)+' · retired, resource cleanup unverified</li>').join('') +
      '</ul></details>' : '') +
    '<details class="maintenance"><summary>Maintenance</summary>' +
    '<p class="muted">Test GitHub Actions dispatch without deploying a Worker or changing any database connection. This only confirms GitHub accepted the request; check the workflow run separately.</p>' +
    '<form method="post" action="/setup/github-actions-check">' + token(csrf) +
    '<button type="submit">Check GitHub Actions connection</button></form>' +
    '<p class="muted">Re-encrypt saved connections when changing encryption keys; this does not change MySQL passwords.</p>' +
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

/** GitHub PR metadata is not a release, activation or D1 retirement receipt. */
export function setupUnbindStatusResult(status: {
  phase:'not_staged'|'draft_review'|'review_available'|'merged_unpublished'|'closed_unmerged';
  prNumber?:number
}): Response {
  const text = {
    not_staged:'No unbinding PR found for this connection. Check the staging Action run before trying again.',
    draft_review:'Unbinding Draft PR is open. Review the exact diff and GitHub checks.',
    review_available:'Unbinding PR is open for review. Merge and release are not verified.',
    merged_unpublished:'Unbinding PR is reported merged. Production release, active version and D1 retirement are NOT verified.',
    closed_unmerged:'Unbinding PR is closed without merge. No replacement is authorized automatically.'
  }[status.phase];
  const link = Number.isSafeInteger(status.prNumber) && status.prNumber! > 0
    ? '<p><a rel="noreferrer" href="https://github.com/lirtual/mcp-workers/pull/' + status.prNumber + '">Open PR #' + status.prNumber + '</a></p>' : '';
  return htmlResponse('<h1>Hyperdrive unbinding status</h1><p>'+escape(text)+'</p>'+link+
    '<p>Read-only GitHub status only. This does not approve merge, start a release, prove deployed Binding removal or retire D1.</p>'+
    '<a href="/setup">Back to connections</a>');
}
