import { describe, expect, it } from 'vitest';
import {
  getRuntimeLimits,
  parseConnectionCatalog,
  parseDirectDatabaseUrl,
  resolveConnection,
  resolveConnectionDialect
} from '../../src/config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

function env(): Env {
  return {
    CONNECTIONS_JSON: '[]',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    LEGACY_MYSQL_DATABASE_URL: 'mysql://reader:secret@db.example.com:3306/app',
    PG_READ: {
      connectionString: 'postgres://x', host: 'h', user: 'u', password: 'p', database: 'd', port: 5432
    }
  };
}

describe('connection catalog', () => {
  it('parses explicit Hyperdrive and direct transports', () => {
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'prod_pg',
        displayName: 'Prod',
        transport: 'hyperdrive',
        dialect: 'postgres',
        binding: 'PG_READ',
        enabled: true
      },
      {
        id: 'legacy_mysql',
        displayName: 'Legacy',
        transport: 'direct',
        urlSecret: 'LEGACY_MYSQL_DATABASE_URL'
      }
    ]));

    expect(catalog[0]).toMatchObject({ id: 'prod_pg', transport: 'hyperdrive' });
    expect(catalog[1]).toMatchObject({
      id: 'legacy_mysql',
      transport: 'direct',
      urlSecret: 'LEGACY_MYSQL_DATABASE_URL'
    });
    expect(resolveConnectionDialect(env(), catalog[1]!)).toBe('mysql');
  });

  it('rejects missing transport, duplicate ids, and conflicting transport fields', () => {
    expect(() => parseConnectionCatalog(JSON.stringify([
      { id: 'db', displayName: 'A', dialect: 'postgres', binding: 'PG_READ' }
    ]))).toThrow(PublicError);

    expect(() => parseConnectionCatalog(JSON.stringify([
      { id: 'db', displayName: 'A', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ' },
      { id: 'db', displayName: 'B', transport: 'direct', urlSecret: 'DATABASE_URL' }
    ]))).toThrow(PublicError);

    expect(() => parseConnectionCatalog(JSON.stringify([
      {
        id: 'db',
        displayName: 'A',
        transport: 'direct',
        urlSecret: 'DATABASE_URL',
        dialect: 'mysql'
      }
    ]))).toThrow(PublicError);

    expect(() => parseConnectionCatalog(JSON.stringify([
      {
        id: 'db',
        displayName: 'A',
        transport: 'hyperdrive',
        dialect: 'postgres',
        binding: 'PG_READ',
        urlSecret: 'DATABASE_URL'
      }
    ]))).toThrow(PublicError);
  });

  it('derives direct dialect from the SQL URL and never needs a duplicate dialect field', () => {
    expect(parseDirectDatabaseUrl('postgres://u:p@db.example.com/app', 'pg').dialect).toBe('postgres');
    expect(parseDirectDatabaseUrl('postgresql://u:p@db.example.com/app', 'pg').dialect).toBe('postgres');
    expect(parseDirectDatabaseUrl('mysql://u:p@db.example.com/app', 'mysql').dialect).toBe('mysql');
  });

  it('rejects unsupported direct schemes and direct URLs that request TLS', () => {
    expect(() => parseDirectDatabaseUrl('mariadb://u:p@db.example.com/app', 'db')).toThrow(PublicError);
    expect(() => parseDirectDatabaseUrl('postgres://u:p@db.example.com/app?sslmode=require', 'db')).toThrow(
      PublicError
    );
    expect(() => parseDirectDatabaseUrl('mysql://u:p@db.example.com/app?ssl=true', 'db')).toThrow(PublicError);

    expect(parseDirectDatabaseUrl('postgres://u:p@db.example.com/app?sslmode=disable', 'db').dialect).toBe(
      'postgres'
    );
    expect(parseDirectDatabaseUrl('mysql://u:p@db.example.com/app?ssl=false', 'db').dialect).toBe('mysql');
  });

  it('fails closed when a configured direct URL Secret is unavailable', () => {
    const target = env();
    delete target.LEGACY_MYSQL_DATABASE_URL;
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'legacy_mysql',
        displayName: 'Legacy',
        transport: 'direct',
        urlSecret: 'LEGACY_MYSQL_DATABASE_URL'
      }
    ]));
    try {
      resolveConnection(target, catalog, 'legacy_mysql');
      throw new Error('expected direct secret resolution to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
    }
  });

  it('resolves both transport types without fallback', () => {
    const target = env();
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'legacy_mysql',
        displayName: 'Legacy',
        transport: 'direct',
        urlSecret: 'LEGACY_MYSQL_DATABASE_URL'
      },
      {
        id: 'prod_pg',
        displayName: 'Prod',
        transport: 'hyperdrive',
        dialect: 'postgres',
        binding: 'PG_READ'
      }
    ]));

    expect(resolveConnection(target, catalog, 'legacy_mysql')).toMatchObject({
      transport: 'direct',
      dialect: 'mysql',
      host: 'db.example.com',
      database: 'app',
      port: 3306
    });
    expect(resolveConnection(target, catalog, 'prod_pg')).toMatchObject({
      transport: 'hyperdrive',
      dialect: 'postgres',
      host: 'h',
      database: 'd',
      port: 5432
    });

    delete target.PG_READ;
    try {
      resolveConnection(target, catalog, 'prod_pg');
      throw new Error('expected Hyperdrive binding resolution to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
    }
  });

  it('clamps per-connection limits to deployment maxima', () => {
    const target = env();
    target.MAX_ROWS = '100';
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'db',
        displayName: 'A',
        transport: 'hyperdrive',
        dialect: 'postgres',
        binding: 'PG_READ',
        maxRows: 500
      }
    ]));
    expect(resolveConnection(target, catalog, 'db').limits.maxRows).toBe(100);
  });

  it('uses safe defaults', () => {
    expect(getRuntimeLimits(env())).toEqual({
      maxRows: 500,
      maxResultBytes: 1_048_576,
      maxSchemaBytes: 524_288,
      queryTimeoutMs: 15_000
    });
  });
});
