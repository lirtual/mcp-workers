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
import { dispatchHyperdriveAction, dispatchHyperdriveRotationCheck, dispatchHyperdriveCredentialRotation, dispatchHyperdrivePrepare, dispatchHyperdriveApply, verifyGithubActionsDispatch,
  verifyGithubPrCapability, readHyperdriveUnbindStatus } from './github-actions.js';
import { previewHyperdriveCreation, createHyperdrivePreparation, createHyperdriveCredentialRotation, listHyperdriveOperations,
  recordHyperdriveDispatch, claimHyperdriveDispatch, claimHyperdriveApply, recordHyperdriveApplyDispatch, expireHyperdrivePreparations, type HyperdriveCandidate } from './hyperdrive-operations.js';
import { setupFailure, setupPage, setupResult, setupUnbindStatusResult, type ReplacementOrigin } from './page.js';
import reviewedManifest from '../../hyperdrive-bindings.json';
import { normalizeConnectionInput } from './connection-input.js';

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
/** The reviewed release manifest supplies immutable origin provenance only for
 * pre-0003 legacy references with NULL target_metadata. A non-NULL D1 value
 * is authoritative and must never be silently replaced if invalid.
 * The protected Runner separately verifies live Cloudflare TLS/CA/Binding. */
function sourceMetadata(
  row: { dialect: Dialect; config_id: string; binding_name: string; target_metadata: string | null }
): string | null {
  if (row.target_metadata !== null) return row.target_metadata;
  const matches = reviewedManifest.filter(candidate =>
    candidate.id === row.config_id || candidate.binding === row.binding_name);
  if (matches.length !== 1) return null;
  const reviewed = matches[0]!;
  if (reviewed.id !== row.config_id || reviewed.binding !== row.binding_name ||
      reviewed.dialect !== row.dialect) return null;
  return JSON.stringify(reviewed);
}

/** A CA may be reused without user input only from exact active, recorded
 * Hyperdrive target provenance. The protected Runner must independently read
 * and validate the CA before a candidate can be created or enabled. */
async function findRecordedCa(env: Env, dialect: Dialect, host: string, port: number): Promise<string | undefined> {
  if (!env.DB) throw new PublicError('CONFIGURATION_UNAVAILABLE','Database registry is unavailable.');
  const rows = await env.DB.prepare(`SELECT dialect,status,config_id,binding_name,target_metadata
    FROM database_connections WHERE transport='hyperdrive' AND status='active' LIMIT 11`).all<{
      dialect:Dialect; status:string; config_id:string; binding_name:string; target_metadata:string|null
    }>();
  const matches = new Set<string>();
  for (const row of rows.results) {
    if (row.dialect !== dialect) continue;
    const reviewed = sourceMetadata(row);
    if (!reviewed) continue;
    let metadata: Record<string,unknown>;
    try { metadata = JSON.parse(reviewed) as Record<string,unknown>; }
    catch { continue; }
    const expected = ['binding','id','dialect','origin_host','origin_port',
      'origin_database','origin_user','ca_certificate_id'];
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      Object.keys(metadata).length !== expected.length ||
      expected.some(key => !Object.hasOwn(metadata,key)) ||
      metadata.binding !== row.binding_name || metadata.id !== row.config_id ||
      metadata.dialect !== dialect || metadata.origin_host !== host.toLowerCase() ||
      metadata.origin_port !== port ||
      typeof metadata.ca_certificate_id !== 'string' ||
      !/^[A-Za-z0-9-]{8,128}$/.test(metadata.ca_certificate_id)) continue;
    matches.add(metadata.ca_certificate_id);
  }
  // Unknown/contradictory provenance is never guessed into a certificate.
  return matches.size === 1 ? [...matches][0] : undefined;
}

/** Replacement uses a new isolated config/Binding and a new logical ID.
 * Only the immutable origin is carried across. No old Cloudflare resource
 * is patched or released; the Runner verifies the CA independently. */
async function replacementCaFromSource(
 env: Env, sourceId: string, candidate: HyperdriveCandidate
): Promise<string> {
 if (!env.DB) throw new PublicError('CONFIGURATION_UNAVAILABLE','Database registry is unavailable.');
 if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(sourceId) || sourceId === candidate.id) invalid();
 const old = await env.DB.prepare('SELECT id,dialect,transport,status,config_id,binding_name,target_metadata,in_flight_count FROM database_connections WHERE id=?')
  .bind(sourceId).first<{
   id:string;dialect:Dialect;transport:string;status:string;config_id:string;
   binding_name:string;target_metadata:string|null;in_flight_count:number
  }>();
 // Candidate preparation creates a separate unbound config; it never edits,
 // disables or drains the source. In-flight source SQL may continue safely.
 if (!old || old.transport !== 'hyperdrive' ||
   !['active','disabled'].includes(old.status) ||
   old.dialect !== candidate.dialect ||
   !/^[a-f0-9]{32}$/i.test(old.config_id) || !/^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(old.binding_name) ||
   !sourceMetadata(old)) invalid();
 let metadata:Record<string,unknown>;
 try { metadata=JSON.parse(sourceMetadata(old)!) as Record<string,unknown>; }
 catch { return invalid(); }
 const keys=['binding','id','dialect','origin_host','origin_port','origin_database','origin_user','ca_certificate_id'];
 if (!metadata || typeof metadata!=='object' || Array.isArray(metadata) ||
   Object.keys(metadata).length !== keys.length || keys.some(key=>!Object.hasOwn(metadata,key)) ||
   metadata.binding!==old.binding_name || metadata.id!==old.config_id ||
   metadata.dialect!==candidate.dialect || metadata.origin_host!==candidate.host.toLowerCase() ||
   metadata.origin_port!==Number(candidate.port) || metadata.origin_database!==candidate.database ||
   typeof metadata.origin_user!=='string' ||
   typeof metadata.ca_certificate_id!=='string' ||
   !/^[A-Za-z0-9-]{8,128}$/.test(metadata.ca_certificate_id)) invalid();
 const pending=await env.DB.prepare("SELECT 1 AS blocked FROM hyperdrive_operations WHERE logical_id=? AND phase IN ('pending','running','awaiting_confirmation','unknown') LIMIT 1")
  .bind(sourceId).first<{blocked:number}>();
 if (pending) throw new PublicError('REVISION_CONFLICT','Original Hyperdrive connection has an unfinished operation.');
 return metadata.ca_certificate_id;
}

async function requireCaReplacementIdentity(
  env: Env, candidate: HyperdriveCandidate,
  preview: ReturnType<typeof previewHyperdriveCreation>
): Promise<void> {
  if (!env.DB) throw new PublicError('CONFIGURATION_UNAVAILABLE','Database registry is unavailable.');
    const replaces = candidate.caReplaces;
    if (replaces) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(replaces) ||
          replaces === candidate.id) invalid();
      const original = await env.DB.prepare(`SELECT id,dialect,transport,config_id,binding_name,target_metadata
        FROM database_connections WHERE id=?`).bind(replaces).first<{
          id:string; dialect:Dialect; transport:string; config_id:string;
          binding_name:string; target_metadata:string|null
        }>();
      if (!original || original.transport !== 'hyperdrive' ||
          !original.target_metadata) invalid();
      let prior: Record<string, unknown>;
      try { prior = JSON.parse(original.target_metadata) as Record<string, unknown>; }
      catch { return invalid(); }
      const expectedFields = ['binding','id','dialect','origin_host','origin_port',
        'origin_database','origin_user','ca_certificate_id'];
      if (!prior || typeof prior !== 'object' || Array.isArray(prior) ||
          Object.keys(prior).length !== expectedFields.length ||
          expectedFields.some(field => !Object.hasOwn(prior, field)) ||
          prior.binding !== original.binding_name || prior.id !== original.config_id ||
          prior.dialect !== original.dialect || prior.dialect !== preview.dialect ||
          prior.origin_host !== preview.host || prior.origin_port !== preview.port ||
          prior.origin_database !== preview.database ||
          prior.origin_user !== preview.user ||
          typeof prior.ca_certificate_id !== 'string' ||
          (candidate.caCertificateId && candidate.caCertificateId === prior.ca_certificate_id))
        invalid();
    }
}

/** Owner-only metadata prefill. Never render passwords, usernames, CA values,
 * config IDs or bindings. POST independently checks source provenance again. */
async function verifiedReplacementOrigin(db: D1Database, id: string, dialect: Dialect): Promise<ReplacementOrigin | undefined> {
  const row = await db.prepare('SELECT config_id,binding_name,target_metadata FROM database_connections WHERE id=? AND dialect=? AND transport=\'hyperdrive\'')
    .bind(id,dialect).first<{config_id:string;binding_name:string;target_metadata:string|null}>();
  if (!row) return undefined;
  const source = sourceMetadata({...row,dialect});
  if (!source) return undefined;
  let data: Record<string,unknown>;
  try { data = JSON.parse(source) as Record<string,unknown>; }
  catch { return undefined; }
  const keys = ['binding','id','dialect','origin_host','origin_port','origin_database','origin_user','ca_certificate_id'];
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
    Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data,key)) ||
    data.id !== row.config_id || data.binding !== row.binding_name || data.dialect !== dialect ||
    typeof data.origin_host !== 'string' ||
    !/^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(data.origin_host) ||
    !Number.isSafeInteger(data.origin_port) || (data.origin_port as number) < 1 || (data.origin_port as number) > 65535 ||
    typeof data.origin_database !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(data.origin_database) ||
    typeof data.origin_user !== 'string' || typeof data.ca_certificate_id !== 'string') return undefined;
  return {host:data.origin_host,port:data.origin_port as number,database:data.origin_database};
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
      // Read-only UI provenance: no Config ID, Binding name or CA is rendered.
      // A tombstone does NOT prove physical resources have been cleaned up.
      const retired = await env.DB.prepare(`SELECT id FROM retired_connection_ids
        WHERE upstream_config_id IS NOT NULL AND upstream_binding_name IS NOT NULL
        ORDER BY retired_at DESC,id ASC LIMIT 10`).all<{id:string}>();
      const selected = new URL(request.url).searchParams.getAll('edit');
      const replacing = selected.length === 1
        ? connections.find(row => row.transport === 'hyperdrive' && row.id === selected[0])
        : undefined;
      const origin = replacing ? await verifiedReplacementOrigin(env.DB, replacing.id, replacing.dialect) : undefined;
      return setupPage(connections, token, operations, retired.results.map(row=>row.id), replacing, origin);
    }
    if (request.method !== 'POST' || !/^\/setup\/(add|edit|enable|disable|delete|rotate|hyperdrive-action|hyperdrive-apply|hyperdrive-unbind-status|hyperdrive-rotation-check|hyperdrive-credentials|github-actions-check)$/.test(path))
      return setupFailure('not_found', 404);
    const form = await formData(request);
    validateCsrf(request, env, required(form, 'csrf'));
    const action = path.slice('/setup/'.length);
    if (action !== 'hyperdrive-unbind-status' && action !== 'hyperdrive-rotation-check') await expireHyperdrivePreparations(env.DB);
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
    const id = required(form, 'id');
    if (action === 'hyperdrive-credentials') {
      if (required(form, 'confirm_id') !== id || required(form, 'confirm_credentials') !== '1') invalid();
      const expected = revision(form);
      const newPassword = required(form, 'new_password');
      const prepared = await createHyperdriveCredentialRotation(env.DB, env, id, expected, newPassword);
      await claimHyperdriveDispatch(env.DB, prepared.operationId);
      let runId: number | undefined;
      try { runId = (await dispatchHyperdriveCredentialRotation(env, prepared.operationId, requestFetch)).runId; }
      catch (error) {
        await recordHyperdriveDispatch(env.DB, prepared.operationId);
        throw error;
      }
      await recordHyperdriveDispatch(env.DB, prepared.operationId, runId);
      return setupResult('Password update request accepted. Connection remains disabled. Operation ID: ' +
        prepared.operationId + (runId ? '. GitHub Run ID: ' + runId : '. Run receipt unknown; reconcile before retry.') +
        '. Write-only credentials require independent validation; API acceptance is not success.');
    }
    if (action === 'add') {
      const dialect = required(form, 'dialect');
      if (dialect !== 'mysql' && dialect !== 'postgres') invalid();
      const transport = required(form, 'transport');
      if (transport !== 'direct' && transport !== 'hyperdrive') invalid();
      requireAvailableMode(transport, dialect);
      // An Edit replacement must never fall through to creating a plaintext Direct connection.
      if (transport !== 'hyperdrive' && form.getAll('replacement_for').some(Boolean)) invalid();
      if (transport === 'hyperdrive' && form.has('input_mode')) {
        const entry = normalizeConnectionInput(form, dialect, transport);
        const candidate: HyperdriveCandidate = {
          id, dialect, host: entry.host, port: String(entry.port), database: entry.database,
          user: entry.user, password: entry.password,
          caPem: form.get('ca_pem') || undefined,
          caCertificateId: form.get('ca_certificate_id') || undefined,
          caReplaces: form.get('ca_replaces') || undefined
        };
        const replaces = form.getAll('replacement_for');
        if (replaces.length > 1 || (replaces[0] && (candidate.caReplaces || candidate.caCertificateId))) invalid();
        if (replaces[0]) {
          const priorCa = await replacementCaFromSource(env, replaces[0], candidate);
          if (!candidate.caPem) candidate.caCertificateId = priorCa;
        } else if (!candidate.caReplaces && !candidate.caPem && !candidate.caCertificateId) {
          candidate.caCertificateId = await findRecordedCa(env, dialect, entry.host, entry.port);
        }
        const preview = previewHyperdriveCreation(candidate);
        await requireCaReplacementIdentity(env, candidate, preview);
        // One Save authorizes unbound preparation only; a source/Binding release
        // still requires the reviewed, explicit final confirmation.
        await verifyGithubPrCapability(env, requestFetch);
        const prepared = await createHyperdrivePreparation(env.DB, env, candidate);
        await claimHyperdriveDispatch(env.DB, prepared.operationId);
        let runId: number | undefined;
        try { runId = (await dispatchHyperdrivePrepare(env, prepared.operationId, requestFetch)).runId; }
        catch (error) {
          await recordHyperdriveDispatch(env.DB, prepared.operationId);
          throw error;
        }
        await recordHyperdriveDispatch(env.DB, prepared.operationId, runId);
        return setupResult('Hyperdrive preparation accepted. Operation ID: ' + prepared.operationId +
          (runId ? '. GitHub Run ID: ' + runId : '. Run receipt unknown; reconcile before retry.') +
          '. No connection is active until reviewed release and independent validation.');
      }
      if (transport === 'hyperdrive') invalid(); // Manual Config ID/Binding registration is retired.
      if (transport !== 'direct' || formCa(form)) invalid();
      if (form.get('plaintext_ack') !== '1')
        throw new PublicError('INVALID_INPUT', 'Direct plaintext acceptance is required.');
      const url = form.has('input_mode')
        ? normalizeConnectionInput(form, dialect, transport).url : required(form, 'url');
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
    if (action === 'hyperdrive-rotation-check') {
      if (row.transport !== 'hyperdrive' || row.status !== 'disabled' ||
          row.revision !== version) invalid();
      const mode = required(form, 'rotation_mode');
      if (mode !== 'credentials' && mode !== 'ca') invalid();
      const receipt = await dispatchHyperdriveRotationCheck(env, mode, id, version, requestFetch);
      return setupResult('Read-only Hyperdrive rotation isolation check accepted. Review the protected GitHub Run. No password, CA, Worker, or D1 changes requested.' +
        (receipt.runId ? ' Workflow Run ID: ' + receipt.runId + '.' : ' Dispatch is not an eligibility receipt.'));
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
      // Logical deletion requires Disabled + revision CAS and is guarded by
      // durable in-flight / unresolved-operation SQL triggers. Historical
      // Cloudflare bindings, configs and CA MUST NOT be deleted here.
      await deleteRegistryConnection(env.DB, id, version, required(form, 'confirm_id'));
      return setupResult('Logical connection retired. Its ID cannot be reused. The Cloudflare Hyperdrive configuration, Binding and CA remain intact for separately verified cleanup. No database data was altered.');
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
      if (formCa(form)) invalid();
      const previous = await openConnectionConfig(env, id, row.dialect,
        { keyId: row.key_id, ciphertext: row.ciphertext });
      const url = mode === 'keep' ? previous.url : form.has('input_mode')
        ? normalizeConnectionInput(form, row.dialect, 'direct').url : required(form, 'url');
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
