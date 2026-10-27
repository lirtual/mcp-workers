// Spec #346 — isolated, non-production protocol feasibility seam.
// Based on Tencent/openclaw-weixin/docs/protocol.md; its examples are NOT a server contract.
const API_ORIGIN = 'https://ilinkai.weixin.qq.com';
const MAX_JSON_BYTES = 65536;
const MAX_TEXT_BYTES = 4096;
const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IlinkError extends Error {
  constructor(code, diagnostic = null) {
    super(code);
    this.name = 'IlinkError';
    this.code = code;
    // Only bounded integer business status codes; never errmsg or raw JSON.
    this.diagnostic = diagnostic;
  }
}
function safeString(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1F\x7F]/.test(value);
}
function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('iLink API origin not allowed'); }
  if (url.origin !== API_ORIGIN || url.href !== API_ORIGIN + '/' || url.username || url.password) {
    throw new Error('iLink API origin not allowed');
  }
  return url.origin;
}
async function parseBounded(response) {
  if (response.status >= 300 && response.status < 400) throw new IlinkError('UNSAFE_REDIRECT');
  if (!response.ok) throw new IlinkError('UPSTREAM_HTTP_FAILURE');
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_JSON_BYTES) throw new IlinkError('INVALID_RESPONSE');
  const stream = response.body;
  if (!stream) throw new IlinkError('INVALID_RESPONSE');
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) throw new IlinkError('INVALID_RESPONSE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('nonobject');
    return parsed;
  } catch { throw new IlinkError('INVALID_RESPONSE'); }
}
function validateRet(payload, isSync = false) {
  if (isSync && (payload.ret === -14 || payload.errcode === -14)) {
    throw new IlinkError('STALE_SESSION');
  }
  const hasRetFailure = isSync
    ? payload.ret !== undefined && payload.ret !== 0
    : payload.ret !== 0;
  if (hasRetFailure || (payload.errcode !== undefined && payload.errcode !== 0)) {
    // Do not include upstream-provided errmsg, tokens, message objects or cursor.
    // Numeric statuses are enough to distinguish session and protocol errors.
    const bounded = value => Number.isSafeInteger(value) && Math.abs(value) <= 999999999
      ? value : null;
    throw new IlinkError('UPSTREAM_REJECTED', {
      ret: bounded(payload.ret), errcode: bounded(payload.errcode),
      ret_kind: payload.ret === undefined ? 'missing' : payload.ret === null ? 'null' : typeof payload.ret,
      errcode_kind: payload.errcode === undefined ? 'missing' : payload.errcode === null ? 'null' : typeof payload.errcode,
    });
  }
}
function randomUin() {
  const value = new DataView(crypto.getRandomValues(new Uint8Array(4)).buffer).getUint32(0);
  return btoa(String(value));
}
const baseInfo = Object.freeze({ channel_version: '2.4.8', bot_agent: 'WeixinMCP/0.1.0' });

export function createIlinkClient({ fetchImpl = fetch, apiOrigin = API_ORIGIN } = {}) {
  const origin = validateOrigin(apiOrigin);
  async function request(method, path, { token, body, query, send = false } = {}) {
    const url = new URL(path, origin);
    if (query) for (const [key, val] of Object.entries(query)) url.searchParams.set(key, val);
    if (url.origin !== origin) throw new IlinkError('UNSAFE_REDIRECT');
    const headers = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(0x00020408),
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = randomUin();
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try {
      response = await fetchImpl(url.href, {
        method, headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(send ? 12000 : 40000),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch {
      throw new IlinkError(send ? 'UNKNOWN_SEND' : 'UPSTREAM_UNAVAILABLE');
    }
    try {
      return await parseBounded(response);
    } catch (err) {
      // Even a redirect can follow an already-processed write: no retry.
      if (send) throw new IlinkError('UNKNOWN_SEND');
      if (err instanceof IlinkError) throw err;
      throw new IlinkError('UPSTREAM_UNAVAILABLE');
    }
  }
  return {
    async getQr() {
      const response = await request('POST', '/ilink/bot/get_bot_qrcode', {
        query: { bot_type: '3' }, body: { local_token_list: [] }
      });
      if (!safeString(response.qrcode, 4096) || !safeString(response.qrcode_img_content, 16000)) {
        throw new IlinkError('INVALID_RESPONSE');
      }
      // Observed upstream QR host (2026-10-27); do not render arbitrary
      // server-controlled QR destinations, especially a lookalike domain.
      let qrUrl;
      try { qrUrl = new URL(response.qrcode_img_content); }
      catch { throw new IlinkError('UNSAFE_REDIRECT'); }
      if (qrUrl.origin !== 'https://liteapp.weixin.qq.com' ||
          qrUrl.username || qrUrl.password) {
        throw new IlinkError('UNSAFE_REDIRECT');
      }
      return { qrcode: response.qrcode, qrcode_img_content: response.qrcode_img_content };
    },
    async pollQr(qrcode, verifyCode) {
      if (!safeString(qrcode, 4096) || (verifyCode !== undefined && !/^[0-9]{4,8}$/.test(verifyCode))) {
        throw new IlinkError('INVALID_INPUT');
      }
      const response = await request('GET', '/ilink/bot/get_qrcode_status', {
        query: { qrcode, ...(verifyCode === undefined ? {} : { verify_code: verifyCode }) }
      });
      if (!['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect'].includes(response.status)) {
        throw new IlinkError('INVALID_RESPONSE');
      }
      // Host switching has NOT been validated; never honor returned redirects implicitly.
      if (response.redirect_host || response.status === 'scaned_but_redirect') {
        throw new IlinkError('UNSAFE_REDIRECT');
      }
      if (response.status === 'confirmed' && (
        !safeString(response.bot_token) || !safeString(response.ilink_bot_id) ||
        !safeString(response.ilink_user_id) ||
        (response.baseurl && response.baseurl !== API_ORIGIN)
      )) throw new IlinkError('INVALID_RESPONSE');
      return response;
    },
    async getUpdates(botToken, cursor) {
      if (!safeString(botToken) || typeof cursor !== 'string' || cursor.length > 4096) {
        throw new IlinkError('INVALID_INPUT');
      }
      const response = await request('POST', '/ilink/bot/getupdates', {
        token: botToken, body: { get_updates_buf: cursor, base_info: baseInfo }
      });
      validateRet(response, true);
      // Missing ret/errcode is not itself a business rejection. Fail closed
      // unless the reply still satisfies the entire normal getUpdates shape.
      const suspiciousErrorText = response.ret === undefined &&
        response.errcode === undefined && typeof response.errmsg === 'string' &&
        response.errmsg.length > 0;
      const validMsgs = Array.isArray(response.msgs) && response.msgs.length <= 100;
      const validCursor = typeof response.get_updates_buf === 'string' &&
        response.get_updates_buf.length <= 4096;
      if (!validMsgs || !validCursor || suspiciousErrorText) {
        throw new IlinkError('INVALID_RESPONSE', {
          has_msgs_array: Array.isArray(response.msgs),
          has_cursor_string: typeof response.get_updates_buf === 'string',
          has_error_text: suspiciousErrorText,
        });
      }
      return response; // in-memory only; caller must discard message contents.
    },
    async sendText({ botToken, recipientId, contextToken, requestId, text }) {
      if (![botToken, recipientId, contextToken].every(s => safeString(s)) ||
          typeof text !== 'string' || !text.trim() || encoder.encode(text).byteLength > MAX_TEXT_BYTES ||
          /[\x00-\x08\x0B-\x1F\x7F]/.test(text) || !UUID.test(requestId ?? '')) {
        throw new IlinkError('INVALID_INPUT');
      }
      const response = await request('POST', '/ilink/bot/sendmessage', {
        token: botToken, send: true,
        body: {
          msg: { from_user_id: '', to_user_id: recipientId, client_id: requestId,
            message_type: 2, message_state: 2, context_token: contextToken,
            item_list: [{ type: 1, text_item: { text } }]
          },
          base_info: baseInfo
        }
      });
      validateRet(response);
      return { status: 'accepted' }; // never say delivered; no retry attempted here.
    }
  };
}
// Generate this only for an actively supervised QR session. The owner must
// independently type it into the scanned ClawBot chat; do not log the proof.
export function createOwnershipProof() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return 'WX346-' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function bindVerifiedContext(scan, updates, botId, expectedProof) {
  if (scan?.status !== 'confirmed' || !safeString(scan.ilink_user_id) || !safeString(botId) ||
      !/^WX346-[0-9A-F]{24}$/.test(expectedProof ?? '') || !Array.isArray(updates?.msgs)) {
    throw new IlinkError('IDENTITY_UNVERIFIED');
  }
  const eligible = updates.msgs.filter(message =>
    message && message.from_user_id === scan.ilink_user_id &&
    message.to_user_id === botId && message.message_type === 1 &&
    !message.group_id && safeString(message.context_token) &&
    Array.isArray(message.item_list) && message.item_list.length === 1 &&
    message.item_list[0]?.type === 1 &&
    message.item_list[0]?.text_item?.text === expectedProof
  );
  if (eligible.length !== 1) throw new IlinkError('IDENTITY_UNVERIFIED');
  return { recipientId: scan.ilink_user_id, contextToken: eligible[0].context_token };
}
