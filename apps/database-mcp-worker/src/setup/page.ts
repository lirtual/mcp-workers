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
  '<code>mysql://USER:PASSWORD@HOST:3306/DATABASE</code>. ' +
  'Use a public IP or hostname; no URL query parameters. Direct is unencrypted.</p></details>';
function hyperdriveForm(csrf: string, route: 'hyperdrive-preview' | 'hyperdrive-prepare'): string {
  const confirm = route === 'hyperdrive-prepare';
  return '<form method="post" action="/setup/' + route + '">' + token(csrf) +
    '<label>Logical ID<input name="id" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" required></label>' +
    '<label>CA renewal: existing logical ID (optional)<input name="ca_replaces" maxlength="64" autocomplete="off"></label>' +
    '<p class="muted">For CA renewal, use a new logical ID and a different CA with the same origin. The existing connection and CA remain intact. After separately reviewed release, migrate consumers and retire the old Binding only when safe.</p>' +
    '<label>Dialect<select name="dialect"><option value="mysql">MySQL</option><option value="postgres">PostgreSQL</option></select></label>' +
    '<label>Origin hostname<input name="origin_host" maxlength="253" autocomplete="off" required></label>' +
    '<label>Port<input name="origin_port" type="number" min="1" max="65535" required></label>' +
    '<label>Database<input name="origin_database" maxlength="128" required></label>' +
    '<label>Username<input name="origin_user" maxlength="128" required></label>' +
    '<label>Password<input name="origin_password" type="password" maxlength="2048" autocomplete="off" required></label>' +
    '<p class="muted">' + (confirm ? 'Use an existing CA ID or upload a CA PEM. Upload requires Account: SSL and Certificates Write and remains unbound until reviewed release.' : 'Provide one existing CA ID or CA PEM. Preview does not upload or expose the certificate.') + '</p>' +
    '<label>Existing CA certificate ID<input name="ca_certificate_id" maxlength="128"></label>' +
    '<label>CA PEM<textarea name="ca_pem" rows="3" maxlength="16384"></textarea></label>' +
    (confirm ? '<label class="check"><input type="checkbox" name="confirm_prepare" value="1" required>' +
      'I authorize an unbound Cloudflare resource preparation. This does not enable the connection.</label>' : '') +
    '<button type="submit">' + (confirm ? 'Confirm Prepare' : 'Preview (read-only)') + '</button></form>';
}
export function setupPage(rows: RegistryMetadata[], csrf: string,
  operations: HyperdriveOperationSummary[] = []): Response {
  const list = rows.map(row => `<li><strong>${escape(row.id)}</strong> <span class="meta">${escape(row.dialect)} / ${escape(row.transport)} · ${escape(row.status)}</span>` +
    (row.status === 'active' ? action(row, csrf, 'disable') :
      row.transport === 'direct' && isAvailableMode(row.transport, row.dialect)
        ? action(row, csrf, 'enable') + action(row, csrf, 'delete') :
      row.transport === 'hyperdrive' ? '' : action(row, csrf, 'delete')) +
    (row.transport === 'hyperdrive'
      ? '<p class="muted">Hyperdrive actions run in protected GitHub Actions after exact binding, CA and cache verification. A successful request does not confirm completion.</p>' +
        (row.status === 'disabled'
          ? '<details><summary>Manage Hyperdrive via GitHub Actions</summary>' +
            '<p class="muted">Enable requires a published, reviewed binding. Retirement first stages a Draft unbinding PR if still bound; final D1 retirement requires a separately approved exact release and no remaining rollback dependency.</p>' +
            '<form method="post" action="/setup/hyperdrive-action">' + token(csrf) + ids(row) +
            '<input type="hidden" name="hyperdrive_action" value="enable">' +
            '<button type="submit">Request enable</button></form>' +
            '<form method="post" action="/setup/hyperdrive-action">' + token(csrf) + ids(row) +
            '<input type="hidden" name="hyperdrive_action" value="retire">' +
            '<label>Type connection ID to confirm retirement<input name="confirm_id" required></label>' +
            '<button type="submit">Stage unbinding or verify retirement</button></form>' +
            '<form method="post" action="/setup/hyperdrive-rotation-check">' + token(csrf) + ids(row) +
            '<label>Rotation readiness<select name="rotation_mode"><option value="credentials">Password</option><option value="ca">CA certificate</option></select></label>' +
            '<p class="muted">Only checks whether an in-place rotation might be isolated. No password or CA material is submitted. Existing rollback versions may block this check.</p>' +
            '<button type="submit">Check rotation isolation (read-only)</button></form>' +
            '<form method="post" action="/setup/hyperdrive-credentials">' + token(csrf) + ids(row) +
            '<p class="muted">This update is only for an isolated, disabled, unbound Hyperdrive with no current or rollback references. The protected Runner rejects unsafe changes.</p>' +
            '<label>New password<input name="new_password" type="password" maxlength="2048" autocomplete="off" required></label>' +
            '<label>Type connection ID to confirm password update<input name="confirm_id" required></label>' +
            '<label class="check"><input type="checkbox" name="confirm_credentials" value="1" required>I authorize a password update. Connection stays disabled and requires independent verification.</label>' +
            '<button type="submit">Confirm isolated password update</button></form>' +
            '<form method="post" action="/setup/hyperdrive-unbind-status">' + token(csrf) + ids(row) +
            '<button type="submit">Check unbinding PR (read-only)</button></form></details>'
          : '') +
        '<p class="muted">Password and CA changes are blocked until in-flight, shared and rollback isolation can be verified. Disable alone does not prove isolation. Existing config and CA remain intact.</p>' +
        '<p class="muted"><a href="https://github.com/lirtual/mcp-workers/actions/workflows/release.yml" rel="noreferrer">View GitHub Actions results</a></p>'
      : !isAvailableMode(row.transport, row.dialect) ? '<p class="muted">This connection mode is not yet enabled.</p>' :
    `<details><summary>Edit connection</summary><form action="/setup/edit" method="post">${token(csrf)}${ids(row)}` +
    '<label>Credentials<select name="credential_mode"><option value="keep">Keep URL</option><option value="replace">Replace URL</option></select></label>' +
    '<label>New URL (only when replacing)<input type="password" name="url" autocomplete="off" maxlength="8192"></label>' +
    '<p class="muted">Host, port and database cannot change for this ID. Use a new ID for a new target.</p>' +
    plaintextAck +
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
    '<fieldset><legend>Add Direct connection</legend><form method="post" action="/setup/add">' + token(csrf) +
    '<label>Connection ID<input name="id" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" required></label>' +
    '<input type="hidden" name="transport" value="direct">' +
    '<input type="hidden" name="dialect" value="mysql"><p class="muted">Direct supports MySQL only.</p>' +
    '<label>Database URL<input type="password" name="url" maxlength="8192" autocomplete="off" required></label>' +
    directUrlHint + plaintextAckRequired +
    '<details><summary>Advanced options</summary><label class="check"><input type="checkbox" name="allow_disabled" value="1">Save disabled if connection test fails</label>' +
    '<p class="muted">A disabled connection cannot be used until it passes a connection check.</p></details>' +
    '<button type="submit">Add Direct connection</button></form></fieldset>' +
    '<fieldset><legend>Hyperdrive lifecycle</legend>' +
    '<p class="muted">Step 1: Preview without changes. Step 2: separately re-enter credentials and confirm Prepare. No logical connection is enabled until a reviewed binding is published and verified.</p>' +
    '<details><summary>Preview new Hyperdrive</summary>' + hyperdriveForm(csrf, 'hyperdrive-preview') + '</details>' +
    '<p class="muted">After preparation, review the exact nonsecret PR and required checks. Return to Operation status for a separate final Apply confirmation. Only the verified release and disabled D1 handoff count as completion.</p>' +
    '<details><summary>Prepare unbound Hyperdrive</summary>' + hyperdriveForm(csrf, 'hyperdrive-prepare') + '</details>' +
    '<details><summary>Operation status</summary><ul>' + (history || '<li>No operations</li>') + '</ul></details></fieldset>' +
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
