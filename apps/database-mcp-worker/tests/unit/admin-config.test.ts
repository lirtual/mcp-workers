import { describe, expect, it } from 'vitest';
import { resolveAdminConnection } from '../../src/admin-config.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

const env = (extra: Record<string, unknown> = {}): Env => ({
  RATE_LIMITER: { async limit() { return { success: true }; } },
  PG: { connectionString: 'postgres://role@host/db', host: 'host', user: 'role', password: 'secret', database: 'db', port: 5432 },
  ...extra
});

describe('flat config DDL resolution', () => {
  it('uses the selected direct URL principal for DDL', () => {
    const catalog = parseDatabaseConfig(JSON.stringify({ main: 'mysql://role:p@host/db' }));
    expect(resolveAdminConnection(env(), catalog, 'main').user).toBe('role');
  });

  it('fails closed for Hyperdrive DDL without trying direct credentials', () => {
    const catalog = parseDatabaseConfig(JSON.stringify({ main: { hyperdrive: 'PG', dialect: 'postgres' } }));
    expect(() => resolveAdminConnection(env(), catalog, 'main')).toThrowError(
      expect.objectContaining({ code: 'ADMIN_OPERATION_NOT_SUPPORTED' })
    );
    expect(() => resolveAdminConnection(env({ PG: undefined }), catalog, 'main')).toThrow(PublicError);
  });
});
