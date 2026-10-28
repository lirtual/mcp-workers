import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { mysqlSafeParams } from '../../src/db/mysql-mode.js';

const direct = (dialect: 'mysql' | 'postgres'): EffectiveConnection => ({
  config: { id: 'dev', transport: 'direct', url: `${dialect}://reader:secret@db.example.com/app` },
  transport: 'direct', dialect,
  connectionString: `${dialect}://reader:secret@db.example.com/app?sslmode=disable`,
  host: 'db.example.com', user: 'reader', password: 'secret', database: 'app',
  port: dialect === 'mysql' ? 3306 : 5432,
  limits: { maxRows: 5, maxResultBytes: 1024, maxSchemaBytes: 1024, queryTimeoutMs: 1000 }
});
afterEach(() => { mysqlConnect.mockReset(); postgresConstruct.mockClear(); });
describe('transport security semantics', () => {
  it('Direct MySQL is explicitly plaintext and never advertises peer TLS verification', async () => {
    mysqlConnect.mockResolvedValueOnce({ query: async () => [[], []], end: async () => undefined });
    await mysqlHealthCheck(direct('mysql'));
    expect(mysqlConnect).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example.com' }));
    expect(mysqlConnect.mock.lastCall?.[0]).not.toHaveProperty('ssl');
  });
  it('Direct PostgreSQL suppresses URL TLS overrides and makes plaintext explicit', async () => {
    await postgresHealthCheck(direct('postgres'));
    expect(postgresConstruct).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example.com', ssl: false }));
    expect(postgresConstruct.mock.lastCall?.[0]).not.toHaveProperty('connectionString');
  });
  it('Hyperdrive MySQL pins a transaction to verify SQL mode before queries', async () => {
    const calls: string[] = [];
    mysqlConnect.mockResolvedValueOnce({
      beginTransaction: async () => { calls.push('begin'); },
      query: async (sql: string) => {
        calls.push(sql);
        return sql.startsWith('SELECT @@SESSION.sql_mode') ? [[['STRICT_TRANS_TABLES']], []] : [[['1']], []];
      },
      rollback: async () => { calls.push('rollback'); },
      end: async () => { calls.push('end'); }
    });
    await mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive' });
    expect(calls).toEqual(['begin', 'SELECT @@SESSION.sql_mode AS mode', 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ 1', 'rollback', 'end']);
  });
  it('rejects NO_BACKSLASH_ESCAPES within the execution transaction', async () => {
    const calls: string[] = [];
    mysqlConnect.mockResolvedValueOnce({
      beginTransaction: async () => { calls.push('begin'); },
      query: async () => [[['STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES']], []],
      rollback: async () => { calls.push('rollback'); },
      end: async () => undefined
    });
    await expect(mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(calls).toEqual(['begin','rollback']);
  });
  it('rejects objects and custom SQL interpolation hooks', () => {
    expect(mysqlSafeParams(['ok', 1.5, null, false])).toEqual(['ok',1.5,null,false]);
    expect(() => mysqlSafeParams([{ toSqlString: () => '1 OR 1=1' }]))
      .toThrowError(/primitive/);
    expect(() => mysqlSafeParams([Infinity])).toThrowError(/primitive/);
  });
});
