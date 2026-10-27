import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';

type Db = D1Database;
export type RegistryStatus = 'active' | 'disabled';
export interface RegistryMetadata {
  id: string;
  dialect: Dialect;
  status: RegistryStatus;
  revision: number;
  created_at: number;
  updated_at: number;
}
export interface EncryptedRegistryRow extends RegistryMetadata {
  ciphertext: string;
  key_id: string;
}
export interface NewRegistryConnection {
  id: string;
  dialect: Dialect;
  ciphertext: string;
  keyId: string;
}
function invalid(reason: string): never { throw new PublicError('INVALID_INPUT', reason); }
function conflict(): never { throw new PublicError('REVISION_CONFLICT', 'Connection revision is no longer current.'); }
function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('Invalid connection revision.');
}
function assertId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) invalid('Invalid connection id.');
}
function assertEncrypted(ciphertext: string, keyId: string): void {
  if (typeof ciphertext !== 'string' || ciphertext.length > 32768 || ciphertext.length === 0 ||
    typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) invalid('Invalid encrypted configuration.');
}
async function dbCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof PublicError) throw error;
    // D1 errors can include SQL values or driver diagnostics. Never pass them to clients/logs.
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is unavailable.');
  }
}
export async function listRegistryConnections(db: Db): Promise<RegistryMetadata[]> {
  if (!db) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is unavailable.');
  return dbCall(async () => {
    const { results } = await db.prepare('SELECT id,dialect,status,revision,created_at,updated_at FROM database_connections ORDER BY id LIMIT 51').all<RegistryMetadata>();
    if (results.length > 50) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is invalid.');
    return results;
  });
}
export async function getRegistryConnection(db: Db, id: string): Promise<EncryptedRegistryRow | null> {
  assertId(id);
  if (!db) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is unavailable.');
  return dbCall(() => db.prepare('SELECT id,dialect,status,revision,created_at,updated_at,ciphertext,key_id FROM database_connections WHERE id=?').bind(id).first<EncryptedRegistryRow>());
}
export async function createRegistryConnection(db: Db, data: NewRegistryConnection): Promise<void> {
  assertId(data.id); assertEncrypted(data.ciphertext, data.keyId);
  if (data.dialect !== 'mysql' && data.dialect !== 'postgres') invalid('Invalid connection dialect.');
  const now = Date.now();
  await dbCall(async () => {
    const result = await db.prepare(`INSERT INTO database_connections(id,dialect,status,ciphertext,key_id,revision,created_at,updated_at)
      SELECT ?,?,'disabled',?,?,1,?,? WHERE (SELECT COUNT(*) FROM database_connections) < 50`)
      .bind(data.id, data.dialect, data.ciphertext, data.keyId, now, now).run();
    if (result.meta.changes !== 1) throw new PublicError('RATE_LIMITED', 'The maximum of 50 connections is configured.');
  });
}
export async function updateRegistryConnection(db: Db, id: string, revision: number, data: { dialect: Dialect; ciphertext: string; keyId: string }): Promise<void> {
  assertId(id); assertRevision(revision); assertEncrypted(data.ciphertext, data.keyId);
  const current = await getRegistryConnection(db, id);
  if (!current) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
  if (current.dialect !== data.dialect) invalid('Connection dialect is immutable.');
  await dbCall(async () => {
    const result = await db.prepare(`UPDATE database_connections SET ciphertext=?,key_id=?,revision=revision+1,updated_at=?
      WHERE id=? AND dialect=? AND revision=? AND ciphertext=? AND key_id=?`)
      .bind(data.ciphertext, data.keyId, Date.now(), id, data.dialect, revision, current.ciphertext, current.key_id).run();
    if (result.meta.changes !== 1) conflict();
  });
}
export async function setRegistryConnectionStatus(db: Db, id: string, revision: number, status: RegistryStatus): Promise<void> {
  assertId(id); assertRevision(revision);
  if (status !== 'active' && status !== 'disabled') invalid('Invalid connection status.');
  await dbCall(async () => {
    const result = await db.prepare(`UPDATE database_connections SET status=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=?`).bind(status, Date.now(), id, revision).run();
    if (result.meta.changes !== 1) conflict();
  });
}
export async function deleteRegistryConnection(db: Db, id: string, revision: number, confirmation: string): Promise<void> {
  assertId(id); assertRevision(revision);
  if (id !== confirmation) invalid('Connection deletion requires the exact connection id confirmation.');
  await dbCall(async () => {
    const result = await db.prepare("DELETE FROM database_connections WHERE id=? AND revision=? AND status='disabled'").bind(id, revision).run();
    if (result.meta.changes !== 1) {
      const current = await getRegistryConnection(db, id);
      if (!current) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
      if (current.revision !== revision) conflict();
      invalid('Disable the connection before deletion.');
    }
  });
}
