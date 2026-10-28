import { getRuntimeLimits } from '../config.js';
import { healthCheck } from '../db/index.js';
import { PublicError, toPublicError } from '../errors.js';
import { isStagedOriginalIdentity, requireAvailableMode } from '../registry/availability.js';
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
  const maxBytes = 40_000;
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new PublicError('BODY_TOO_LARGE', 'Request body is too large.');
  }
  if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) invalid();
  if (!request.body) invalid();
  // Enforce the byte limit while reading: request.text() buffers the entire
  // body first, leaving chunked or falsely declared large requests unbounded.
  const reader = request.body.getReader();
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - size) {
        void reader.cancel().catch(() => undefined);
        throw new PublicError('BODY_TOO_LARGE', 'Request body is too large.');
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)); }
  catch { return invalid(); }
  return new URLSearchParams(text);
}
function formCa(form: URLSearchParams): string | undefined {
  const values = form.getAll('ca');
  if (values.length > 1) invalid();
  const ca = values[0]?.trim();
  if (!ca) return undefined;
  if (ca.length > 16384 ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(ca)) invalid();
  return ca;
}
async function testCandidate(env: Env, id: string, url: string, dialect: Dialect, ca?: string): Promise<void> {
  const parsed = await validatePublicEndpoint(url, id);
  if (parsed.dialect !== dialect) invalid();
  await healthCheck({ config: { id, transport: 'direct', url }, transport: 'direct',
    ...parsed, ...(ca ? { ca } : {}), limits: { ...getRuntimeLimits(env), queryTimeoutMs: 5000 } });
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
    // Frozen first import: generic add or key rotation must not alter the
    // exact two-identity inventory before the protected atomic activation.
    if (action === 'add' || action === 'rotate') {
      const metadata = await listRegistryConnections(env.DB);
      if (metadata.some(isStagedOriginalIdentity)) {
        throw new PublicError('CONFIGURATION_UNAVAILABLE',
          'The original migration inventory is frozen until protected atomic activation.');
      }
    }
    if (action === 'rotate') {
      const rotated = await rotateRegistryKeys(env.DB, env);
      return setupResult(`Rotated ${rotated.rotated}; remaining ${rotated.pending}. Keep historical keys until snapshots and backups expire.`);
    }
    const id = required(form, 'id');
    if (action === 'add') {
      const dialect = required(form, 'dialect');
      if (dialect !== 'mysql' && dialect !== 'postgres') invalid();
      const transport = required(form, 'transport');
      if (transport !== 'direct' && transport !== 'hyperdrive') invalid();
      requireAvailableMode(transport, dialect);
      if (transport === 'hyperdrive') {
        // The binding and Cloudflare-managed credential/CA must already be configured
        // through the separately authorized protected release before activation.
        await createRegistryConnection(env.DB, {
          id, dialect, transport, configId: required(form, 'config_id'), bindingName: required(form, 'binding_name')
        });
        return setupResult('Hyperdrive reference saved disabled. Publish and verify its dedicated binding and strict TLS before enabling.');
      }
      if (transport !== 'direct' || form.get('plaintext_ack') !== '1' || formCa(form)) invalid();
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
      await createRegistryConnection(env.DB, { id, dialect, transport, ciphertext: sealed.ciphertext, keyId: sealed.keyId });
      if (healthy) await setRegistryConnectionStatus(env.DB, id, 1, 'active');
      return setupResult(healthy ? 'Plaintext Direct connection verified and enabled.' : 'Direct candidate saved disabled; verify before enabling.');
    }
    const version = revision(form);
    const row = await requiredRow(env, id);
    if (isStagedOriginalIdentity(row)) {
      throw new PublicError('CONFIGURATION_UNAVAILABLE',
        'The original migration connection requires independently protected atomic activation.');
    }
    if (action === 'disable') {
      await setRegistryConnectionStatus(env.DB, id, version, 'disabled');
      return setupResult('Connection disabled for new operations.');
    }
    if (action === 'delete') {
      if (row.transport === 'hyperdrive') {
        // Current-version unbinding cannot prove older rollback versions have released
        // this config or a shared CA. Fail closed until independent retire evidence.
        invalid();
      }
      await deleteRegistryConnection(env.DB, id, version, required(form, 'confirm_id'));
      return setupResult('Disabled connection record retired. No upstream database was altered.');
    }
    if (action === 'enable') {
      requireAvailableMode(row.transport, row.dialect);
      if (row.status !== 'disabled') invalid();
      // Runtime proxy fields cannot attest Cloudflare CA/identity/cache settings.
      // Hyperdrive is activated only by the protected Owner-triggered Actions gate.
      if (row.transport === 'hyperdrive') {
        throw new PublicError('CONFIGURATION_UNAVAILABLE',
          'Hyperdrive activation requires protected Cloudflare readback and live health verification.');
      }
      if (form.get('plaintext_ack') !== '1') invalid();
      const config = await openConnectionConfig(env, id, row.dialect,
        { keyId: row.key_id, ciphertext: row.ciphertext });
      await testCandidate(env, id, config.url, row.dialect);
      await setRegistryConnectionStatus(env.DB, id, version, 'active');
      return setupResult('Connection checked and enabled.');
    }
    if (action === 'edit') {
      requireAvailableMode(row.transport, row.dialect);
      if (row.transport !== 'direct') invalid(); // Cloudflare-managed Hyperdrive refs are immutable.
      const mode = required(form, 'credential_mode');
      if (mode !== 'keep' && mode !== 'replace') invalid();
      // Any sensitive Direct update is a new explicit acceptance of plaintext risk.
      if (mode === 'replace' && form.get('plaintext_ack') !== '1') invalid();
      if (formCa(form)) invalid();
      const previous = await openConnectionConfig(env, id, row.dialect,
        { keyId: row.key_id, ciphertext: row.ciphertext });
      const url = mode === 'keep' ? previous.url : required(form, 'url');
      // Active failed edits preserve the prior ciphertext, revision and status.
      await validatePublicEndpoint(url, id);
      try { await testCandidate(env, id, url, row.dialect); }
      catch (error) {
        const safe = toPublicError(error);
        if (row.status !== 'disabled' || form.get('allow_disabled') !== '1' ||
          !['CONNECTION_UNAVAILABLE', 'QUERY_TIMEOUT', 'DATABASE_ERROR'].includes(safe.code)) throw safe;
      }
      const sealed = await sealConnectionConfig(env, id, row.dialect, { url });
      await updateRegistryConnection(env.DB, id, version,
        { dialect: row.dialect, ciphertext: sealed.ciphertext, keyId: sealed.keyId });
      return setupResult('Selected Direct configuration updated; status unchanged.');
    }
    return setupFailure('not_found', 404);
  } catch (error) {
    const safe = toPublicError(error);
    return setupFailure(safe.code.toLowerCase(), status(safe));
  }
}
