// Isolated unit/integration fixture adapter; not compiled into the production Worker.
import { PublicError } from '../../src/errors.js';
import { parseDirectDatabaseUrl } from '../../src/config.js';
import type { ConnectionConfig } from '../../src/types.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function parseDatabaseConfig(raw: string): ConnectionConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG is not valid JSON.'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG must be a JSON object keyed by connection id.');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 10) {
    throw new PublicError('INVALID_INPUT', 'DATABASE_CONFIG must contain 1 to 10 connections.');
  }
  return entries.map(([id, value]) => {
    if (!ID_RE.test(id)) throw new PublicError('INVALID_INPUT', `Connection id '${id}' is invalid.`);
    if (typeof value === 'string') {
      parseDirectDatabaseUrl(value, id);
      return { id, transport: 'direct' as const, url: value };
    }
    throw new PublicError('INVALID_INPUT', `Connection '${id}' must be a direct SQL URL; legacy Hyperdrive references are unsupported.`);
  });
}
