import { describe, expect, it } from 'vitest';
import { getRuntimeLimits, parseConnectionCatalog, resolveConnection } from '../../src/config.js';
import { PublicError } from '../../src/errors.js';
import type { Env } from '../../src/types.js';

function env(): Env {
  return {
    CONNECTIONS_JSON: '[]',
    OAUTH_ISSUER: 'https://auth.example',
    OAUTH_AUDIENCE: 'db',
    OAUTH_JWKS_URL: 'https://auth.example/jwks',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    PG_READ: {
      connectionString: 'postgres://x', host: 'h', user: 'u', password: 'p', database: 'd', port: 5432
    }
  };
}

describe('connection catalog', () => {
  it('parses valid static configuration', () => {
    const catalog = parseConnectionCatalog(JSON.stringify([
      { id: 'prod_pg', displayName: 'Prod', dialect: 'postgres', binding: 'PG_READ', enabled: true }
    ]));
    expect(catalog[0]?.id).toBe('prod_pg');
  });

  it('rejects duplicate ids and invalid binding names', () => {
    expect(() => parseConnectionCatalog(JSON.stringify([
      { id: 'db', displayName: 'A', dialect: 'postgres', binding: 'PG_READ' },
      { id: 'db', displayName: 'B', dialect: 'mysql', binding: 'MYSQL_READ' }
    ]))).toThrow(PublicError);
    expect(() => parseConnectionCatalog(JSON.stringify([
      { id: 'db', displayName: 'A', dialect: 'postgres', binding: 'bad-name' }
    ]))).toThrow(PublicError);
  });

  it('clamps per-connection limits to deployment maxima', () => {
    const target = env();
    target.MAX_ROWS = '100';
    const catalog = parseConnectionCatalog(JSON.stringify([
      { id: 'db', displayName: 'A', dialect: 'postgres', binding: 'PG_READ', maxRows: 500 }
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
