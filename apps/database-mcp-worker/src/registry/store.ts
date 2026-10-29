import { PublicError } from '../errors.js';
import type { Dialect, DatabaseTransport } from '../types.js';
import { MAX_CONNECTION_CIPHERTEXT_LENGTH } from './crypto.js';

type Db = D1Database;
export type RegistryStatus = 'active' | 'disabled';
export interface RegistryMetadata {
  id: string;
  dialect: Dialect;
  transport: DatabaseTransport;
  status: RegistryStatus;
  revision: number;
  created_at: number;
  updated_at: number;
}
export interface DirectRegistryRow extends RegistryMetadata {
  transport: 'direct';
  ciphertext: string;
  key_id: string;
  config_id: null;
  binding_name: null;
}
export interface HyperdriveRegistryRow extends RegistryMetadata {
  transport: 'hyperdrive';
  ciphertext: null;
  key_id: null;
  config_id: string;
  binding_name: string;
}
export type RegistryRow = DirectRegistryRow | HyperdriveRegistryRow;
export interface NewRegistryConnection {
  id: string;
  dialect: Dialect;
  transport?: DatabaseTransport;
  ciphertext?: string;
  keyId?: string;
  configId?: string;
  bindingName?: string;
}
function invalid(reason: string): never { throw new PublicError('INVALID_INPUT', reason); }
function conflict(): never { throw new PublicError('REVISION_CONFLICT', 'Connection revision or identity is no longer current.'); }
function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('Invalid connection revision.');
}
function assertId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) invalid('Invalid connection id.');
}
function assertEncrypted(ciphertext: unknown, keyId: unknown): void {
  if (typeof ciphertext !== 'string' || ciphertext.length > MAX_CONNECTION_CIPHERTEXT_LENGTH || ciphertext.length === 0 ||
    typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) invalid('Invalid encrypted configuration.');
}
function assertHyperdrive(configId: unknown, bindingName: unknown): void {
  if (typeof configId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(configId) ||
    typeof bindingName !== 'string' || !/^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(bindingName)) {
    invalid('Invalid Hyperdrive configuration reference.');
  }
}
async function dbCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof PublicError) throw error;
    if (error instanceof Error && /hyperdrive reservation conflict/i.test(error.message)) conflict();
    // Driver diagnostics can contain SQL and stored credential material.
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is unavailable.');
  }
}
export async function listRegistryConnections(db: Db): Promise<RegistryMetadata[]> {
  if (!db) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is unavailable.');
  return dbCall(async () => {
    const { results } = await db.prepare('SELECT id,dialect,transport,status,revision,created_at,updated_at FROM database_connections ORDER BY id LIMIT 11').all<RegistryMetadata>();
    if (results.length > 10 || results.some(row => !['direct','hyperdrive'].includes(row.transport))) {
      throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is invalid.');
    }
    return results;
  });
}
export async function getRegistryConnection(db: Db, id: string): Promise<RegistryRow | null> {
  assertId(id);
  if (!db) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is unavailable.');
  return dbCall(async () => {
    const row = await db.prepare('SELECT id,dialect,transport,status,revision,created_at,updated_at,ciphertext,key_id,config_id,binding_name FROM database_connections WHERE id=?')
      .bind(id).first<RegistryRow>();
    if (row && (row.transport === 'direct'
      ? typeof row.ciphertext !== 'string' || typeof row.key_id !== 'string' || row.config_id !== null || row.binding_name !== null
      : row.transport === 'hyperdrive'
        ? typeof row.config_id !== 'string' || typeof row.binding_name !== 'string' || row.ciphertext !== null || row.key_id !== null
        : true)) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is invalid.');
    return row;
  });
}
export async function createRegistryConnection(db: Db, data: NewRegistryConnection): Promise<void> {
  assertId(data.id);
  if (data.dialect !== 'mysql' && data.dialect !== 'postgres') invalid('Invalid connection dialect.');
  const transport = data.transport ?? 'direct';
  if (transport === 'direct') {
    assertEncrypted(data.ciphertext, data.keyId);
    if (data.configId !== undefined || data.bindingName !== undefined) invalid('Unexpected Direct configuration reference.');
  } else if (transport === 'hyperdrive') {
    assertHyperdrive(data.configId, data.bindingName);
    if (data.ciphertext !== undefined || data.keyId !== undefined) invalid('Hyperdrive secrets must not be stored in D1.');
  } else invalid('Invalid database transport.');
  const now = Date.now();
  try {
    const result = await db.prepare(`INSERT INTO database_connections
      (id,dialect,transport,status,ciphertext,key_id,config_id,binding_name,revision,created_at,updated_at)
      SELECT ?,?,?,'disabled',?,?,?,?,1,?,?
      WHERE (SELECT COUNT(*) FROM database_connections) +
        (SELECT COUNT(*) FROM hyperdrive_operations WHERE action='create'
           AND phase IN ('pending','running','awaiting_confirmation','unknown')) < 10
        AND NOT EXISTS (SELECT 1 FROM retired_connection_ids WHERE id=?)
        AND NOT EXISTS (SELECT 1 FROM hyperdrive_operations WHERE logical_id=?
           AND phase IN ('pending','running','awaiting_confirmation','unknown'))`)
      .bind(data.id, data.dialect, transport,
        transport === 'direct' ? data.ciphertext : null, transport === 'direct' ? data.keyId : null,
        transport === 'hyperdrive' ? data.configId : null, transport === 'hyperdrive' ? data.bindingName : null,
        now, now, data.id, data.id).run();
    if (result.meta.changes !== 1) {
      const retired = await db.prepare('SELECT id FROM retired_connection_ids WHERE id=?').bind(data.id).first();
      if (retired) conflict();
      throw new PublicError('RATE_LIMITED', 'The maximum of 10 connections is configured.');
    }
  } catch (error) {
    if (error instanceof PublicError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|hyperdrive reservation conflict/i.test(error.message)) conflict();
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is unavailable.');
  }
}
export async function updateRegistryConnection(db: Db, id: string, revision: number, data: { dialect: Dialect; ciphertext: string; keyId: string }): Promise<void> {
  assertId(id); assertRevision(revision); assertEncrypted(data.ciphertext, data.keyId);
  const current = await getRegistryConnection(db, id);
  if (!current) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
  if (current.dialect !== data.dialect || current.transport !== 'direct') invalid('Connection dialect and transport are immutable.');
  await dbCall(async () => {
    const result = await db.prepare(`UPDATE database_connections SET ciphertext=?,key_id=?,revision=revision+1,updated_at=?
      WHERE id=? AND transport='direct' AND dialect=? AND revision=? AND ciphertext=? AND key_id=?`)
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
    // A schema-level AFTER DELETE trigger atomically retires the immutable ID.
    const result = await db.prepare("DELETE FROM database_connections WHERE id=? AND revision=? AND status='disabled'").bind(id, revision).run();
    if (result.meta.changes !== 1) {
      const current = await getRegistryConnection(db, id);
      if (!current) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
      if (current.revision !== revision) conflict();
      invalid('Disable the connection before deletion.');
    }
  });
}
