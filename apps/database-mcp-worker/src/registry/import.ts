import { parseDatabaseConfig, parseDirectDatabaseUrl } from '../config.js';
import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';
import { MAX_CONNECTION_CIPHERTEXT_LENGTH, openConnectionConfig, sealConnectionConfig } from './crypto.js';
import type { EncryptionKeys } from './crypto.js';
import { getRegistryConnection } from './store.js';

/** Offline-only cutover primitive; source Secret stays in memory. No DB probe.
 * Not exposed via deployed MCP, HTTP setup or release workflow.
 * Imported records remain disabled until separate real TLS acceptance.
 */
export async function prepareLegacyCatalog(
  keys: EncryptionKeys, rawCatalog: string, approvedIds: readonly string[]
): Promise<ReadonlyArray<{ id: string; dialect: Dialect; ciphertext: string; keyId: string }>> {
  if (!Array.isArray(approvedIds) || approvedIds.length < 1 || approvedIds.length > 10 ||
      approvedIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) ||
      new Set(approvedIds).size !== approvedIds.length) {
    throw new PublicError('INVALID_INPUT', 'The approved connection inventory is invalid.');
  }
  const configs = parseDatabaseConfig(rawCatalog);
  if (configs.length !== approvedIds.length ||
      !configs.every(c => approvedIds.includes(c.id)) ||
      !approvedIds.every(id => configs.some(c => c.id === id))) {
    throw new PublicError('INVALID_INPUT', 'The frozen connection inventory does not match approval.');
  }
  const encrypted = [];
  for (const config of configs) {
    if (config.transport !== 'direct') throw new PublicError('INVALID_INPUT', 'Legacy imports require Direct transport.');
    const { dialect } = parseDirectDatabaseUrl(config.url, config.id);
    const sealed = await sealConnectionConfig(keys, config.id, dialect, { url: config.url });
    const recovered = await openConnectionConfig(keys, config.id, dialect,
      { keyId: sealed.keyId, ciphertext: sealed.ciphertext });
    if (recovered.url !== config.url) {
      throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Migration encryption verification failed.');
    }
    encrypted.push({ id: config.id, dialect, ciphertext: sealed.ciphertext, keyId: sealed.keyId });
  }
  return encrypted;
}


/**
 * Read-only, offline source-to-D1 attestation. Compare every frozen legacy URL
 * to authenticated AES-GCM data under its immutable ID and dialect.
 * No upstream socket, credential output, log or network probe is performed.
 * This is not a release approval and never activates imported connections.
 */
export async function verifyLegacyCatalogReadback(
  db: D1Database, keys: EncryptionKeys, rawCatalog: string, approvedIds: readonly string[]
): Promise<{ verified: number }> {
  // This also validates the frozen inventory and rejects unsupported transports
  // before making any D1 reads; each sealed candidate stays memory-only.
  const prepared = await prepareLegacyCatalog(keys, rawCatalog, approvedIds);
  const originals = parseDatabaseConfig(rawCatalog);
  if (!db) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Migration readback unavailable.');
  try {
    for (const original of originals) {
      if (original.transport !== 'direct') throw Error('mismatch');
      const row = await getRegistryConnection(db, original.id);
      const expected = prepared.find(item => item.id === original.id);
      if (!row || row.transport !== 'direct' || !expected || row.dialect !== expected.dialect ||
          (row.status !== 'disabled' && row.status !== 'active') ||
          row.revision < 1) throw Error('mismatch');
      const opened = await openConnectionConfig(keys, row.id, row.dialect,
        { keyId: row.key_id!, ciphertext: row.ciphertext! });
      if (opened.url !== original.url || opened.ca !== undefined) throw Error('mismatch');
    }
  } catch {
    // Do not leak D1 diagnostics, ciphertext, database endpoints or passwords.
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Migration readback verification failed.');
  }
  return { verified: originals.length };
}

/** One atomic SQLite statement, without UPSERT, replace or secret logging.
 * Not wired to production; a separately authorized runner would use this only
 * after freezing and verifying the authoritative legacy catalog.
 */
export async function insertLegacyCatalogAtomically(
  db: D1Database, rows: ReadonlyArray<{ id: string; dialect: Dialect; ciphertext: string; keyId: string }>
): Promise<{ inserted: number }> {
  if (!db || !Array.isArray(rows) || rows.length < 1 || rows.length > 10 ||
      new Set(rows.map(r => r.id)).size !== rows.length ||
      rows.some(r => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(r.id) ||
        !['mysql', 'postgres'].includes(r.dialect) ||
        typeof r.ciphertext !== 'string' || r.ciphertext.length < 40 ||
        r.ciphertext.length > MAX_CONNECTION_CIPHERTEXT_LENGTH || !/^[A-Za-z0-9_-]{1,32}$/.test(r.keyId))) {
    throw new PublicError('INVALID_INPUT', 'Invalid prepared migration batch.');
  }
  const now = Date.now();
  const tuples = rows.map(() => '(?,?,?,?,?,?)').join(',');
  const sql = 'WITH candidates(id,dialect,ciphertext,key_id,created_at,updated_at) AS ' +
    '(VALUES ' + tuples + ') ' +
    'INSERT INTO database_connections(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at) ' +
    "SELECT id,dialect,'direct','disabled',ciphertext,key_id,1,created_at,updated_at FROM candidates " +
    'WHERE (SELECT COUNT(*) FROM database_connections) <= ? ' +
    'AND NOT EXISTS(SELECT 1 FROM retired_connection_ids r JOIN candidates c ON r.id=c.id)';
  const args = rows.flatMap(r => [r.id, r.dialect, r.ciphertext, r.keyId, now, now]);
  try {
    const result = await db.prepare(sql).bind(...args, 10 - rows.length).run();
    if (result.meta.changes !== rows.length) {
      throw new PublicError('REVISION_CONFLICT', 'The cutover inventory or capacity changed.');
    }
    return { inserted: rows.length };
  } catch {
    // Never expose a D1 driver error; it can contain SQL parameter values.
    throw new PublicError('REVISION_CONFLICT', 'The migration batch was not applied.');
  }
}
