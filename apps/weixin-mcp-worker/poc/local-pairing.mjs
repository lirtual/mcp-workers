// Owner-supervised, temporary localhost-only Spec #346 iLink compatibility experiment.
// Deliberately not an MCP server, Cloudflare Worker, or production management UI.
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createIlinkClient, bindVerifiedContext, createOwnershipProof } from './protocol.mjs';

const HOST = '127.0.0.1';
const PORT = 45346;
const ORIGIN = `http://localhost:${PORT}`;
const EXPIRES_MS = 12 * 60_000;
const api = createIlinkClient();
const csrf = randomBytes(24).toString('hex');
const expires = Date.now() + EXPIRES_MS;
const QR_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'qr-svg.py');
const state = {
  stage: 'unbound', qr: null, svg: null, botToken: null, botId: null, ownerId: null,
  proof: null, cursor: '', contextToken: null, sent: false, sendResult: null,
  lastError: null, busy: false,
};
function clear() {
  state.qr = null; state.svg = null; state.botToken = null; state.botId = null;
  state.ownerId = null; state.proof = null; state.cursor = ''; state.contextToken = null;
}
function expired() { return Date.now() >= expires; }
function safe(err) {
  const allowed = new Set([
    'INVALID_INPUT','INVALID_RESPONSE','UPSTREAM_REJECTED','UPSTREAM_UNAVAILABLE',
    'UPSTREAM_HTTP_FAILURE','UNSAFE_REDIRECT','STALE_SESSION','IDENTITY_UNVERIFIED',
    'UNKNOWN_SEND',
  ]);
  return allowed.has(err?.code) ? err.code : 'POC_OPERATION_FAILED';
}
function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}
function form(action, text) {
  return `<form method="post" action="/${action}"><input type="hidden" name="csrf" value="${csrf}"><button>${text}</button></form>`;
}
function page() {
  const stage = expired() ? 'expired' : state.stage;
  let body = '';
  if (stage === 'unbound') body = form('start', 'Create temporary QR');
  if (stage === 'qr_pending') {
    body = `<p>Scan with your own Weixin account. Never forward this QR.</p><div class="qr">${state.svg ?? ''}</div>` +
      form('scan', 'Check scan confirmation');
  }
  if (stage === 'bound_unverified') {
    body = `<p>Send this unique proof as a standalone text message to the ClawBot conversation in Weixin. Do not send it here:</p>
    <pre>${htmlEscape(state.proof)}</pre>` + form('verify', 'Verify incoming owner message');
  }
  if (stage === 'ready') {
    body = '<p>Owner proof verified. This does not prove long-term session reliability.</p>' +
      form('send', 'Send ONE explicit PoC test message to my bound ClawBot');
  }
  if (stage === 'sent') body = '<p>One test send has already been attempted. The system will not repeat it.</p>';
  if (stage === 'expired') body = '<p>This local pairing session has expired. Restart the local experiment if needed.</p>';
  const status = state.sendResult ? `<p>Send status: <strong>${htmlEscape(state.sendResult)}</strong>. Check handset separately.</p>` : '';
  const error = state.lastError ? `<p class="err">Last action: ${htmlEscape(state.lastError)}</p>` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Weixin Spec #346 · Local PoC</title><style>
    body{font:16px system-ui,sans-serif;max-width:580px;padding:20px;margin:6vh auto;line-height:1.6}
    h1{font-size:1.4rem}button{padding:12px 18px;cursor:pointer;margin:14px 0}
    .qr svg{max-width:100%;height:auto;display:block;margin:12px 0}
    pre{padding:12px;overflow-wrap:anywhere;white-space:pre-wrap;background:#eee}
    .err{color:#a11}small{color:#666}
    </style><h1>Weixin · Spec #346 local PoC</h1>
    <small>Loopback only · ephemeral · no credential logging · state: ${htmlEscape(stage)}</small>
    ${body}${status}${error}<p><small>Close this tab when done. Local server auto-expires after 12 minutes.
    This is not ChatGPT MCP/Portal or a production login page.</small></p></html>`;
}
function reply(res, status = 200, body = page()) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0',
    'referrer-policy': 'no-referrer', 'x-content-type-options':'nosniff',
    'x-frame-options':'DENY',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  }); res.end(body);
}
function readForm(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk.toString('utf8');
      if (body.length > 2048) { reject(new Error('REQUEST_TOO_LARGE')); request.destroy(); }
    });
    request.on('end', () => resolve(new URLSearchParams(body)));
    request.on('error', reject);
  });
}
function checkCsrf(presented) {
  const a = Buffer.from(presented ?? '');
  const b = Buffer.from(csrf);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function perform(action) {
  if (expired()) { clear(); state.stage = 'expired'; return; }
  state.lastError = null;
  try {
    if (action === 'start' && state.stage === 'unbound') {
      const qr = await api.getQr();
      const svg = execFileSync('python3', [QR_SCRIPT], {
        input: qr.qrcode_img_content, encoding: 'utf8', maxBuffer: 512 * 1024,
      });
      state.qr = qr.qrcode; state.svg = svg;
      state.stage = 'qr_pending';
    } else if (action === 'scan' && state.stage === 'qr_pending') {
      const status = await api.pollQr(state.qr);
      if (status.status === 'confirmed') {
        state.botToken = status.bot_token;
        state.botId = status.ilink_bot_id;
        state.ownerId = status.ilink_user_id;
        state.proof = createOwnershipProof();
        state.qr = null; state.svg = null;
        state.stage = 'bound_unverified';
      } else if (status.status === 'expired' || status.status === 'verify_code_blocked' ||
                 status.status === 'binded_redirect' || status.status === 'need_verifycode') {
        state.lastError = 'QR_' + status.status.toUpperCase();
        clear(); state.stage = 'expired';
      } else if (status.status !== 'wait' && status.status !== 'scaned') {
        state.lastError = 'QR_UNSUPPORTED_STATE';
      }
    } else if (action === 'verify' && state.stage === 'bound_unverified') {
      const updates = await api.getUpdates(state.botToken, state.cursor);
      state.cursor = updates.get_updates_buf;
      try {
        const verified = bindVerifiedContext(
          { status:'confirmed', ilink_user_id: state.ownerId }, updates, state.botId, state.proof);
        state.contextToken = verified.contextToken;
        state.proof = null;
        state.stage = 'ready';
      } catch {
        state.lastError = 'WAITING_FOR_OWNER_PROOF';
      }
    } else if (action === 'send' && state.stage === 'ready' && !state.sent) {
      // Claim the single attempt synchronously before crossing the upstream boundary.
      state.sent = true; state.stage = 'sent';
      try {
        const result = await api.sendText({
          botToken: state.botToken, recipientId: state.ownerId, contextToken: state.contextToken,
          requestId: randomUUID(), text: 'Weixin MCP Spec #346 · controlled one-time test message',
        });
        state.sendResult = result.status;
      } catch (err) {
        state.sendResult = err.code === 'UPSTREAM_REJECTED' ? 'rejected' : 'unknown';
        state.lastError = safe(err);
      }
      clear();
    }
  } catch (err) {
    state.lastError = safe(err);
    if (action === 'start') { clear(); state.stage = 'unbound'; }
    if (action === 'verify' && err?.code === 'STALE_SESSION') { clear(); state.stage = 'expired'; }
  }
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const allowedHost = [`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host);
  if (!allowedHost || url.pathname !== req.url?.split('?')[0] || url.search) {
    reply(res, 404, 'not found'); return;
  }
  if (req.method === 'GET' && url.pathname === '/') { reply(res); return; }
  if (req.method !== 'POST' || !['start','scan','verify','send'].includes(url.pathname.slice(1))) {
    reply(res, 404, 'not found'); return;
  }
  if (!['application/x-www-form-urlencoded'].includes((req.headers['content-type'] ?? '').split(';')[0]) ||
      (req.headers.origin && req.headers.origin !== ORIGIN && req.headers.origin !== `http://127.0.0.1:${PORT}`)) {
    reply(res, 403, 'forbidden'); return;
  }
  const data = await readForm(req).catch(() => null);
  if (!data || !checkCsrf(data.get('csrf'))) { reply(res, 403, 'forbidden'); return; }
  // Only one QR or poll operation can proceed, even if bodies arrive together.
  if (state.busy) { reply(res, 409); return; }
  state.busy = true;
  try { await perform(url.pathname.slice(1)); }
  finally { state.busy = false; }
  reply(res);
});
const timer = setTimeout(() => { clear(); server.close(); }, EXPIRES_MS);
timer.unref();
server.listen(PORT, HOST, () => {
  // Never log QR, bot credentials, owner IDs or the challenge.
  console.log(`SPEC346_LOCAL_POC_READY http://localhost:${PORT} (expires in 12 minutes)`);
});
