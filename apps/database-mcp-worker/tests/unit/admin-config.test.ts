import { describe, expect, it } from 'vitest';
import { resolveAdminConnection } from '../../src/admin-config.js';
import { parseDatabaseConfig } from '../../src/config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

const env: Env = { RATE_LIMITER: { async limit() { return { success: true }; } } };

describe('offline Direct DDL fixture resolution', () => {
  it('uses only the selected Direct SQL URL principal', () => {
    const catalog = parseDatabaseConfig(JSON.stringify({ main: 'mysql://role:p@host/db' }));
    expect(resolveAdminConnection(env, catalog, 'main').user).toBe('role');
  });

  it('rejects legacy Hyperdrive references before DDL admission', () => {
    expect(() => parseDatabaseConfig(JSON.stringify({
      main: { hyperdrive: 'PG', dialect: 'postgres' }
    }))).toThrow(PublicError);
  });
});
