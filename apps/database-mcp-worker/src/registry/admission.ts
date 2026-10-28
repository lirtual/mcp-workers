import { getRuntimeLimits, getMaxWriteAffectedRows } from '../config.js';
import { PublicError } from '../errors.js';
import type { EffectiveConnection, EffectiveWriteConnection, Env } from '../types.js';
import { resolveHyperdriveConnection } from '../db/hyperdrive.js';
import { openConnectionConfig } from './crypto.js';
import { validatePublicEndpoint } from './endpoint.js';
import { getRegistryConnection, listRegistryConnections } from './store.js';

function boundDb(env: Env): D1Database {
  if (!env.DB) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The database registry is not configured.');
  return env.DB;
}
export async function catalogMetadata(env: Env) {
  return (await listRegistryConnections(boundDb(env))).map(row => ({
    id: row.id, dialect: row.dialect, transport: row.transport, status: row.status
  }));
}
/** Every admission reads authoritative D1, including after disable commits. */
export async function admitConnection(env: Env, requestedId?: string): Promise<EffectiveConnection> {
  const db = boundDb(env);
  let id = requestedId;
  if (id === undefined) {
    const metadata = await listRegistryConnections(db);
    if (metadata.length === 0) throw new PublicError('CONNECTION_NOT_FOUND', 'No database connections are configured.');
    if (metadata.length !== 1) throw new PublicError('INVALID_INPUT', 'A connection id is required when multiple connections are configured.');
    id = metadata[0]!.id;
  }
  const row = await getRegistryConnection(db, id);
  if (!row) throw new PublicError('CONNECTION_NOT_FOUND', 'The requested logical connection does not exist.');
  if (row.status !== 'active') throw new PublicError('CONNECTION_DISABLED', 'The requested connection is disabled.');
  if (row.transport === 'hyperdrive') return resolveHyperdriveConnection(env, row);
  const payload = await openConnectionConfig(env, row.id, row.dialect, {
    keyId: row.key_id, ciphertext: row.ciphertext
  });
  if (payload.ca) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Legacy TLS/CA Direct records require explicit reconfiguration.');
  const parsed = await validatePublicEndpoint(payload.url, row.id);
  if (row.dialect !== parsed.dialect) throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Connection dialect does not match stored configuration.');
  // Direct mode is an explicit plaintext exception. No CA or implicit TLS option.
  return { config: { id: row.id, transport: 'direct', url: payload.url }, transport: 'direct',
    ...parsed, limits: getRuntimeLimits(env) };
}
export async function admitWriteConnection(env: Env, id?: string): Promise<EffectiveWriteConnection> {
  return { ...await admitConnection(env, id), maxAffectedRows: getMaxWriteAffectedRows(env) };
}
