import { getRuntimeLimits, parseDirectDatabaseUrl } from '../config.js';
import { healthCheck } from '../db/index.js';
import { PublicError, toPublicError } from '../errors.js';
import { requireAvailableMode } from '../registry/availability.js';
import { openConnectionConfig, sealConnectionConfig } from '../registry/crypto.js';
import { validatePublicEndpoint } from '../registry/endpoint.js';
import { createRegistryConnection, deleteRegistryConnection, getRegistryConnection,
  listRegistryConnections, setRegistryConnectionStatus, updateRegistryConnection } from '../registry/store.js';
import { rotateRegistryKeys } from '../registry/rotation.js';
import type { Dialect, Env } from '../types.js';
import { validateCsrf, verifyAccess } from './access.js';
import { dispatchHyperdriveAction, dispatchHyperdrivePrepare, dispatchHyperdriveApply, verifyGithubActionsDispatch,
  verifyGithubPrCapability, readHyperdriveUnbindStatus } from './github-actions.js';
import { previewHyperdriveCreation, createHyperdrivePreparation, listHyperdriveOperations,
  recordHyperdriveDispatch, claimHyperdriveDispatch, claimHyperdriveApply, recordHyperdriveApplyDispatch, expireHyperdrivePreparations, type HyperdriveCandidate } from './hyperdrive-operations.js';
import { setupFailure, setupPage, setupResult, setupUnbindStatusResult } from './page.js';

function invalid(): never { throw new PublicError('INVALID_INPUT', 'The connection form is invalid.'); }
function required(form: URLSearchParams, field: string): string {
  const values = form.getAll(field);
  if (values.length !== 1 || !values[0]) {
    if (field === 'id') throw new PublicError('INVALID_INPUT', 'A connection ID is required.');
    if (field === 'url') throw new PublicError('INVALID_INPUT', 'A complete Direct database URL is required.');
    invalid();
  }
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
// Fixed Owner-facing references only; never include upstream errors, keys, URLs, SQL or identities.
export function setupFailureReference(error: PublicError): string | undefined {
  if (error.code === 'INVALID_INPUT') {
    const exact: Record<string, string> = {
      'A connection ID is required.': 'connection_id_missing',
      'Invalid connection id.': 'connection_id_invalid',
      'A complete Direct database URL is required.': 'url_missing',
      'Direct plaintext acceptance is required.': 'plaintext_ack_required',
      'Database target is immutable; create a new connection ID.': 'target_immutable',
      'The database endpoint resolves to a nonpublic or reserved address.': 'endpoint_nonpublic',
      'The database endpoint hostname is not an eligible public DNS name.': 'hostname_invalid'
    };
    if (exact[error.message]) return exact[error.message];
    // Parser messages contain a connection ID, so only classify their fixed
    // suffix; never reflect IDs, URLs, credentials, or raw exceptions.
    if (error.message.endsWith(' has unsupported direct database URL options.')) return 'url_options';
    if (error.message.endsWith(' uses an unsupported direct database URL scheme.')) return 'url_scheme';
    if (error.message.endsWith(' has an invalid direct database URL.')) return 'url_format';
    if (error.message.endsWith(' has an invalid direct database port.')) return 'url_port';
    return 'form_invalid';
  }
  if (error.code !== 'CONFIGURATION_UNAVAILABLE') return undefined;
  const known: Record<string, string> = {
    'Owner authentication configuration is incomplete.': 'auth_configuration',
    'Owner Access signing certificates are unavailable.': 'auth_certificates',
    'Owner Access runtime identity is unavailable.': 'auth_identity',
    'Owner Access signing-key fetch failed.': 'auth_certs_fetch',
    'Owner Access signing-key response was rejected.': 'auth_certs_http',
    'Owner Access signing-key document was invalid.': 'auth_certs_json',
    'Owner setup is not configured.': 'runtime_bindings',
    'The database registry is unavailable.': 'registry_read',
    'The database registry is invalid.': 'registry_shape',
    'Protected GitHub Actions dispatch is not configured.': 'github_token_missing',
    'GitHub Actions dispatch outcome unknown.': 'github_outcome_unknown',
    'GitHub Actions dispatch receipt unavailable.': 'github_receipt_invalid',
    'GitHub Actions dispatch unauthorized.': 'github_unauthorized',
    'GitHub Actions dispatch forbidden.': 'github_forbidden',
    'GitHub Actions workflow unavailable.': 'github_workflow_missing',
    'GitHub Actions dispatch inputs rejected.': 'github_inputs_rejected',
    'GitHub Actions dispatch rate limited.': 'github_rate_limited',
    'GitHub Actions dispatch redirect rejected.': 'github_redirect_rejected',
    'GitHub Actions dispatch upstream unavailable.': 'github_upstream_unavailable',
    'GitHub Actions dispatch HTTP rejected.': 'github_http_rejected',
    'GitHub PR permissions could not be verified.': 'github_pr_permission_unknown',
    'GitHub Actions PR creation is disabled.': 'github_pr_creation_disabled',
    'GitHub required PR checks could not be verified.': 'github_required_checks_unknown',
    'Hyperdrive CA upload permission has not been verified.': 'cloudflare_ca_permission_unknown',
    'Hyperdrive credential isolation could not be verified.': 'hyperdrive_isolation_unknown'
  };
  return known[error.message] ?? 'other';
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
export async function handleSetup(
  request: Request, env: Env, requestFetch: typeof fetch = fetch,
  access?: CloudflareAccessContext
): Promise<Response> {
  try {
    const identity = await verifyAccess(request, env, requestFetch, access);
    if (!env.DB || !env.SETUP_RATE_LIMITER) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Owner setup is not configured.');
    const throttle = await env.SETUP_RATE_LIMITER.limit({ key: 'owner:' + identity.sub });
    if (!throttle.success) throw new PublicError('RATE_LIMITED', 'Owner setup rate limit exceeded.');
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/setup') {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      const connections = await listRegistryConnections(env.DB);
      const operations = await listHyperdriveOperations(env.DB);
      return setupPage(connections, token, operations);
    }
    if (request.method !== 'POST' || !/^\/setup\/(add|edit|enable|disable|delete|rotate|hyperdrive-action|hyperdrive-preview|hyperdrive-prepare|hyperdrive-apply|hyperdrive-unbind-status|github-actions-check)$/.test(path))
      return setupFailure('not_found', 404);
    const form = await formData(request);
    validateCsrf(request, env, required(form, 'csrf'));
    const action = path.slice('/setup/'.length);
    await expireHyperdrivePreparations(env.DB);
    if (action === 'rotate') {
      // The Worker cannot inspect the private key material of rollback-eligible
      // versions or historical D1 backups. Require an explicit Owner attestation
      // of those external recovery checks before any ciphertext is re-encrypted.
      if (form.getAll('rotation_ack').length !== 1 || form.get('rotation_ack') !== 'verified') {
        throw new PublicError('INVALID_INPUT', 'Rotation recovery compatibility confirmation is required.');
      }
      const rotated = await rotateRegistryKeys(env.DB, env);
      return setupResult(`Rotated ${rotated.rotated}; remaining ${rotated.pending}. Keep historical keys until snapshots and backups expire.`);
    }
    if (action === 'github-actions-check') {
      const receipt = await verifyGithubActionsDispatch(env, requestFetch);
      return setupResult('GitHub accepted a verification-only, no-deploy workflow request. No database or Worker changes were requested.' +
        (receipt.runId ? ' Workflow Run ID: ' + receipt.runId + '.' : ' Check the Actions run result separately.'));
    }
    if (action === 'hyperdrive-apply') {
      const operationId = required(form, 'operation_id');
      const id = required(form, 'confirm_id');
      if (required(form, 'confirm_apply') !== '1') invalid();
      await claimHyperdriveApply(env.DB, operationId, id);
      let runId: number | undefined;
      try { runId = (await dispatchHyperdriveApply(env, operationId, requestFetch)).runId; }
      catch (error) {
        await recordHyperdriveApplyDispatch(env.DB, operationId);
        throw error;
      }
      await recordHyperdriveApplyDispatch(env.DB, operationId, runId);
      return setupResult('Final apply request accepted. Operation ID: ' + operationId +
        (runId ? '. GitHub Run ID: ' + runId : '. Run receipt unknown; reconcile before retry.') +
        '. Merge, release and activation remain subject to protected verification.');
    }
    if (action === 'hyperdrive-preview' || action === 'hyperdrive-prepare') {
      const dialect = required(form, 'dialect');
      if (dialect !== 'mysql' && dialect !== 'postgres') invalid();
      for (const field of ['id','dialect','origin_host','origin_port','origin_database',
        'origin_user','origin_password','ca_certificate_id','ca_pem']) {
        if (form.getAll(field).length > 1) invalid();
      }
      const candidate: HyperdriveCandidate = {
        id: required(form, 'id'), dialect,
        host: required(form, 'origin_host'), port: required(form, 'origin_port'),
        database: required(form, 'origin_database'), user: required(form, 'origin_user'),
        password: required(form, 'origin_password'),
        caCertificateId: form.get('ca_certificate_id') || undefined,
        caPem: form.get('ca_pem') || undefined
      };
      const preview = previewHyperdriveCreation(candidate);
      if (action === 'hyperdrive-preview') {
        return setupResult('Preview only (no resources changed): ' + preview.id + ' · ' +
          preview.dialect + ' · ' + preview.host + ':' + preview.port + '/' + preview.database +
          ' · strict ' + preview.tls + ' · caching disabled · CA ' + preview.caSource +
          '. Return to /setup and separately confirm Prepare with your credentials.');
      }
      if (form.getAll('confirm_prepare').length !== 1 || form.get('confirm_prepare') !== '1') invalid();
      await verifyGithubPrCapability(env, requestFetch);
      const prepared = await createHyperdrivePreparation(env.DB, env, candidate);
      await claimHyperdriveDispatch(env.DB, prepared.operationId);
      let runId: number | undefined;
      try {
        const receipt = await dispatchHyperdrivePrepare(env, prepared.operationId, requestFetch);
        runId = receipt.runId;
      } catch (error) {
        // The upstream may have accepted an operation before the HTTP failure.
        // Preserve its unique D1 identity; never auto-retry a possible Cloudflare mutation.
        await recordHyperdriveDispatch(env.DB, prepared.operationId);
        throw error;
      }
      await recordHyperdriveDispatch(env.DB, prepared.operationId, runId);
      return setupResult('Preparation request accepted. Operation ID: ' + prepared.operationId +
        (runId ? '. GitHub Run ID: ' + runId : '. GitHub run receipt unknown; reconcile before retry.') +
        '. This is not a Hyperdrive configuration or deployment confirmation.');
    }
    const id = required(form, 'id');
    if (action === 'add') {
      const dialect = required(form, 'dialect');
      if (dialect !== 'mysql' && dialect !== 'postgres') invalid();
      const transport = required(form, 'transport');
      if (transport !== 'direct' && transport !== 'hyperdrive') invalid();
      requireAvailableMode(transport, dialect);
      if (transport === 'hyperdrive') {
        // Only the protected post-release finalizer can create a Hyperdrive D1
        // reference after exact Worker version, binding, origin and TLS readback.
        throw new PublicError('CONFIGURATION_UNAVAILABLE',
          'Create Hyperdrive through the reviewed Prepare and final Apply lifecycle.');
      }
      if (transport !== 'direct' || formCa(form)) invalid();
      if (form.get('plaintext_ack') !== '1')
        throw new PublicError('INVALID_INPUT', 'Direct plaintext acceptance is required.');
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
    if (action === 'hyperdrive-unbind-status') {
      if (row.transport !== 'hyperdrive' || row.status !== 'disabled' || row.revision !== version) invalid();
      return setupUnbindStatusResult(await readHyperdriveUnbindStatus(env, id, requestFetch));
    }
    if (action === 'hyperdrive-action') {
      if (row.transport !== 'hyperdrive' || row.status !== 'disabled' || row.revision !== version) invalid();
      const operation = required(form, 'hyperdrive_action');
      if (operation !== 'enable' && operation !== 'retire') invalid();
      if (operation === 'retire' && required(form, 'confirm_id') !== id) invalid();
      const receipt = await dispatchHyperdriveAction(env, operation, id, version, requestFetch);
      return setupResult('Protected GitHub Actions request accepted. For retirement, a Draft unbinding PR may be staged instead of deleting D1. Review the Run and do not treat dispatch as completion.' +
        (receipt.runId ? ' Workflow Run ID: ' + receipt.runId + '.' : ''));
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
      if (row.transport !== 'direct') throw new PublicError('CONFIGURATION_UNAVAILABLE',
        'Hyperdrive credential isolation could not be verified.');
      const mode = required(form, 'credential_mode');
      if (mode !== 'keep' && mode !== 'replace') invalid();
      // Any sensitive Direct update is a new explicit acceptance of plaintext risk.
      if (mode === 'replace' && form.get('plaintext_ack') !== '1') invalid();
      if (formCa(form)) invalid();
      const previous = await openConnectionConfig(env, id, row.dialect,
        { keyId: row.key_id, ciphertext: row.ciphertext });
      const url = mode === 'keep' ? previous.url : required(form, 'url');
      if (mode === 'replace') {
        const current = parseDirectDatabaseUrl(previous.url, id);
        const next = parseDirectDatabaseUrl(url, id);
        // A logical ID cannot silently switch upstream database identity.
        // Only credentials may change; moving the target requires a new ID.
        if (current.dialect !== next.dialect || current.host !== next.host ||
            current.port !== next.port || current.database !== next.database) {
          throw new PublicError('INVALID_INPUT', 'Database target is immutable; create a new connection ID.');
        }
      }
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
    return setupFailure(safe.code.toLowerCase(), status(safe), setupFailureReference(safe));
  }
}
