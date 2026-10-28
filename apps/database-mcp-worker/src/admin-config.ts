// Offline integration fixture only. Live D1 admission uses registry/admission.ts.
import { resolveConnection } from './config.js';
import type { ConnectionConfig, EffectiveAdminConnection, Env } from './types.js';

export function resolveAdminConnection(env: Env, catalog: ConnectionConfig[], id?: string): EffectiveAdminConnection {
  return resolveConnection(env, catalog, id);
}
