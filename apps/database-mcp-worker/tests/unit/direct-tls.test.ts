import { describe, expect, it, vi } from 'vitest';
import type { EffectiveConnection } from '../../src/types.js';

const { mysqlConnect, postgresConstruct } = vi.hoisted(() => ({
  mysqlConnect: vi.fn(), postgresConstruct: vi.fn()
}));
vi.mock('mysql2/promise', () => ({ createConnection: mysqlConnect }));
vi.mock('pg', () => ({ Client: class {
  constructor(options: unknown) { postgresConstruct(options); }
  async connect() { /* fixture */ }
  async query() { return { rows: [], fields: [] }; }
  async end() { /* fixture */ }
} }));

import { mysqlHealthCheck } from '../../src/db/mysql.js';
import { postgresHealthCheck } from '../../src/db/postgres.js';

const direct = (dialect: 'mysql' | 'postgres'): EffectiveConnection => ({
  config: { id: 'tls_test', transport: 'direct', url: `${dialect}://reader:secret@db.example.com/app` },
  transport: 'direct', dialect,
  connectionString: `${dialect}://reader:secret@db.example.com/app?sslmode=disable`,
  host: 'db.example.com', user: 'reader', password: 'secret', database: 'app',
  port: dialect === 'mysql' ? 3306 : 5432,
  limits: { maxRows: 5, maxResultBytes: 1024, maxSchemaBytes: 1024, queryTimeoutMs: 1000 }
});

describe('Direct transport TLS invariant', () => {
  it('passes verified TLS and hostname verification to mysql2', async () => {
    mysqlConnect.mockResolvedValueOnce({ query: async () => [[], []], end: async () => undefined });
    await mysqlHealthCheck({ ...direct('mysql'), ca: 'TEST_AIVEN_PROJECT_CA' });
    expect(mysqlConnect).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.example.com', ssl: expect.objectContaining({ rejectUnauthorized: true, verifyIdentity: true, ca: 'TEST_AIVEN_PROJECT_CA' })
    }));
  });
  it('rejects MySQL IP literals because mysql2 otherwise skips peer identity checking', async () => {
    await expect(mysqlHealthCheck({ ...direct('mysql'), host: '8.8.8.8' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('rejects every non-Direct transport before either driver can open a socket', async () => {
    mysqlConnect.mockClear();
    postgresConstruct.mockClear();
    // Simulate a malformed runtime object at the driver boundary despite the
    // compile-time Direct-only type; no SQL socket may be opened.
    const forbidden = 'hyperdrive' as unknown as EffectiveConnection['transport'];
    await expect(mysqlHealthCheck({ ...direct('mysql'), transport: forbidden }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    await expect(postgresHealthCheck({ ...direct('postgres'), transport: forbidden }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(mysqlConnect).not.toHaveBeenCalled();
    expect(postgresConstruct).not.toHaveBeenCalled();
  });
  it('does not let a PostgreSQL connection string override verified TLS', async () => {
    await postgresHealthCheck({ ...direct('postgres'), ca: 'TEST_AIVEN_PROJECT_CA' });
    expect(postgresConstruct).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.example.com', ssl: expect.objectContaining({ rejectUnauthorized: true, ca: 'TEST_AIVEN_PROJECT_CA' })
    }));
    expect(postgresConstruct.mock.lastCall?.[0]).not.toHaveProperty('connectionString');
  });
});
