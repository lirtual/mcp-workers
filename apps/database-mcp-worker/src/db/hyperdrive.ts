import manifest from '../../hyperdrive-bindings.json';
import { PublicError } from '../errors.js';
import type { Env, Dialect, EffectiveConnection, HyperdriveBinding } from '../types.js';
import { getRuntimeLimits } from '../config.js';

interface BindingManifestEntry { binding: string; id: string; dialect: Dialect; origin_database: string }
// Versioned nonsecret source, checked against Wrangler and live Cloudflare by protected Actions.
// This file is deliberately empty until a separately reviewed Binding release.
const entries = manifest as BindingManifestEntry[];

export function isHyperdriveBound(bindingName: string): boolean {
  return entries.some(item => item.binding === bindingName);
}
export function resolveHyperdriveConnection(env: Env, id:string, bindingName:string): EffectiveConnection {
  const declared=entries.find(item=>item.binding===bindingName);
  if (!declared || entries.filter(item=>item.id===declared.id || item.binding===bindingName).length!==1 ||
      !['mysql','postgres'].includes(declared.dialect)) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE','The required Hyperdrive release binding is not available.');
  }
  const parsed=hyperdriveProxyFields(env[bindingName]);
  const origin=declared.dialect==='mysql'?mysqlHyperdriveSchema(parsed.database,declared.origin_database):{};
  return {config:{id,transport:'hyperdrive',configId:declared.id,bindingName},
    transport:'hyperdrive',dialect:declared.dialect,...parsed,...origin,limits:getRuntimeLimits(env)};
}

/** A reviewed origin schema, separate from Cloudflare's opaque proxy DB. */
export function mysqlHyperdriveSchema(proxyDatabase: string, originDatabase: unknown):
  Pick<EffectiveConnection, 'database' | 'proxyDatabase'> {
  if (typeof proxyDatabase !== 'string' || proxyDatabase.length === 0 ||
      typeof originDatabase !== 'string' ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,63}$/.test(originDatabase)) {
    throw new PublicError('CONFIGURATION_UNAVAILABLE', 'MySQL Hyperdrive origin schema is not approved.');
  }
  return { database: originDatabase, proxyDatabase };
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
