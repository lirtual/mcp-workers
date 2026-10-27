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
// Existing verified Cloudflare Workers Route, not a user-controlled redirect target.
const OPENLIST_PUBLIC_ORIGIN = 'https://openlist.lirtual.dpdns.org';
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
  // Explicit-ID, read-only share metadata. Publication still requires separate
  // approval and real client acceptance. Never query the global share list.
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


  // Non-public adapters for Spec #309: existing upstream APIs only.
  // External exposure and irreversible revocation require trusted user approval
  // before corresponding MCP tools can be registered.
  async createShare(files: string[], expiresHours: number, maxAccessed: number): Promise<OperationResult> {
    if (!Array.isArray(files) || files.length < 1 || files.length > 8 ||
        !Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 168 ||
        !Number.isInteger(maxAccessed) || maxAccessed < 1 || maxAccessed > 100)
      throw new OpenListError('INVALID_INPUT');
    const checked = files.map(f => this.check(f));
    if (new Set(checked).size !== checked.length) throw new OpenListError('INVALID_INPUT');
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const pwd = Array.from(crypto.getRandomValues(new Uint8Array(24)),
      n => n.toString(16).padStart(2, '0')).join('');
    const expires = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      for (const f of checked) {
        const meta = await this.get(f);
        if (typeof meta.is_dir !== 'boolean') throw new OpenListError('UPSTREAM_UNAVAILABLE');
      }
      try {
        await this.getShare(id);
        throw new OpenListError('CONFLICT');
      } catch (error) {
        if (!(error instanceof OpenListError) || error.code !== 'NOT_FOUND') throw error;
      }
      dispatched = true;
      const reply = await this.request('POST', '/api/share/create',
        { id, files: checked, pwd, expires, max_accessed: maxAccessed, disabled: false },
        undefined, true);
      const after = await this.getShare(id);
      if (after.disabled !== false || after.expires !== expires ||
          after.max_accessed !== maxAccessed ||
          JSON.stringify(after.files) !== JSON.stringify(checked))
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      // The creator receives the generated password once. No other share query
      // returns credentials; do not log this result or publish without consent.
      return { operation: 'openlist_share_create', status: 'succeeded', code: 'OK',
        message: 'Password-protected share created using native non-atomic API. Credentials are one-time secrets.',
        request_id, target: id, evidence: { business_code: reply.code },
        observed_state: { ...after, password_once: pwd,
          share_url: 'https://openlist.lirtual.dpdns.org/@s/' + encodeURIComponent(id) } };
    } catch (error) {
      return { operation: 'openlist_share_create',
        status: dispatched ? 'unknown' : 'not_executed',
        code: dispatched ? 'UPSTREAM_UNCERTAIN' :
          error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE',
        message: dispatched ? 'Share creation uncertain; never retry automatically.' :
          'No external share created.', request_id, target: id };
    }
  }

  async updateShare(id: string, expiresHours?: number, maxAccessed?: number): Promise<OperationResult> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        (expiresHours === undefined && maxAccessed === undefined) ||
        (expiresHours !== undefined &&
          (!Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 168)) ||
        (maxAccessed !== undefined &&
          (!Number.isInteger(maxAccessed) || maxAccessed < 1 || maxAccessed > 100)))
      throw new OpenListError('INVALID_INPUT');
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      const before = await this.getShare(id);
      const changes: Record<string, unknown> = { id };
      if (expiresHours !== undefined)
        changes.expires = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();
      if (maxAccessed !== undefined) changes.max_accessed = maxAccessed;
      dispatched = true;
      const reply = await this.request('POST', '/api/share/update', changes, undefined, true);
      const after = await this.getShare(id);
      if (JSON.stringify(after.files) !== JSON.stringify(before.files) ||
          after.disabled !== before.disabled ||
          (changes.expires !== undefined && after.expires !== changes.expires) ||
          (changes.max_accessed !== undefined && after.max_accessed !== changes.max_accessed))
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      return { operation: 'openlist_share_update', status: 'succeeded', code: 'OK',
        message: 'Share policy observed after non-atomic native update.',
        request_id, target: id, evidence: { business_code: reply.code },
        observed_state: after };
    } catch (error) {
      return { operation: 'openlist_share_update',
        status: dispatched ? 'unknown' : 'not_executed',
        code: dispatched ? 'UPSTREAM_UNCERTAIN' :
          error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE',
        message: dispatched ? 'Update uncertain; never retry automatically.' :
          'No share update dispatched.', request_id, target: id };
    }
  }

  async enableShare(id: string): Promise<OperationResult> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new OpenListError('INVALID_INPUT');
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      const before = await this.getShare(id);
      if (before.disabled === false)
        return { operation: 'openlist_share_enable', status: 'not_executed',
          code: 'ALREADY_ENABLED', message: 'No mutation dispatched.',
          request_id, target: id, observed_state: { disabled: false } };
      dispatched = true;
      const reply = await this.request('POST', '/api/share/enable?id=' +
        encodeURIComponent(id), undefined, undefined, true);
      const after = await this.getShare(id);
      if (after.disabled !== false || JSON.stringify(after.files) !== JSON.stringify(before.files) ||
          after.expires !== before.expires || after.max_accessed !== before.max_accessed)
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      return { operation: 'openlist_share_enable', status: 'succeeded', code: 'OK',
        message: 'Share observed enabled after non-atomic native operation.',
        request_id, target: id, evidence: { business_code: reply.code },
        observed_state: { disabled: false } };
    } catch (error) {
      return { operation: 'openlist_share_enable',
        status: dispatched ? 'unknown' : 'not_executed',
        code: dispatched ? 'UPSTREAM_UNCERTAIN' :
          error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE',
        message: dispatched ? 'Enable uncertain; never retry automatically.' :
          'No share enable dispatched.', request_id, target: id };
    }
  }

  async revokeShare(id: string): Promise<OperationResult> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new OpenListError('INVALID_INPUT');
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      await this.getShare(id);
      dispatched = true;
      const reply = await this.request('POST', '/api/share/delete?id=' +
        encodeURIComponent(id), undefined, undefined, true);
      try {
        await this.getShare(id);
      } catch (error) {
        if (error instanceof OpenListError && error.code === 'NOT_FOUND')
          return { operation: 'openlist_share_revoke', status: 'succeeded', code: 'OK',
            message: 'Share ID absent after native revoke; source files are not deleted.',
            request_id, target: id, evidence: { business_code: reply.code },
            observed_state: { revoked: true } };
        throw error;
      }
      throw new OpenListError('UPSTREAM_UNCERTAIN');
    } catch (error) {
      return { operation: 'openlist_share_revoke',
        status: dispatched ? 'unknown' : 'not_executed',
        code: dispatched ? 'UPSTREAM_UNCERTAIN' :
          error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE',
        message: dispatched ? 'Revoke uncertain; never retry automatically.' :
          'No share revoke dispatched.', request_id, target: id };
    }
  }

  async deleteFile(path: string): Promise<OperationResult> {
    const target = this.check(path, true);
    const dir = target.slice(0, target.lastIndexOf('/'));
    const name = target.slice(target.lastIndexOf('/') + 1);
    this.check(dir);
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      const before = await this.get(target);
      if (before.is_dir !== false) throw new OpenListError('NOT_SUPPORTED');
      dispatched = true;
      const reply = await this.request('POST', '/api/fs/remove',
        { dir, names: [name] }, undefined, true);
      try {
        await this.get(target);
      } catch (error) {
        if (error instanceof OpenListError && error.code === 'NOT_FOUND')
          return { operation: 'openlist_delete', status: 'succeeded', code: 'OK',
            message: 'One file absent after native non-atomic delete.',
            request_id, target, evidence: { business_code: reply.code },
            observed_state: { deleted: true } };
        throw error;
      }
      throw new OpenListError('UPSTREAM_UNCERTAIN');
    } catch (error) {
      return { operation: 'openlist_delete',
        status: dispatched ? 'unknown' : 'not_executed',
        code: dispatched ? 'UPSTREAM_UNCERTAIN' :
          error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE',
        message: dispatched ? 'Delete outcome uncertain; never retry automatically.' :
          'No deletion dispatched.', request_id, target };
    }
  }

  // Uses only existing non-atomic upstream Share API semantics, as approved by
  // Spec #309 Owner. Scope is an MCP preflight, not an atomic upstream guarantee.
  async disableShare(id: string): Promise<OperationResult> {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new OpenListError('INVALID_INPUT');
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      // getShare verifies the exact ID and every referenced path before a write.
      const before = await this.getShare(id);
      if (before.disabled === true)
        return { operation: 'openlist_share_disable', status: 'not_executed',
          code: 'ALREADY_DISABLED', message: 'No mutation dispatched.',
          request_id, target: id, observed_state: { disabled: true } };

      dispatched = true;
      const reply = await this.request('POST', '/api/share/disable?id=' +
        encodeURIComponent(id), undefined, undefined, true);
      // Upstream reports code:200 even when the share no longer exists.
      // Require an independent scoped readback with unchanged share identity.
      const after = await this.getShare(id);
      if (after.disabled !== true ||
          JSON.stringify(after.files) !== JSON.stringify(before.files) ||
          after.expires !== before.expires ||
          after.max_accessed !== before.max_accessed)
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      return { operation: 'openlist_share_disable', status: 'succeeded',
        code: 'OK', message: 'Share observed disabled; upstream mutation is not atomic.',
        request_id, target: id, evidence: { business_code: reply.code },
        observed_state: { disabled: true } };
    } catch (error) {
      // After dispatch, even an HTTP 200 or 404 cannot prove an exact outcome.
      // Never replay a potentially effected mutation.
      const code = dispatched ? 'UPSTREAM_UNCERTAIN' :
        error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE';
      return { operation: 'openlist_share_disable',
        status: dispatched ? 'unknown' : 'not_executed', code,
        message: dispatched ? 'Outcome uncertain; do not retry automatically.' :
          'No upstream mutation dispatched.',
        request_id, target: id };
    }
  }
  async uploadSmall(path: string, content: string, encoding: 'utf8' | 'base64'): Promise<OperationResult> {
    const target = this.check(path, true);
    const parent = target.slice(0, target.lastIndexOf('/'));
    this.check(parent);
    if (typeof content !== 'string' || !['utf8','base64'].includes(encoding))
      throw new OpenListError('INVALID_INPUT');
    const MAX_UPLOAD_BYTES = 1024 * 1024;
    let bytes: Uint8Array;
    if (encoding === 'utf8') {
      bytes = new TextEncoder().encode(content);
    } else {
      // Strict canonical Base64 avoids multiple textual forms of the same payload.
      if (content.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
        throw new OpenListError('INVALID_INPUT');
      let binary: string;
      try { binary = atob(content); }
      catch { throw new OpenListError('INVALID_INPUT'); }
      bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      if (btoa(binary) !== content) throw new OpenListError('INVALID_INPUT');
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES)
      throw new OpenListError('LIMIT_EXCEEDED');
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      // OpenList PUT has native overwrite behavior. Do not promise no-overwrite.
      dispatched = true;
      const reply = await this.request('PUT', '/api/fs/put', bytes,
        { 'File-Path': encodeURIComponent(target), 'Content-Type': 'application/octet-stream' }, true);
      const after = await this.get(target);
      if (after.is_dir !== false || after.size !== bytes.byteLength)
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      return { operation: 'openlist_upload_small', status: 'succeeded', code: 'OK',
        message: 'Native OpenList PUT accepted; destination observed with matching size. May overwrite, not atomic.',
        request_id, target, evidence: { business_code: reply.code },
        observed_state: { size: bytes.byteLength, native_may_overwrite: true } };
    } catch (error) {
      const code = dispatched ? 'UPSTREAM_UNCERTAIN' :
        error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE';
      return { operation: 'openlist_upload_small',
        status: dispatched ? 'unknown' : 'not_executed', code,
        message: dispatched ? 'Upload outcome uncertain; do not retry automatically.' :
          'No upload dispatched.', request_id, target };
    }
  }
  // The native OpenList file APIs may overwrite existing destinations. This
  // MCP adapter never asserts an atomic no-overwrite or durable transaction.
  private async performFileMutation(kind: 'rename' | 'copy' | 'move',
      sourcePath: string, destination: string): Promise<OperationResult> {
    const source = this.check(sourcePath, true);
    const dest = this.check(destination, true);
    const srcParent = source.slice(0, source.lastIndexOf('/'));
    const dstParent = dest.slice(0, dest.lastIndexOf('/'));
    const srcName = source.slice(source.lastIndexOf('/') + 1);
    const destName = dest.slice(dest.lastIndexOf('/') + 1);
    this.check(srcParent);
    this.check(dstParent);
    if (source === dest || dest.startsWith(source + '/'))
      throw new OpenListError('INVALID_PATH');
    if (kind === 'rename' && dstParent !== srcParent)
      throw new OpenListError('INVALID_INPUT');
    if (kind !== 'rename' && destName !== srcName)
      throw new OpenListError('INVALID_INPUT');

    const operation = 'openlist_' + kind;
    const request_id = crypto.randomUUID();
    let dispatched = false;
    try {
      const before = await this.get(source);
      if (typeof before.is_dir !== 'boolean')
        throw new OpenListError('UPSTREAM_UNAVAILABLE');
      // OpenList's built-in copy/move API accepts an array of names; always
      // submit exactly one canonical target. Native overwrite is possible.
      const data = kind === 'rename' ? { path: source, name: destName } :
        { src_dir: srcParent, dst_dir: dstParent, names: [srcName] };
      dispatched = true;
      const reply = await this.request('POST', '/api/fs/' + kind, data, undefined, true);
      const after = await this.get(dest);
      if (after.path !== dest || after.is_dir !== before.is_dir)
        throw new OpenListError('UPSTREAM_UNCERTAIN');
      return { operation, status: 'succeeded', code: 'OK',
        message: 'Destination was observed after the native OpenList operation; upstream may overwrite and is not atomic.',
        request_id, target: source, evidence: { business_code: reply.code },
        observed_state: { destination: dest, is_dir: after.is_dir,
          native_may_overwrite: true } };
    } catch (error) {
      const code = dispatched ? 'UPSTREAM_UNCERTAIN' :
        error instanceof OpenListError ? error.code : 'UPSTREAM_UNAVAILABLE';
      return { operation, status: dispatched ? 'unknown' : 'not_executed',
        code, message: dispatched ?
          'Native operation dispatched; result uncertain, do not retry automatically.' :
          'No upstream mutation dispatched.',
        request_id, target: source };
    }
  }
  async renameFile(sourcePath: string, newName: string): Promise<OperationResult> {
    const source = this.check(sourcePath, true);
    const name = canonicalName(newName);
    const parent = source.slice(0, source.lastIndexOf('/'));
    return this.performFileMutation('rename', source, parent + '/' + name);
  }
  async copyFile(sourcePath: string, destinationDir: string): Promise<OperationResult> {
    const source = this.check(sourcePath, true);
    const dir = this.check(destinationDir);
    const name = source.slice(source.lastIndexOf('/') + 1);
    return this.performFileMutation('copy', source, dir + '/' + name);
  }
  async moveFile(sourcePath: string, destinationDir: string): Promise<OperationResult> {
    const source = this.check(sourcePath, true);
    const dir = this.check(destinationDir);
    const name = source.slice(source.lastIndexOf('/') + 1);
    return this.performFileMutation('move', source, dir + '/' + name);
  }
  async downloadLink(path: string): Promise<Record<string, unknown>> {
    const file = this.check(path);
    // Only the existing fixed OpenList API produces the signature. Never
    // forward its raw_url, storage provider URL, headers or admin credential.
    const raw = (await this.request('POST', '/api/fs/get', { path: file })).data;
    const meta = targetMetadata(raw, file);
    if (meta.is_dir !== false || !isObject(raw) || typeof raw.sign !== 'string')
      throw new OpenListError('NOT_SUPPORTED');
    const match = /^(0|[1-9][0-9]{1,12})\.[a-f0-9]{64}$/.exec(raw.sign);
    if (!match) throw new OpenListError('NOT_SUPPORTED');
    const expires = Number(match[1]);
    if (!Number.isSafeInteger(expires) || (expires !== 0 &&
        (expires <= Math.floor(Date.now() / 1000) || !Number.isFinite(expires * 1000) ||
          expires * 1000 > 8.64e15)))
      throw new OpenListError('NOT_SUPPORTED');
    const route = '/api/p/' + file.slice(1).split('/').map(encodeURIComponent).join('/');
    const url = OPENLIST_PUBLIC_ORIGIN + route + '?sign=' + encodeURIComponent(raw.sign);
    return { path: file, url, access: 'signed_bearer_link',
      permanent: expires === 0,
      expires_at: expires === 0 ? null : new Date(expires * 1000).toISOString(),
      warning: expires === 0 ?
        'OpenList upstream signed URL has no expiry (link_expiration=0). Anyone holding this URL may access the file.' :
        'Anyone holding this signed URL may access the file until its upstream expiry.' };
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
