import { resolveConnection } from './config.js';
import { PublicError } from './errors.js';
import type { ConnectionConfig, EffectiveAdminConnection, Env } from './types.js';

export function resolveAdminConnection(env: Env, catalog: ConnectionConfig[], id?: string): EffectiveAdminConnection {
  const connection = resolveConnection(env, catalog, id);
  if (connection.transport === 'hyperdrive') {
    throw new PublicError('ADMIN_OPERATION_NOT_SUPPORTED', 'Structured DDL is not supported over Hyperdrive.');
  }
  return connection;
}
