import { describe, expect, it } from 'vitest';
import { parseDatabaseConfigWithAdmin, resolveAdminConnection } from '../../src/admin-config.js';
import { resolveConnection, resolveWriteConnection } from '../../src/config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

function env(extra: Record<string, unknown> = {}): Env {
  return {
    RATE_LIMITER: { async limit() { return { success: true }; } },
    ...extra
  };
}

describe('DATABASE_CONFIG admin extension', () => {
  it('keeps read, write, and admin direct credentials independent', () => {
    const catalog = parseDatabaseConfigWithAdmin(JSON.stringify({
      main: {
        read: 'mysql://reader:r@db.example.com/app',
        write: 'mysql://writer:w@db.example.com/app',
        admin: 'mysql://admin:a@db.example.com/app'
      }
    }));

    expect(resolveConnection(env(), catalog, 'main').user).toBe('reader');
    expect(resolveWriteConnection(env(), catalog, 'main').user).toBe('writer');
    expect(resolveAdminConnection(env(), catalog, 'main').user).toBe('admin');
  });

  it('fails closed when admin is not configured', () => {
    const catalog = parseDatabaseConfigWithAdmin(JSON.stringify({
      main: { read: 'mysql://reader:r@db.example.com/app' }
    }));
    expect(() => resolveAdminConnection(env(), catalog, 'main')).toThrowError(
      expect.objectContaining({ code: 'ADMIN_NOT_CONFIGURED' })
    );
  });

  it('supports an independent Hyperdrive admin binding', () => {
    const target = env({
      PG_READ: {
        connectionString: 'postgres://reader@host/db',
        host: 'host', user: 'reader', password: 'r', database: 'db', port: 5432
      },
      PG_ADMIN: {
        connectionString: 'postgres://admin@host/db',
        host: 'host', user: 'admin', password: 'a', database: 'db', port: 5432
      }
    });
    const catalog = parseDatabaseConfigWithAdmin(JSON.stringify({
      prod: {
        read: { hyperdrive: 'PG_READ', dialect: 'postgres' },
        admin: { hyperdrive: 'PG_ADMIN' }
      }
    }));

    expect(resolveAdminConnection(target, catalog, 'prod')).toMatchObject({
      transport: 'hyperdrive', dialect: 'postgres', user: 'admin'
    });
  });

  it('rejects invalid admin shapes and read/admin dialect mismatches', () => {
    expect(() => parseDatabaseConfigWithAdmin(JSON.stringify({
      main: { read: 'mysql://reader:r@h/app', admin: { url: 'mysql://admin:a@h/app' } }
    }))).toThrow(PublicError);

    const catalog = parseDatabaseConfigWithAdmin(JSON.stringify({
      main: {
        read: 'mysql://reader:r@h/app',
        admin: 'postgres://admin:a@h/app'
      }
    }));
    expect(() => resolveAdminConnection(env(), catalog, 'main')).toThrow(PublicError);
  });
});
