import { getRuntimeLimits } from '../config.js';
import { healthCheck } from '../db/index.js';
import { PublicError, toPublicError } from '../errors.js';
import { openConnectionConfig, sealConnectionConfig } from '../registry/crypto.js';
import { validatePublicEndpoint } from '../registry/endpoint.js';
import { createRegistryConnection, deleteRegistryConnection, getRegistryConnection,
  listRegistryConnections, setRegistryConnectionStatus, updateRegistryConnection } from '../registry/store.js';
import { rotateRegistryKeys } from '../registry/rotation.js';
import type { Dialect, Env } from '../types.js';
import { validateCsrf, verifyAccess } from './access.js';
import { setupFailure, setupPage, setupResult } from './page.js';

function invalid(): never { throw new PublicError('INVALID_INPUT', 'The connection form is invalid.'); }
function required(form: URLSearchParams, field: string): string {
  const values = form.getAll(field);
  if (values.length !== 1 || !values[0]) invalid();
  return values[0];
}
function revision(form: URLSearchParams): number {
  const raw = required(form, 'revision');
  const value = Number(raw);
  if (!/^[1-9][0-9]{0,12}$/.test(raw) || !Number.isSafeInteger(value)) invalid();
  return value;
}
async function formData(request: Request): Promise<URLSearchParams> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 20000) throw new PublicError('BODY_TOO_LARGE', 'Request body is too large.');
  if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) invalid();
  const text = await request.text();
  if (text.length > 20000) throw new PublicError('BODY_TOO_LARGE', 'Request body is too large.');
  return new URLSearchParams(text);
}
async function testCandidate(env: Env, id: string, url: string, dialect: Dialect): Promise<void> {
  const parsed = await validatePublicEndpoint(url, id);
  if (parsed.dialect !== dialect) invalid();
  await healthCheck({ config: { id, transport: 'direct', url }, transport: 'direct',
    ...parsed, limits: { ...getRuntimeLimits(env), queryTimeoutMs: 5000 } });
}
async function requiredRow(env: Env, id: string) {
  if (!env.DB) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Database registry is unavailable.');
  const row = await getRegistryConnection(env.DB, id);
  if (!row) throw new PublicError('CONNECTION_NOT_FOUND', 'Connection does not exist.');
  return row;
}
function status(error: PublicError): number {
  if (error.code === 'AUTH_REQUIRED') return 401;
  if (error.code === 'ACCESS_DENIED') return 403;
  if (error.code === 'CONNECTION_NOT_FOUND') return 404;
  if (error.code === 'REVISION_CONFLICT') return 409;
  if (error.code === 'BODY_TOO_LARGE') return 413;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'CONFIGURATION_UNAVAILABLE' || error.code === 'ENCRYPTION_KEY_UNAVAILABLE') return 503;
  return 422;
}

/** Owner setup is strictly separated from bearer-token /mcp. */
export async function handleSetup(request: Request, env: Env, requestFetch: typeof fetch = fetch): Promise<Response> {
  try {
    const identity = await verifyAccess(request, env, requestFetch);
    if (!env.DB || !env.SETUP_RATE_LIMITER) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Owner setup is not configured.');
    const throttle = await env.SETUP_RATE_LIMITER.limit({ key: 'owner:' + identity.sub });
    if (!throttle.success) throw new PublicError('RATE_LIMITED', 'Owner setup rate limit exceeded.');
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/setup') {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      return setupPage(await listRegistryConnections(env.DB), token);
    }
    if (request.method !== 'POST' || !/^\/setup\/(add|edit|enable|disable|delete|rotate)$/.test(path))
      return setupFailure('not_found', 404);
    const form = await formData(request);
    validateCsrf(request, env, required(form, 'csrf'));
    const action = path.slice('/setup/'.length);
    if (action === 'rotate') {
      const rotated = await rotateRegistryKeys(env.DB, env);
      return setupResult(`Rotated ${rotated.rotated}; remaining ${rotated.pending}. Keep historical keys until snapshots and backups expire.`);
    }
    const id = required(form, 'id');
    if (action === 'add') {
      const dialect = required(form, 'dialect');
      if (dialect !== 'mysql' && dialect !== 'postgres') invalid();
      const url = required(form, 'url');
      const parsed = await validatePublicEndpoint(url, id);
      if (parsed.dialect !== dialect) invalid();
      let healthy = false;
      try { await testCandidate(env, id, url, dialect); healthy = true; }
      catch (error) {
        const safe = toPublicError(error);
        if (form.get('allow_disabled') !== '1' ||
          !['CONNECTION_UNAVAILABLE', 'QUERY_TIMEOUT', 'DATABASE_ERROR'].includes(safe.code)) throw safe;
      }
      const sealed = await sealConnectionConfig(env, id, dialect, { url });
      await createRegistryConnection(env.DB, { id, dialect, ciphertext: sealed.ciphertext, keyId: sealed.keyId });
      if (healthy) await setRegistryConnectionStatus(env.DB, id, 1, 'active');
      return setupResult(healthy ? 'Connection verified and enabled.' : 'Candidate stored disabled; verify before enabling.');
    }
    const version = revision(form);
    const row = await requiredRow(env, id);
    if (action === 'disable') {
      await setRegistryConnectionStatus(env.DB, id, version, 'disabled');
      return setupResult('Connection disabled for new operations.');
    }
    if (action === 'delete') {
      await deleteRegistryConnection(env.DB, id, version, required(form, 'confirm_id'));
      return setupResult('Disabled connection record deleted. No upstream database was altered.');
    }
    if (action === 'enable') {
      if (row.status !== 'disabled') invalid();
      const config = await openConnectionConfig(env, id, row.dialect,
        { keyId: row.key_id, ciphertext: row.ciphertext });
      await testCandidate(env, id, config.url, row.dialect);
      await setRegistryConnectionStatus(env.DB, id, version, 'active');
      return setupResult('Connection health verified and enabled.');
    }
    if (action === 'edit') {
      const mode = required(form, 'credential_mode');
      if (mode !== 'keep' && mode !== 'replace') invalid();
      const previous = await openConnectionConfig(env, id, row.dialect,
        { keyId: row.key_id, ciphertext: row.ciphertext });
      const url = mode === 'keep' ? previous.url : required(form, 'url');
      // Active connection edits always require a verified healthy replacement.
      // A disabled record may retain an unreachable, structurally valid candidate
      // for subsequent repair, but the disabled state is never changed here.
      await validatePublicEndpoint(url, id);
      try { await testCandidate(env, id, url, row.dialect); }
      catch (error) {
        const safe = toPublicError(error);
        if (row.status !== 'disabled' || form.get('allow_disabled') !== '1' ||
          !['CONNECTION_UNAVAILABLE', 'QUERY_TIMEOUT', 'DATABASE_ERROR'].includes(safe.code)) throw safe;
      }
      const sealed = await sealConnectionConfig(env, id, row.dialect, { ...previous, url });
      await updateRegistryConnection(env.DB, id, version,
        { dialect: row.dialect, ciphertext: sealed.ciphertext, keyId: sealed.keyId });
      return setupResult('Only the selected connection configuration was updated. Status is unchanged.');
    }
    return setupFailure('not_found', 404);
  } catch (error) {
    const safe = toPublicError(error);
    return setupFailure(safe.code.toLowerCase(), status(safe));
  }
}
