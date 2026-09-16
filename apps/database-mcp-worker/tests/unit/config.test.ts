import { describe, expect, it } from 'vitest';
import {
  getMaxWriteAffectedRows,
  getRuntimeLimits,
  parseConnectionCatalog,
  parseDirectDatabaseUrl,
  resolveConnection,
  resolveConnectionDialect,
  resolveWriteConnection
} from '../../src/config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

function env(): Env {
  return {
    CONNECTIONS_JSON: '[]',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    LEGACY_MYSQL_DATABASE_URL: 'mysql://reader:secret@db.example.com:3306/app',
    LEGACY_MYSQL_WRITE_URL: 'mysql://writer:secret@db.example.com:3306/app',
    PG_WRITE_URL: 'postgres://writer:secret@db.example.com:5432/app',
    PG_READ: {
      connectionString: 'postgres://reader@h/d', host: 'h', user: 'reader', password: 'p', database: 'd', port: 5432
    },
    PG_WRITE: {
      connectionString: 'postgres://writer@h/d', host: 'h', user: 'writer', password: 'p', database: 'd', port: 5432
    }
  };
}

describe('connection catalog', () => {
  it('parses explicit Hyperdrive and direct read transports', () => {
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

  it('parses optional direct and Hyperdrive write transports', () => {
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'legacy_mysql',
        displayName: 'Legacy',
        transport: 'direct',
        urlSecret: 'LEGACY_MYSQL_DATABASE_URL',
        write: { transport: 'direct', urlSecret: 'LEGACY_MYSQL_WRITE_URL', maxAffectedRows: 7 }
      },
      {
        id: 'prod_pg',
        displayName: 'Prod',
        transport: 'hyperdrive',
        dialect: 'postgres',
        binding: 'PG_READ',
        write: { transport: 'hyperdrive', binding: 'PG_WRITE' }
      }
    ]));

    expect(catalog[0]?.write).toEqual({
      transport: 'direct',
      urlSecret: 'LEGACY_MYSQL_WRITE_URL',
      maxAffectedRows: 7
    });
    expect(catalog[1]?.write).toEqual({ transport: 'hyperdrive', binding: 'PG_WRITE' });
  });

  it('rejects missing transport, duplicate ids, and conflicting read transport fields', () => {
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

  it('rejects conflicting or split write configuration', () => {
    expect(() => parseConnectionCatalog(JSON.stringify([
      {
        id: 'db', displayName: 'A', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ',
        write: { transport: 'direct', urlSecret: 'WRITE_URL', binding: 'PG_WRITE' }
      }
    ]))).toThrow(PublicError);

    expect(() => parseConnectionCatalog(JSON.stringify([
      {
        id: 'db', displayName: 'A', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ',
        write: { transport: 'hyperdrive', binding: 'PG_WRITE', urlSecret: 'WRITE_URL' }
      }
    ]))).toThrow(PublicError);

    expect(() => parseConnectionCatalog(JSON.stringify([
      {
        id: 'db', displayName: 'A', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ',
        write: { transport: 'direct', urlSecret: 'WRITE_URL', dialect: 'postgres' }
      }
    ]))).toThrow(PublicError);

    expect(() => parseConnectionCatalog(JSON.stringify([
      {
        id: 'db', displayName: 'A', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ',
        write: { transport: 'direct', urlSecret: 'WRITE_URL', host: 'db.example.com' }
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
    expect(() => resolveConnection(target, catalog, 'legacy_mysql')).toThrow(PublicError);
    try {
      resolveConnection(target, catalog, 'legacy_mysql');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
    }
  });

  it('resolves both read transport types without fallback', () => {
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
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
    }
  });

  it('keeps writes opt-in and never falls back to read credentials', () => {
    const target = env();
    const readOnly = parseConnectionCatalog(JSON.stringify([
      { id: 'db', displayName: 'DB', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ' }
    ]));
    try {
      resolveWriteConnection(target, readOnly, 'db');
    } catch (error) {
      expect(error).toMatchObject({ code: 'WRITE_NOT_CONFIGURED' });
    }

    const writable = parseConnectionCatalog(JSON.stringify([
      {
        id: 'db', displayName: 'DB', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ',
        write: { transport: 'hyperdrive', binding: 'PG_WRITE' }
      }
    ]));
    delete target.PG_WRITE;
    try {
      resolveWriteConnection(target, writable, 'db');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONNECTION_UNAVAILABLE' });
    }
  });

  it('resolves direct and Hyperdrive writers independently from readers', () => {
    const target = env();
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'legacy_mysql', displayName: 'Legacy', transport: 'direct', urlSecret: 'LEGACY_MYSQL_DATABASE_URL',
        write: { transport: 'direct', urlSecret: 'LEGACY_MYSQL_WRITE_URL', maxAffectedRows: 8 }
      },
      {
        id: 'prod_pg', displayName: 'Prod', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ',
        write: { transport: 'hyperdrive', binding: 'PG_WRITE' }
      }
    ]));

    expect(resolveWriteConnection(target, catalog, 'legacy_mysql')).toMatchObject({
      transport: 'direct', dialect: 'mysql', user: 'writer', maxAffectedRows: 8
    });
    expect(resolveWriteConnection(target, catalog, 'prod_pg')).toMatchObject({
      transport: 'hyperdrive', dialect: 'postgres', user: 'writer', maxAffectedRows: 20
    });
  });

  it('rejects a direct writer whose URL dialect differs from the logical connection', () => {
    const target = env();
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'prod_pg', displayName: 'Prod', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ',
        write: { transport: 'direct', urlSecret: 'LEGACY_MYSQL_WRITE_URL' }
      }
    ]));
    try {
      resolveWriteConnection(target, catalog, 'prod_pg');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('clamps read and write limits to deployment maxima', () => {
    const target = env();
    target.MAX_ROWS = '100';
    target.MAX_WRITE_AFFECTED_ROWS = '5';
    const catalog = parseConnectionCatalog(JSON.stringify([
      {
        id: 'db', displayName: 'A', transport: 'hyperdrive', dialect: 'postgres', binding: 'PG_READ', maxRows: 500,
        write: { transport: 'hyperdrive', binding: 'PG_WRITE', maxAffectedRows: 80 }
      }
    ]));
    expect(resolveConnection(target, catalog, 'db').limits.maxRows).toBe(100);
    expect(resolveWriteConnection(target, catalog, 'db').maxAffectedRows).toBe(5);
  });

  it('uses safe read and write defaults', () => {
    expect(getRuntimeLimits(env())).toEqual({
      maxRows: 500,
      maxResultBytes: 1_048_576,
      maxSchemaBytes: 524_288,
      queryTimeoutMs: 15_000
    });
    expect(getMaxWriteAffectedRows(env())).toBe(20);
  });
});
