import { describe, expect, it } from 'vitest';
import {
  parseDatabaseConfig,
  resolveConnection,
  resolveConnectionDialect,
  resolveWriteConnection
} from '../../src/config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

function env(extra: Record<string, unknown> = {}): Env {
  return {
    RATE_LIMITER: { async limit() { return { success: true }; } },
    ...extra
  };
}

describe('DATABASE_CONFIG', () => {
  it('parses the minimal direct read configuration with id-derived display name', () => {
    const catalog = parseDatabaseConfig(JSON.stringify({
      main: {
        read: 'mysql://reader:secret@db.example.com:3306/app'
      }
    }));

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      id: 'main',
      displayName: 'main',
      enabled: true,
      transport: 'direct'
    });
    expect(resolveConnectionDialect(env(), catalog[0]!)).toBe('mysql');
    expect(resolveConnection(env(), catalog, 'main')).toMatchObject({
      dialect: 'mysql',
      user: 'reader',
      database: 'app',
      port: 3306
    });
  });

  it('enables Safe Write only when write is explicitly configured', () => {
    const readOnly = parseDatabaseConfig(JSON.stringify({
      main: { read: 'mysql://reader:secret@db.example.com/app' }
    }));
    expect(() => resolveWriteConnection(env(), readOnly, 'main')).toThrow(PublicError);

    const writable = parseDatabaseConfig(JSON.stringify({
      main: {
        read: 'mysql://reader:secret@db.example.com/app',
        write: 'mysql://writer:secret@db.example.com/app',
        maxAffectedRows: 7
      }
    }));
    expect(resolveWriteConnection(env(), writable, 'main')).toMatchObject({
      dialect: 'mysql',
      user: 'writer',
      maxAffectedRows: 7
    });
  });

  it('supports multiple databases without repeating an id field', () => {
    const catalog = parseDatabaseConfig(JSON.stringify({
      primary: { read: 'mysql://reader:secret@mysql.example.com/app' },
      analytics: {
        displayName: 'Analytics',
        read: 'postgres://reader:secret@pg.example.com/analytics'
      }
    }));

    expect(catalog.map(item => item.id)).toEqual(['primary', 'analytics']);
    expect(catalog[1]?.displayName).toBe('Analytics');
  });

  it('supports Hyperdrive references while keeping the simple direct syntax', () => {
    const target = env({
      PG_READ: {
        connectionString: 'postgres://reader@host/db',
        host: 'host',
        user: 'reader',
        password: 'secret',
        database: 'db',
        port: 5432
      },
      PG_WRITE: {
        connectionString: 'postgres://writer@host/db',
        host: 'host',
        user: 'writer',
        password: 'secret',
        database: 'db',
        port: 5432
      }
    });
    const catalog = parseDatabaseConfig(JSON.stringify({
      prod: {
        read: { hyperdrive: 'PG_READ', dialect: 'postgres' },
        write: { hyperdrive: 'PG_WRITE' }
      }
    }));

    expect(resolveConnection(target, catalog, 'prod')).toMatchObject({ transport: 'hyperdrive', dialect: 'postgres' });
    expect(resolveWriteConnection(target, catalog, 'prod')).toMatchObject({ transport: 'hyperdrive', dialect: 'postgres' });
  });

  it('rejects invalid shapes, unknown fields, TLS direct URLs, and mismatched direct writer dialects', () => {
    expect(() => parseDatabaseConfig('[]')).toThrow(PublicError);
    expect(() => parseDatabaseConfig(JSON.stringify({ main: {} }))).toThrow(PublicError);
    expect(() => parseDatabaseConfig(JSON.stringify({ main: { read: 'mysql://u:p@h/db', nope: true } }))).toThrow(PublicError);
    expect(() => parseDatabaseConfig(JSON.stringify({ main: { read: 'mysql://u:p@h/db?ssl=true' } }))).toThrow(PublicError);

    const mismatched = parseDatabaseConfig(JSON.stringify({
      main: {
        read: 'mysql://reader:secret@db.example.com/app',
        write: 'postgres://writer:secret@db.example.com/app'
      }
    }));
    expect(() => resolveWriteConnection(env(), mismatched, 'main')).toThrow(PublicError);
  });
});
