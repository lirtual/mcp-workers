import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../helpers/catalog.js';
import { resolveConnection, resolveConnectionDialect, resolveWriteConnection } from '../../src/config.js';
import { resolveAdminConnection } from '../../src/admin-config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

const baseEnv = (extra: Record<string, unknown> = {}): Env => ({
  RATE_LIMITER: { async limit() { return { success: true }; } },
  ...extra
});

describe('isolated catalog fixtures', () => {
  it('maps connection ids directly to URLs and uses one principal for read, write, and direct DDL', () => {
    const catalog = parseDatabaseConfig(JSON.stringify({ primary: 'mysql://role:secret@db.example.com/app' }));
    const read = resolveConnection(baseEnv(), catalog);
    expect(read).toMatchObject({ dialect: 'mysql', user: 'role', database: 'app' });
    expect(resolveWriteConnection(baseEnv(), catalog).user).toBe(read.user);
    expect(resolveAdminConnection(baseEnv(), catalog).user).toBe(read.user);
    expect(resolveConnectionDialect(baseEnv(), catalog[0]!)).toBe('mysql');
  });

  it('requires an explicit id for multiple connections and rejects unknown ids', () => {
    const catalog = parseDatabaseConfig(JSON.stringify({ one: 'mysql://u:p@h/db', two: 'postgres://u:p@h/db' }));
    expect(() => resolveConnection(baseEnv(), catalog)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(resolveConnection(baseEnv(), catalog, 'two').dialect).toBe('postgres');
    expect(() => resolveConnection(baseEnv(), catalog, 'missing')).toThrowError(expect.objectContaining({ code: 'CONNECTION_NOT_FOUND' }));
  });

  it('refuses legacy Hyperdrive bindings even when a matching binding is present', () => {
    expect(() => parseDatabaseConfig(JSON.stringify({
      analytics: { hyperdrive: 'PG', dialect: 'postgres' }
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('rejects legacy nested formats, speculative fields, malformed ids, and invalid URLs', () => {
    for (const config of [
      { primary: { connection: 'mysql://u:p@h/db' } },
      { primary: { read: 'mysql://u:p@h/db', write: 'mysql://u:p@h/db' } },
      { primary: { admin: 'mysql://u:p@h/db' } },
      { primary: { hyperdrive: 'PG', dialect: 'postgres', displayName: 'primary' } },
      { primary: { hyperdrive: 'PG', dialect: 'postgres', enabled: false } },
      { primary: { hyperdrive: 'PG', dialect: 'postgres', maxRows: 10 } },
      { 'bad id': 'mysql://u:p@h/db' },
      { primary: 'ftp://u:p@h/db' },
      { primary: 'mysql://u:p@h/db?ssl=true' },
      { primary: 'mysql://u:p@h/db?sslmode=disable' },
      { primary: 'postgres://u:p@h/db?rejectUnauthorized=false' }
    ]) expect(() => parseDatabaseConfig(JSON.stringify(config))).toThrow(PublicError);
    expect(() => parseDatabaseConfig('[]')).toThrow(PublicError);
    expect(() => parseDatabaseConfig('{}')).toThrow(PublicError);
  });

  it('preserves global limits and affected-row caps', () => {
    const env = baseEnv({ MAX_ROWS: '25', MAX_WRITE_AFFECTED_ROWS: '3' });
    const catalog = parseDatabaseConfig(JSON.stringify({ primary: 'mysql://u:p@h/db' }));
    expect(resolveConnection(env, catalog).limits.maxRows).toBe(25);
    expect(resolveWriteConnection(env, catalog).maxAffectedRows).toBe(3);
  });
});
