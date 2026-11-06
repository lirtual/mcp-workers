// Offline integration fixture only. Live configuration admission uses connection-admission.ts.
import { resolveConnection } from './config.js';
import type { ConnectionConfig, EffectiveAdminConnection, Env } from './types.js';

export function resolveAdminConnection(env: Env, catalog: ConnectionConfig[], id?: string): EffectiveAdminConnection {
  return resolveConnection(env, catalog, id);
}
