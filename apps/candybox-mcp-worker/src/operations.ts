export interface Env {
  MCP_ACCESS_TOKEN: string;
  CANDYBOX_DDG_TOKEN?: string;
}

export type ErrorCode = 'invalid_input' | 'not_configured' | 'auth_failed' |
  'rate_limited' | 'approval_required' | 'unsupported_client' | 'size_exceeded' |
  'unsafe_file_source' | 'upstream_error' | 'indeterminate';

export class CandyError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.code = code; }
}

export type Sender = typeof fetch;
export type FileInput = { download_url: string; file_id: string; mime_type?: string; file_name?: string };
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ADDRESSES_URL = 'https://quack.duckduckgo.com/api/email/addresses';
const DASHBOARD_URL = 'https://quack.duckduckgo.com/api/email/dashboard';
const LITTERBOX_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const DUB_URL = 'https://dub.co/api/links';
const SHARE_URL = 'https://envshare.dev/api/v1/store';

function bad(code: ErrorCode): never { throw new CandyError(code); }
function fixedUrl(value: string): URL {
  let u: URL;
  try { u = new URL(value); } catch { return bad('invalid_input'); }
  if (!['https:', 'http:'].includes(u.protocol) || !u.hostname ||
      u.username || u.password || u.hash || /[\u0000-\u001f]/.test(value)) bad('invalid_input');
  return u;
}
function responseError(res: Response): never {
  if (res.status === 401 || res.status === 403) bad('auth_failed');
  if (res.status === 429) bad('rate_limited');
  bad(res.status >= 500 ? 'indeterminate' : 'upstream_error');
}
async function request(target: string, init: RequestInit, send: Sender): Promise<Response> {
  try {
    return await send(target, { ...init, redirect: 'manual',
      signal: AbortSignal.timeout(15000) });
  } catch { return bad('indeterminate'); }
}
async function boundedText(response: Response, max = 4096): Promise<string> {
  // Bound both reads and retained bytes. Untrusted provider HTML is never returned to the model.
  if (!response.body) bad('upstream_error');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) bad('upstream_error');
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof CandyError) throw e;
    bad('indeterminate');
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}
async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const result: unknown = JSON.parse(await boundedText(response));
    if (result && typeof result === 'object' && !Array.isArray(result))
      return result as Record<string, unknown>;
  } catch (e) { if (e instanceof CandyError) throw e; }
  return bad('upstream_error');
}
// A 2xx response may arrive after the provider created the resource even when
// its body is invalid. Never misclassify it as a safely retryable rejection.
async function createdJson(response: Response): Promise<Record<string, unknown>> {
  try { return await json(response); }
  catch { return bad('indeterminate'); }
}
function validLink(value: unknown, hosts: string[]): string {
  if (typeof value !== 'string' || value.length > 2048) bad('upstream_error');
  let u: URL;
  try { u = new URL(value); } catch { return bad('upstream_error'); }
  if (u.protocol !== 'https:' || !hosts.includes(u.hostname) ||
      u.username || u.password || u.hash || u.port) bad('upstream_error');
  return u.href;
}

export async function shortenUrl(
  input: { url: string; public_stats?: boolean }, send: Sender = fetch,
) {
  const target = fixedUrl(input.url);
  if (input.public_stats !== undefined && typeof input.public_stats !== 'boolean')
    bad('invalid_input');
  const res = await request(DUB_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'dub-anonymous-link-creation': '1' },
    body: JSON.stringify({ url: target.href, domain: 'dub.sh', publicStats: input.public_stats ?? false }),
  }, send);
  if (!res.ok) responseError(res);
  const data = await createdJson(res);
  const short_link = (() => {
    try {
      const link = validLink(data.shortLink, ['dub.sh']);
      if (new URL(link).pathname.length < 3) bad('upstream_error');
      return link;
    } catch { return bad('indeterminate'); }
  })();
  return { status: 'confirmed' as const, short_link, public_stats: input.public_stats ?? false };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + (Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('') || '00'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s || '1';
}
export function fromBase58(value: string): Uint8Array {
  if (!value || value.length > 256) bad('upstream_error');
  let number = 0n;
  for (const character of value) {
    const digit = B58.indexOf(character);
    if (digit < 0) bad('upstream_error');
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number % 256n));
    number /= 256n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}
export async function shareText(
  input: { text: string; ttl_seconds?: number; max_reads?: number }, send: Sender = fetch,
) {
  if (new TextEncoder().encode(input.text).length > MAX_TEXT_BYTES) bad('size_exceeded');
  const ttl_seconds = input.ttl_seconds ?? 86400;
  const max_reads = input.max_reads ?? 1;
  if (![3600, 43200, 86400, 259200, 604800].includes(ttl_seconds) ||
      !Number.isInteger(max_reads) || max_reads < 1 || max_reads > 10) bad('invalid_input');
  const key = crypto.getRandomValues(new Uint8Array(16));
  // chronark/envshare v2 uses a 16-byte IV, not the 12-byte variant of EnvShareApp.
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aes, new TextEncoder().encode(input.text)));
  // chronark/envshare API accepts only these four fields and never the key.
  const body = { encrypted: base58(encrypted), iv: base58(iv),
    ttl: ttl_seconds, reads: max_reads };
  const res = await request(SHARE_URL, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, send);
  if (!res.ok) responseError(res);
  const data = await createdJson(res);
  const id = data.id;
  if (typeof id !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{16,32}$/.test(id))
    bad('indeterminate');
  const rawId = fromBase58(id);
  if (rawId.byteLength !== 16) bad('indeterminate');
  // v2 link: Base58(version byte 0x02 + 16-byte random ID + 16-byte AES key).
  // Only the fragment contains the encryption key; store sees an encrypted blob.
  const composite = base58(new Uint8Array([2, ...rawId, ...key]));
  return { status: 'confirmed' as const,
    share_url: 'https://envshare.dev/unseal#' + composite,
    ttl_seconds, max_reads };
}

function trustedSource(raw: string, hosts: readonly string[]): URL {
  let u: URL;
  try { u = new URL(raw); } catch { return bad('unsafe_file_source'); }
  if (!hosts.includes(u.hostname) || u.protocol !== 'https:' || u.port ||
      u.username || u.password || u.hash || !/^[a-z0-9.-]+$/i.test(u.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) ||
      u.hostname === 'localhost') bad('unsafe_file_source');
  return u;
}
export async function uploadFile(
  input: { file: FileInput; expires_in?: '1h' | '12h' | '24h' | '72h' },
  send: Sender = fetch, trustedHosts: readonly string[] = [],
) {
  if (!input.file || typeof input.file.file_id !== 'string' || !input.file.file_id ||
      typeof input.file.download_url !== 'string') bad('invalid_input');
  const expires_in = input.expires_in ?? '24h';
  if (!['1h','12h','24h','72h'].includes(expires_in)) bad('invalid_input');
  // Trusted ChatGPT delivery origin has not been independently observed yet.
  // Production injects no hosts, preventing a model-controlled URL fetch.
  const source = trustedSource(input.file.download_url, trustedHosts);
  let download: Response;
  try { download = await send(source.href, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
  }); } catch { return bad('indeterminate'); }
  if (!download.ok || download.redirected) bad('unsafe_file_source');
  if (!download.body) bad('unsupported_client');
  const pieces: Uint8Array[] = [];
  const reader = download.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) bad('size_exceeded');
      pieces.push(value);
    }
  } catch (e) {
    if (e instanceof CandyError) throw e;
    bad('upstream_error');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const p of pieces) { bytes.set(p, pos); pos += p.length; }
  const filename = input.file.file_name?.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120) || 'attachment';
  const form = new FormData();
  form.set('reqtype', 'fileupload'); form.set('time', expires_in);
  form.set('fileToUpload', new File([bytes], filename, {
    type: input.file.mime_type || 'application/octet-stream',
  }));
  const res = await request(LITTERBOX_URL, { method: 'POST', body: form }, send);
  if (!res.ok) responseError(res);
  let link: string;
  try {
    link = validLink((await boundedText(res, 2048)).trim(),
      ['litter.catbox.moe', 'files.catbox.moe']);
  } catch { return bad('indeterminate'); }
  return { status: 'confirmed' as const, file_url: link,
    file_name: filename, size_bytes: total, expires_in };
}

export async function duckCapability(env: Env, send: Sender = fetch) {
  if (!env.CANDYBOX_DDG_TOKEN?.trim()) return 'not_configured' as const;
  let res: Response;
  try {
    res = await send(DASHBOARD_URL, { method: 'GET', redirect: 'manual',
      headers: { authorization: 'Bearer ' + env.CANDYBOX_DDG_TOKEN },
      signal: AbortSignal.timeout(8000) });
  } catch { return 'upstream_unavailable' as const; }
  if (res.status === 401 || res.status === 403) return 'auth_failed' as const;
  if (!res.ok) return 'upstream_unavailable' as const;
  try {
    const result = await json(res);
    if (Object.keys(result).length > 0) return 'ready' as const;
  } catch { /* Success without a valid API shape is not confirmed readiness. */ }
  return 'configured_unverified' as const;
}
export async function createDuckAddress(env: Env, send: Sender = fetch) {
  if (!env.CANDYBOX_DDG_TOKEN?.trim()) bad('not_configured');
  const res = await request(ADDRESSES_URL, {
    method: 'POST', headers: { authorization: 'Bearer ' + env.CANDYBOX_DDG_TOKEN,
      'content-type': 'application/json' }, body: '{}',
  }, send);
  if (!res.ok) responseError(res);
  const data = await createdJson(res);
  const address = data.address;
  if (typeof address !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}@duck\.com$/i.test(address))
    bad('indeterminate');
  return { status: 'confirmed' as const, address };
}
