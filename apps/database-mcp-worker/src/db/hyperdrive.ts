import manifest from '../../hyperdrive-bindings.json';
import { PublicError } from '../errors.js';
import type { Env, Dialect, EffectiveConnection, HyperdriveBinding } from '../types.js';
import type { HyperdriveRegistryRow } from '../registry/store.js';
import { getRuntimeLimits } from '../config.js';

interface BindingManifestEntry { binding: string; id: string; dialect: Dialect }
// Versioned nonsecret source, checked against Wrangler and live Cloudflare by protected Actions.
// This file is deliberately empty until a separately reviewed Binding release.
const entries = manifest as BindingManifestEntry[];

export function isHyperdriveBound(bindingName: string): boolean {
  return entries.some(item => item.binding === bindingName);
}
export function resolveHyperdriveConnection(env: Env, row: HyperdriveRegistryRow): EffectiveConnection {
  const declared = entries.find(item => item.binding === row.binding_name);
  if (!declared || declared.id !== row.config_id ||
      entries.filter(item => item.id === row.config_id || item.binding === row.binding_name).length !== 1) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The required Hyperdrive release binding is not available.');
  }
  if (declared.dialect !== row.dialect) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'Hyperdrive dialect differs from approved release metadata.');
  }
  const parsed = hyperdriveProxyFields(env[row.binding_name]);
  // Proxy credentials are scoped to this Worker instance. Never reparse a URL
  // (or forward URL TLS overrides) when Cloudflare exposes exact driver fields.
  return {
    config: { id: row.id, transport: 'hyperdrive', configId: row.config_id, bindingName: row.binding_name },
    transport: 'hyperdrive', dialect: row.dialect, ...parsed, limits: getRuntimeLimits(env)
  };
}

/** Canonical Worker→Hyperdrive fields; TLS is verified from Hyperdrive to origin. */
export function hyperdriveProxyFields(candidate: unknown): Pick<EffectiveConnection,
  'connectionString' | 'host' | 'port' | 'user' | 'password' | 'database'> {
  if (!candidate || typeof candidate !== 'object') {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The Hyperdrive binding is unavailable.');
  }
  const b = candidate as Partial<HyperdriveBinding>;
  if (typeof b.connectionString !== 'string' || b.connectionString.length === 0 ||
      typeof b.host !== 'string' || b.host.length === 0 || b.host.length > 253 ||
      typeof b.user !== 'string' || b.user.length === 0 || b.user.length > 2048 ||
      typeof b.password !== 'string' || b.password.length === 0 || b.password.length > 4096 ||
      typeof b.database !== 'string' || b.database.length === 0 || b.database.length > 2048 ||
      !Number.isSafeInteger(b.port) || b.port! < 1 || b.port! > 65535) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'The Hyperdrive binding is incomplete.');
  }
  return {
    connectionString: b.connectionString,
    host: b.host, port: b.port!, user: b.user,
    password: b.password, database: b.database
  };
}
