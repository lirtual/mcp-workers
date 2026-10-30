import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';
import type { EncryptionKeys } from '../registry/crypto.js';

export interface HyperdriveCandidate {
  id: string;
  dialect: Dialect;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  caCertificateId?: string | undefined;
  caPem?: string | undefined;
  caReplaces?: string | undefined;
}
export interface HyperdriveOperation {
  operationId: string;
  id: string;
  action: 'create' | 'rotate_credentials';
  phase: 'pending';
}
export interface HyperdriveOperationSummary {
  operation_id: string;
  logical_id: string;
  action: string;
  phase: string;
  config_id: string | null;
  pr_number: number | null;
  prepare_run_id: number | null;
  ci_run_id: number | null;
  release_run_id: number | null;
  apply_run_id: number | null;
  expires_at: number;
  head_sha: string | null;
  expected_source_sha: string | null;
  expected_revision: number;
  binding_name: string | null;
  error_class: string | null;
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const caPattern = /^[A-Za-z0-9-]{8,128}$/;
const dnsPattern = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const pemPattern = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/;
const encoder = new TextEncoder();
function invalid(): never { throw new PublicError('INVALID_INPUT', 'Invalid Hyperdrive candidate.'); }
function conflict(): never { throw new PublicError('REVISION_CONFLICT', 'Hyperdrive operation conflicts with a connection or an unresolved operation.'); }
function unavailable(): never { throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Hyperdrive operations are unavailable.'); }
function safeName(value: unknown, max: number, pattern: RegExp): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && pattern.test(value);
}
export function previewHyperdriveCreation(candidate: HyperdriveCandidate) {
  if (!safeName(candidate.id, 64, idPattern) || !['mysql', 'postgres'].includes(candidate.dialect) ||
    !safeName(candidate.host, 253, dnsPattern) ||
    /\.(?:localhost|local|internal|test|invalid|example|arpa)$/i.test(candidate.host) ||
    /^[0-9.]+$/.test(candidate.host) ||
    !safeName(candidate.database, 128, /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/) ||
    !safeName(candidate.user, 128, /^[A-Za-z0-9_.-]{1,128}$/) ||
    typeof candidate.password !== 'string' || candidate.password.length < 1 ||
    encoder.encode(candidate.password).byteLength > 2048 ||
    !/^[1-9][0-9]{0,4}$/.test(candidate.port) ||
    Number(candidate.port) > 65535) invalid();
  if (candidate.caReplaces !== undefined &&
      (!safeName(candidate.caReplaces, 64, idPattern) || candidate.caReplaces === candidate.id)) invalid();
  const hasCaId = !!candidate.caCertificateId;
  const hasPem = !!candidate.caPem;
  if (hasCaId === hasPem) invalid();
  if (hasCaId && !safeName(candidate.caCertificateId, 128, caPattern)) invalid();
  if (hasPem && (!safeName(candidate.caPem, 16384, pemPattern) ||
    encoder.encode(candidate.caPem).byteLength > 16384)) invalid();
  return {
    id: candidate.id, dialect: candidate.dialect, host: candidate.host.toLowerCase(),
    port: Number(candidate.port), database: candidate.database, user: candidate.user,
    tls: candidate.dialect === 'mysql' ? 'VERIFY_IDENTITY' : 'verify-full',
    cachingDisabled: true, caSource: hasCaId ? 'existing' : 'upload'
  };
}
function keyMaterial(keys: EncryptionKeys): Uint8Array {
  if (!safeName(keys.DATABASE_KEY_ID, 32, /^[A-Za-z0-9_-]+$/) ||
    typeof keys.DATABASE_ENCRYPTION_KEY !== 'string') unavailable();
  try {
    const raw = Uint8Array.from(atob(keys.DATABASE_ENCRYPTION_KEY), c => c.charCodeAt(0));
    if (raw.length !== 32 || btoa(String.fromCharCode(...raw)) !== keys.DATABASE_ENCRYPTION_KEY) unavailable();
    return raw;
  } catch { return unavailable(); }
}
async function cryptoKey(keys: EncryptionKeys): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', keyMaterial(keys).buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function authenticatedContext(operationId: string, logicalId: string, revision: number): Uint8Array {
  return encoder.encode('database-mcp:hyperdrive-operation:v1:' + operationId + ':create:' + logicalId + ':' + revision);
}
function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) unavailable();
  try {
    const out = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    if (encode(out) !== value) unavailable();
    return out;
  } catch { return unavailable(); }
}
export async function createHyperdrivePreparation(
  db: D1Database, keys: EncryptionKeys, candidate: HyperdriveCandidate
): Promise<HyperdriveOperation> {
  previewHyperdriveCreation(candidate);
  if (!db) unavailable();
  const operationId = crypto.randomUUID();
  const revision = 0; // Creation cannot mutate an existing logical ID.
  const plaintext = encoder.encode(JSON.stringify(candidate));
  if (plaintext.byteLength > 24545) invalid();
  const key = await cryptoKey(keys);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = encode(iv) + '.' + encode(new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: new Uint8Array(authenticatedContext(operationId, candidate.id, revision))
  }, key, plaintext)));
  const now = Date.now();
  try {
    const inserted = await db.prepare(`INSERT INTO hyperdrive_operations
      (operation_id,logical_id,action,expected_revision,phase,ciphertext,key_id,created_at,updated_at,expires_at)
      SELECT ?,?,'create',0,'pending',?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM database_connections WHERE id=?)
        AND NOT EXISTS (SELECT 1 FROM retired_connection_ids WHERE id=?)
        AND (SELECT COUNT(*) FROM database_connections)
          + (SELECT COUNT(*) FROM hyperdrive_operations WHERE action='create'
               AND phase IN ('pending','running','awaiting_confirmation','unknown')) < 10`)
      .bind(operationId,candidate.id,ciphertext,keys.DATABASE_KEY_ID,now,now,now+15*60_000,
        candidate.id,candidate.id).run();
    if (inserted.meta.changes !== 1) conflict();
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|hyperdrive reservation conflict/i.test(error.message)) conflict();
    unavailable();
  }
  return { operationId, id: candidate.id, action: 'create', phase: 'pending' };
}
export async function listHyperdriveOperations(db: D1Database): Promise<HyperdriveOperationSummary[]> {
  if (!db) unavailable();
  try {
    const rows = await db.prepare(`SELECT operation_id,logical_id,action,phase,config_id,pr_number,
      prepare_run_id,apply_run_id,ci_run_id,release_run_id,expires_at,head_sha,expected_source_sha,expected_revision,binding_name,error_class FROM hyperdrive_operations
      ORDER BY updated_at DESC LIMIT 20`).all<HyperdriveOperationSummary>();
    for (const row of rows.results) {
      if (!/^[0-9a-f-]{36}$/.test(row.operation_id) || !idPattern.test(row.logical_id) ||
        !['create','rotate_credentials','rotate_ca','retire'].includes(row.action) ||
        !['pending','running','awaiting_confirmation','completed','failed','unknown'].includes(row.phase) ||
        [row.pr_number,row.prepare_run_id,row.apply_run_id,row.ci_run_id,row.release_run_id].some(n =>
          n !== null && (!Number.isSafeInteger(n) || n < 1))) unavailable();
      if (row.error_class !== null && !['ca_permission_denied','ca_upstream_unavailable',
        'ca_inventory_incomplete','ca_inventory_ambiguous','ca_name_collision',
        'ca_content_mismatch','ca_outcome_requires_reconciliation','ca_receipt_unknown',
        'ca_reference_invalid','ca_receipt_invalid','ca_write_claim_failed',
        'github_dispatch_inflight','github_receipt_unknown',
        'preparation_expired','preparation_requires_reconciliation','github_pr_ci_pending',
        'github_apply_dispatch_inflight','github_apply_accepted','github_apply_receipt_unknown',
        'postrelease_verified','postrelease_disabled','apply_verifying','apply_merge_started','apply_release_failed','apply_release_dispatching','apply_release_pending','apply_verification_blocked',
        'apply_policy_unavailable','apply_pr_stale','apply_pr_draft','apply_merge_denied',
        'apply_ci_receipt_unknown','apply_ci_failed','apply_ci_pending','apply_review_missing','apply_checks_unknown','apply_main_advanced','apply_merge_sha_unknown',
        'apply_read_unavailable','apply_write_rejected','apply_outcome_unknown','apply_cas_failed',
        'apply_logical_id_unavailable','apply_source_invalid','apply_config_drift','apply_release_receipt_unknown',
        'credential_isolation_blocked','credential_outcome_unknown','credential_health_unverified',
        'credential_origin_sql_verified'].includes(row.error_class)) {
        row.error_class = 'operation_blocked';
      }
    }
    return rows.results;
  } catch { return unavailable(); }
}
/** Internal Runner/verification helper, never expose through an HTTP endpoint. */
export async function readHyperdrivePreparation(
  db: D1Database, keys: EncryptionKeys, operationId: string
): Promise<HyperdriveCandidate> {
  if (!/^[0-9a-f-]{36}$/.test(operationId)) invalid();
  const row = await db.prepare(`SELECT logical_id,action,expected_revision,ciphertext,key_id
    FROM hyperdrive_operations WHERE operation_id=? AND expires_at>?
      AND phase IN ('pending','running','unknown')`).bind(operationId, Date.now()).first<{
      logical_id: string; action: string; expected_revision: number; ciphertext: string | null; key_id: string | null
    }>();
  if (!row || row.action !== 'create' || row.key_id !== keys.DATABASE_KEY_ID ||
    !row.ciphertext) unavailable();
  const parts = row.ciphertext.split('.');
  if (parts.length !== 2) unavailable();
  const iv = decode(parts[0]!); const content = decode(parts[1]!);
  if (iv.length !== 12 || content.length < 16) unavailable();
  try {
    const bytes = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: new Uint8Array(iv),
      additionalData: new Uint8Array(authenticatedContext(operationId, row.logical_id, row.expected_revision))
    }, await cryptoKey(keys), new Uint8Array(content));
    const result = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as HyperdriveCandidate;
    previewHyperdriveCreation(result);
    if (result.id !== row.logical_id) unavailable();
    return result;
  } catch { return unavailable(); }
}

/** Claim before I/O: a timeout or second submission must never dispatch twice. */
export async function claimHyperdriveDispatch(db: D1Database, operationId: string): Promise<void> {
  try {
    const changed = await db.prepare(`UPDATE hyperdrive_operations SET phase='running',
      error_class='github_dispatch_inflight',updated_at=?
      WHERE operation_id=? AND phase='pending' AND expires_at>?`)
      .bind(Date.now(),operationId,Date.now()).run();
    if (changed.meta.changes !== 1) conflict();
  } catch (error) {
    if (error instanceof PublicError) throw error;
    unavailable();
  }
}
/** Dispatch acceptance is never a completion signal. Never overwrite a faster Runner. */
export async function recordHyperdriveDispatch(
  db: D1Database, operationId: string, runId?: number
): Promise<void> {
  if (runId !== undefined && (!Number.isSafeInteger(runId) || runId < 1)) invalid();
  const phase = runId ? 'running' : 'unknown';
  try {
    const updated = await db.prepare(`UPDATE hyperdrive_operations SET phase=?,prepare_run_id=?,
      error_class=?,updated_at=? WHERE operation_id=? AND phase='running'
      AND prepare_run_id IS NULL AND error_class='github_dispatch_inflight'`)
      .bind(phase, runId ?? null, runId ? null : 'github_receipt_unknown', Date.now(), operationId).run();
    if (updated.meta.changes !== 1) {
      const row = await db.prepare(`SELECT phase,prepare_run_id FROM hyperdrive_operations
        WHERE operation_id=?`).bind(operationId).first<{phase:string;prepare_run_id:number|null}>();
      if (!row || row.phase === 'pending' ||
        (runId !== undefined && row.prepare_run_id !== runId)) conflict();
    }
  } catch (error) {
    if (error instanceof PublicError) throw error;
    unavailable();
  }
}
/** Lazy bounded cleanup; unknown side effects always retain their unique reservation. */
export async function expireHyperdrivePreparations(db: D1Database): Promise<void> {
  try {
    await db.prepare(`UPDATE hyperdrive_operations SET
      phase=CASE WHEN phase='pending' OR
        (action='rotate_credentials' AND phase='running' AND resource_write_started_at IS NULL)
        THEN 'failed' WHEN action='rotate_credentials' AND phase='running'
          AND resource_write_started_at IS NOT NULL THEN 'unknown' ELSE phase END,
      ciphertext=NULL,key_id=NULL,updated_at=?,
      error_class=CASE WHEN phase='pending' THEN 'preparation_expired'
        WHEN action='rotate_credentials' AND phase='running' AND resource_write_started_at IS NULL
          THEN 'credential_isolation_blocked'
        WHEN action='rotate_credentials' AND phase='running' AND resource_write_started_at IS NOT NULL
          THEN 'credential_outcome_unknown' ELSE error_class END
      WHERE operation_id IN (SELECT operation_id FROM hyperdrive_operations
        WHERE expires_at<=? AND (ciphertext IS NOT NULL OR phase='pending') LIMIT 20)`)
      .bind(Date.now(),Date.now()).run();
  } catch { unavailable(); }
}

/** Same predicate drives the page and the atomic claim; no replay of unknown writes. */
export function canApplyHyperdrive(op: HyperdriveOperationSummary): boolean {
  return op.action === 'create' && op.expected_revision === 0 && op.phase === 'awaiting_confirmation' &&
    op.apply_run_id === null && op.pr_number !== null && op.pr_number > 0 &&
    /^[a-f0-9]{32}$/.test(op.config_id ?? '') && op.binding_name !== null &&
    /^[0-9a-f]{40}$/.test(op.head_sha ?? '') &&
    /^[0-9a-f]{40}$/.test(op.expected_source_sha ?? '') && op.expires_at > Date.now();
}
export async function claimHyperdriveApply(db: D1Database, operationId: string, logicalId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(operationId) || !idPattern.test(logicalId)) invalid();
  try {
    // After explicit final confirmation, extend the nonsecret operation
    // window to cover CI, merge, release and postrelease readback. A pending
    // encrypted candidate still expires after 15 minutes.
    const now = Date.now();
    const changed = await db.prepare(`UPDATE hyperdrive_operations SET phase='running',
      error_class='github_apply_dispatch_inflight',updated_at=?,expires_at=?
      WHERE operation_id=? AND logical_id=? AND action='create' AND expected_revision=0
        AND phase='awaiting_confirmation' AND expires_at>? AND apply_run_id IS NULL
        AND ciphertext IS NULL AND key_id IS NULL
        AND pr_number>0 AND config_id IS NOT NULL AND binding_name IS NOT NULL
        AND length(head_sha)=40 AND length(expected_source_sha)=40`)
      .bind(now,now+7*24*60*60_000,operationId,logicalId,now).run();
    if (changed.meta.changes !== 1) conflict();
  } catch (error) { if (error instanceof PublicError) throw error; unavailable(); }
}
export async function recordHyperdriveApplyDispatch(db: D1Database, operationId: string, runId?: number): Promise<void> {
  if (runId !== undefined && (!Number.isSafeInteger(runId) || runId<1)) invalid();
  try {
    // A faster Runner owns subsequent state. This update cannot overwrite it.
    await db.prepare(`UPDATE hyperdrive_operations SET phase=?,apply_run_id=?,error_class=?,updated_at=?
      WHERE operation_id=? AND phase='running' AND apply_run_id IS NULL
        AND error_class='github_apply_dispatch_inflight'`)
      .bind(runId ? 'running' : 'unknown',runId ?? null,
        runId ? 'github_apply_accepted' : 'github_apply_receipt_unknown',Date.now(),operationId).run();
  } catch { unavailable(); }
}

/** Owner approval reserves one password-only change without exposing the password to GitHub inputs. */
export async function createHyperdriveCredentialRotation(
  db: D1Database, keys: EncryptionKeys, id: string, expectedRevision: number, password: string
): Promise<HyperdriveOperation> {
  if (!idPattern.test(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      typeof password !== 'string' || password.length < 1 || encoder.encode(password).byteLength > 2048) invalid();
  if (!db) unavailable();
  const operationId = crypto.randomUUID();
  const key = await cryptoKey(keys);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode('database-mcp:hyperdrive-operation:v1:' + operationId +
    ':rotate_credentials:' + id + ':' + expectedRevision);
  const ciphertext = encode(iv) + '.' + encode(new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: aad
  }, key, encoder.encode(JSON.stringify({password})))));
  const now = Date.now();
  try {
    const result = await db.prepare(`INSERT INTO hyperdrive_operations
      (operation_id,logical_id,action,expected_revision,phase,ciphertext,key_id,
       config_id,binding_name,created_at,updated_at,expires_at)
      SELECT ?,c.id,'rotate_credentials',c.revision,'pending',?,?,c.config_id,c.binding_name,?,?,?
      FROM database_connections c WHERE c.id=? AND c.transport='hyperdrive'
        AND c.status='disabled' AND c.revision=? AND c.in_flight_count=0
        AND c.target_metadata IS NOT NULL AND length(c.config_id)=32
        AND c.binding_name LIKE 'HYPERDRIVE_%'
        AND NOT EXISTS (SELECT 1 FROM hyperdrive_operations o WHERE o.logical_id=c.id
          AND o.phase IN ('pending','running','awaiting_confirmation','unknown'))`)
      .bind(operationId,ciphertext,keys.DATABASE_KEY_ID,now,now,now+15*60_000,id,expectedRevision).run();
    if (result.meta.changes !== 1) conflict();
  } catch(error) {
    if (error instanceof PublicError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) conflict();
    unavailable();
  }
  return {operationId,id,action:'rotate_credentials',phase:'pending'};
}
