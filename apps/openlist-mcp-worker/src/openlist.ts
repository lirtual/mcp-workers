export interface Env {
  MCP_ACCESS_TOKEN?: string;
  OPENLIST_API_TOKEN?: string;
  OPENLIST_ALLOWED_ROOTS?: string;
  OPENLIST?: { fetch(request: Request): Promise<Response> };
}
export type OperationStatus = 'succeeded' | 'failed' | 'unknown' | 'not_executed';
export interface OperationResult {
  operation: string;
  status: OperationStatus;
  code: string;
  message: string;
  request_id: string;
  target: string;
  observed_state?: unknown;
  evidence?: unknown;
}
export class OpenListError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export interface Config {
  roots: string[];
  token: string;
  binding: NonNullable<Env['OPENLIST']>;
}
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_SEGMENT = 255;

export function canonicalPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 1024 ||
      !value.startsWith('/') || value.endsWith('/') ||
      /[\\%?#\u0000-\u001f\u007f]/.test(value) ||
      value.includes('//') || value.normalize('NFC') !== value)
    throw new OpenListError('INVALID_PATH');
  const parts = value.slice(1).split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.length > MAX_SEGMENT ||
      p === '@s' || p === '@d'))
    throw new OpenListError('INVALID_PATH');
  return value;
}
export function canonicalName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SEGMENT ||
      /[\\/%?#\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..' ||
      value.normalize('NFC') !== value || value === '@s' || value === '@d')
    throw new OpenListError('INVALID_PATH');
  return value;
}
export function inScope(path: string, roots: string[]): boolean {
  return roots.some(root => path === root || path.startsWith(root + '/'));
}
export function createConfig(env: Env): Config {
  if (!env.OPENLIST || typeof env.OPENLIST.fetch !== 'function' ||
      typeof env.OPENLIST_API_TOKEN !== 'string' || !env.OPENLIST_API_TOKEN.trim() ||
      !env.MCP_ACCESS_TOKEN?.trim() ||
      env.OPENLIST_API_TOKEN === env.MCP_ACCESS_TOKEN)
    throw new OpenListError('CONFIGURATION_ERROR');
  let value: unknown;
  try { value = JSON.parse(env.OPENLIST_ALLOWED_ROOTS ?? ''); }
  catch { throw new OpenListError('CONFIGURATION_ERROR'); }
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 ||
      value.some(v => typeof v !== 'string'))
    throw new OpenListError('CONFIGURATION_ERROR');
  let roots: string[];
  try { roots = value.map(canonicalPath); }
  catch { throw new OpenListError('CONFIGURATION_ERROR'); }
  if (new Set(roots).size !== roots.length)
    throw new OpenListError('CONFIGURATION_ERROR');
  return { binding: env.OPENLIST, token: env.OPENLIST_API_TOKEN, roots };
}
function safeErrorCode(code: number): string {
  if (code === 401 || code === 403) return 'UNAUTHORIZED';
  if (code === 404) return 'NOT_FOUND';
  if (code === 501) return 'NOT_SUPPORTED';
  if (code === 409) return 'CONFLICT';
  if (code === 400) return 'UPSTREAM_REJECTED';
  return 'UPSTREAM_UNAVAILABLE';
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function safeMetadata(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new OpenListError('UPSTREAM_UNAVAILABLE');
  const obj: Record<string, unknown> = {};
  if (typeof value.name === 'string') obj.name = canonicalName(value.name);
  if (typeof value.path === 'string') obj.path = canonicalPath(value.path);
  if (typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0)
    obj.size = value.size;
  if (typeof value.is_dir === 'boolean') obj.is_dir = value.is_dir;
  if (typeof value.modified === 'string' && value.modified.length <= 64) obj.modified = value.modified;
  return obj;
}
function targetMetadata(value: unknown, target: string): Record<string, unknown> {
  const meta = safeMetadata(value);
  const expectedName = target.slice(target.lastIndexOf('/') + 1);
  if (meta.name !== expectedName ||
      (meta.path !== undefined && meta.path !== target))
    throw new OpenListError('UPSTREAM_UNAVAILABLE');
  return { ...meta, path: target };
}

function collectEntries(data: unknown): { content: unknown[]; total: number } {
  if (!isObject(data) || !Array.isArray(data.content) || data.content.length > 100 ||
      typeof data.total !== 'number' || !Number.isSafeInteger(data.total) || data.total < 0)
    throw new OpenListError('UPSTREAM_UNAVAILABLE');
  return { content: data.content, total: data.total };
}
async function limitedBody(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > cap) throw new OpenListError('LIMIT_EXCEEDED');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > cap) throw new OpenListError('LIMIT_EXCEEDED');
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.byteLength; }
  return out;
}
type UpstreamReply = { code: number; data: unknown };
export class OpenListApi {
  private readonly config: Config;
  constructor(config: Config) { this.config = config; }
  get roots(): readonly string[] { return this.config.roots; }
  check(path: unknown, write = false): string {
    const canonical = canonicalPath(path);
    if (!inScope(canonical, this.config.roots)) throw new OpenListError('OUT_OF_SCOPE');
    if (write && this.config.roots.includes(canonical)) throw new OpenListError('INVALID_PATH');
    return canonical;
  }
  private async request(method: 'POST' | 'GET' | 'PUT', route: string, data?: unknown,
      headers?: Record<string, string>, write = false): Promise<UpstreamReply> {
    const request = new Request('https://openlist.internal' + route, {
      method,
      headers: {
        authorization: this.config.token,
        ...(data !== undefined && method !== 'PUT' ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: data === undefined ? undefined :
        method === 'PUT' ? data as Uint8Array<ArrayBuffer> : JSON.stringify(data),
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    let response: Response;
    try { response = await this.config.binding.fetch(request); }
    catch { throw new OpenListError(write ? 'UPSTREAM_UNCERTAIN' : 'UPSTREAM_UNAVAILABLE'); }
    let reply: unknown;
    try { reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      await limitedBody(response, MAX_RESULT_BYTES))); }
    catch { throw new OpenListError(write ? 'UPSTREAM_UNCERTAIN' : 'UPSTREAM_UNAVAILABLE'); }
    if (!isObject(reply) || typeof reply.code !== 'number' ||
        !Number.isSafeInteger(reply.code) || !('data' in reply))
      throw new OpenListError(write ? 'UPSTREAM_UNCERTAIN' : 'UPSTREAM_UNAVAILABLE');
    if (response.status !== 200 || reply.code !== 200) {
      // A write can partly execute before a 5xx/timeout even when JSON reports failure.
      if (write && (response.status >= 500 || reply.code >= 500))
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      throw new OpenListError(safeErrorCode(reply.code !== 200 ? reply.code : response.status));
    }
    return { code: reply.code, data: reply.data };
  }
  async list(path: string, page: number, perPage: number) {
    const dir = this.check(path);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
        !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100)
      throw new OpenListError('LIMIT_EXCEEDED');
    const { content, total } = collectEntries((await this.request('POST', '/api/fs/list',
      { path: dir, page, per_page: perPage, refresh: false })).data);
    const entries = content.map(safeMetadata).filter(item =>
      typeof item.name === 'string' &&
      (item.path === undefined || item.path === dir + '/' + item.name));
    return { entries, total, page };
  }
  async get(path: string): Promise<Record<string, unknown>> {
    const file = this.check(path);
    return targetMetadata((await this.request('POST', '/api/fs/get', { path: file })).data, file);
  }
  async search(parent: string, keywords: string, page: number, perPage: number) {
    const dir = this.check(parent);
    if (typeof keywords !== 'string' || keywords.trim().length < 1 || keywords.length > 120)
      throw new OpenListError('INVALID_INPUT');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
        !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100)
      throw new OpenListError('LIMIT_EXCEEDED');
    const { content, total } = collectEntries((await this.request('POST', '/api/fs/search',
      { parent: dir, keywords, scope: 0, page, per_page: perPage })).data);
    // Upstream SearchResultItem contains `parent` + `name`, not `path`.
    // Derive the canonical child path ourselves; never trust caller-supplied paths.
    const entries: Record<string, unknown>[] = [];
    for (const item of content) {
      try {
        if (!isObject(item)) continue;
        const actualParent = canonicalPath(item.parent);
        const name = canonicalName(item.name);
        const child = canonicalPath(actualParent + '/' + name);
        if (!child.startsWith(dir + '/') || !inScope(child, this.config.roots))
          continue;
        // If a provider also supplies path, refuse a conflicting identity.
        if (item.path !== undefined && item.path !== child) continue;
        entries.push(safeMetadata({ ...item, path: child }));
      } catch { /* untrusted or out-of-scope upstream result */ }
    }
    // Upstream total counts unfiltered matches; entries may be fewer after scope validation.
    return { entries, total, page, per_page: perPage, has_more: page * perPage < total };
  }
  // Gated candidate only: do NOT register as an MCP tool until real
  // OpenList driver and Portal acceptance. Never query the global share list.
  async getShare(id: string): Promise<Record<string, unknown>> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new OpenListError('INVALID_INPUT');
    const share = (await this.request('GET', '/api/share/get?id=' + encodeURIComponent(id))).data;
    if (!isObject(share) || share.id !== id || !Array.isArray(share.files) ||
        share.files.length < 1 || share.files.length > 32 ||
        typeof share.disabled !== 'boolean')
      throw new OpenListError('UPSTREAM_UNAVAILABLE');
    const files: string[] = [];
    for (const value of share.files) {
      let file: string;
      try { file = canonicalPath(value); }
      catch { throw new OpenListError('UPSTREAM_UNAVAILABLE'); }
      if (!inScope(file, this.config.roots))
        throw new OpenListError('OUT_OF_SCOPE');
      files.push(file);
    }
    if (new Set(files).size !== files.length)
      throw new OpenListError('UPSTREAM_UNAVAILABLE');

    // An explicit allowlist keeps upstream creator, password, remark, raw links
    // and other administrator-only metadata out of all user-facing results.
    const result: Record<string, unknown> = { id, files, disabled: share.disabled };
    if (share.expires !== undefined) {
      if (share.expires !== null &&
          !(typeof share.expires === 'string' && share.expires.length <= 64) &&
          !(typeof share.expires === 'number' && Number.isSafeInteger(share.expires) &&
            share.expires >= 0))
        throw new OpenListError('UPSTREAM_UNAVAILABLE');
      result.expires = share.expires;
    }
    if (share.max_accessed !== undefined) {
      if (typeof share.max_accessed !== 'number' ||
          !Number.isSafeInteger(share.max_accessed) || share.max_accessed < 0)
        throw new OpenListError('UPSTREAM_UNAVAILABLE');
      result.max_accessed = share.max_accessed;
    }
    return result;
  }
  async readText(path: string): Promise<{ path: string; text: string }> {
    const file = this.check(path);
    const raw = (await this.request('POST', '/api/fs/get', { path: file })).data;
    const meta = targetMetadata(raw, file);
    const sign = isObject(raw) && typeof raw.sign === 'string' && raw.sign.length <= 512 &&
      !/[\u0000-\u001f\u007f]/.test(raw.sign) ? raw.sign : undefined;
    if (sign === undefined) throw new OpenListError('NOT_SUPPORTED');
    if (meta.is_dir !== false || typeof meta.size !== 'number' || meta.size > MAX_TEXT_BYTES)
      throw new OpenListError('NOT_SUPPORTED');
    if (!/\.(txt|md|csv|json|yaml|yml|log|xml)$/i.test(file))
      throw new OpenListError('NOT_SUPPORTED');
    const route = '/d/' + file.slice(1).split('/').map(encodeURIComponent).join('/') +
      (sign ? '?sign=' + encodeURIComponent(sign) : '');
    const request = new Request('https://openlist.internal' + route, {
      // The unauthenticated internal download handler must never receive an admin credential.
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
    let response: Response;
    try { response = await this.config.binding.fetch(request); }
    catch { throw new OpenListError('UPSTREAM_UNAVAILABLE'); }
    if (response.status !== 200 || response.redirected || response.headers.has('location'))
      throw new OpenListError('NOT_SUPPORTED');
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!contentType || !['text/plain','text/markdown','text/csv','application/json',
      'application/xml','text/xml','application/yaml','text/yaml'].includes(contentType))
      throw new OpenListError('NOT_SUPPORTED');
    const bytes = await limitedBody(response, MAX_TEXT_BYTES);
    // A valid 200 can still be a partial upstream body. Never report it as a
    // complete text read without matching the independently returned file size.
    if (bytes.byteLength !== meta.size)
      throw new OpenListError('UPSTREAM_UNAVAILABLE');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new OpenListError('NOT_SUPPORTED'); }
    return { path: file, text };
  }
  async mkdir(path: string): Promise<OperationResult> {
    const target = this.check(path, true);
    const parent = target.slice(0, target.lastIndexOf('/'));
    const name = target.slice(target.lastIndexOf('/') + 1);
    this.check(parent);
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      // A partial page or an invalid listing cannot prove a target is absent.
      // This is only a collision preflight, NOT an atomic no-overwrite guarantee.
      const listing = await this.list(parent, 1, 100);
      if (listing.total !== listing.entries.length) throw new OpenListError('NOT_SUPPORTED');
      if (listing.entries.some(entry => entry.name === name))
        throw new OpenListError('CONFLICT');
      dispatched = true;
      const response = await this.request('POST', '/api/fs/mkdir', { path: target }, undefined, true);
      let observed: Record<string, unknown> | undefined;
      try { observed = await this.get(target); } catch { /* unverified post-dispatch */ }
      if (!observed || observed.name !== name || observed.is_dir !== true)
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      return { operation: 'openlist_create_folder', status: 'succeeded', code: 'OK',
        message: 'Upstream accepted and directory was independently observed; not atomic.',
        request_id, target, evidence: { business_code: response.code },
        observed_state: { is_dir: true } };
    } catch (error) {
      const code = error instanceof OpenListError ? error.code :
        dispatched ? 'UPSTREAM_UNCERTAIN' : 'UPSTREAM_UNAVAILABLE';
      const status = !dispatched ? 'not_executed' :
        code === 'UPSTREAM_UNCERTAIN' ? 'unknown' : 'failed';
      return { operation: 'openlist_create_folder', status, code,
        message: status === 'unknown' ?
          'Dispatch outcome cannot be determined; do not retry automatically.' :
          status === 'not_executed' ? 'No upstream mutation dispatched.' : 'Upstream rejected operation.',
        request_id, target };
    }
  }}
