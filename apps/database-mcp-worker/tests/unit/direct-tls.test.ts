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
  it('dials the prevalidated Direct IP, never re-resolves the logical hostname', async () => {
    mysqlConnect.mockResolvedValueOnce({ query: async () => [[], []], end: async () => undefined });
    await mysqlHealthCheck({ ...direct('mysql'), dialHost: '93.184.216.34' });
    expect(mysqlConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '93.184.216.34' }));
    expect(mysqlConnect.mock.lastCall?.[0]).not.toHaveProperty('ssl');
    await postgresHealthCheck({ ...direct('postgres'), dialHost: '2606:4700::1111' });
    expect(postgresConstruct).toHaveBeenCalledWith(expect.objectContaining({ host: '2606:4700::1111' }));
  });
  it('never replaces the Hyperdrive proxy hostname with a Direct pinned address', async () => {
    mysqlConnect.mockResolvedValueOnce({
      beginTransaction: async () => undefined,
      query: async (sql: string) => sql.startsWith('SHOW SESSION VARIABLES')
        ? [[['sql_mode', 'STRICT_TRANS_TABLES']], []] : [[['1']], []],
      rollback: async () => undefined,
      end: async () => undefined
    });
    await mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive', dialHost: '93.184.216.34' });
    expect(mysqlConnect).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example.com' }));
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
        return sql.startsWith('SHOW SESSION VARIABLES') ? [[['sql_mode','STRICT_TRANS_TABLES']], []] : [[['1']], []];
      },
      rollback: async () => { calls.push('rollback'); },
      end: async () => { calls.push('end'); }
    });
    await mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive' });
    expect(calls).toEqual(['begin', "SHOW SESSION VARIABLES LIKE 'sql_mode'", 'SELECT /*+ MAX_EXECUTION_TIME(2000) */ 1', 'rollback', 'end']);
  });
  it('validates the named sql_mode field in mysql2 object rows', async () => {
    const seen: string[] = [];
    mysqlConnect.mockResolvedValueOnce({
      beginTransaction: async () => { seen.push('begin'); },
      query: async (sql: string) => {
        seen.push(sql);
        return sql.startsWith('SHOW SESSION VARIABLES')
          ? [[{ Variable_name: 'sql_mode', Value: 'STRICT_TRANS_TABLES' }], []]
          : [[{ probe: 1 }], []];
      },
      rollback: async () => { seen.push('rollback'); },
      end: async () => undefined
    });
    await mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive' });
    expect(seen).toEqual(['begin', "SHOW SESSION VARIABLES LIKE 'sql_mode'",
      'SELECT /*+ MAX_EXECUTION_TIME(2000) */ 1', 'rollback']);
  });
  it('rejects NO_BACKSLASH_ESCAPES within the execution transaction', async () => {
    const calls: string[] = [];
    mysqlConnect.mockResolvedValueOnce({
      beginTransaction: async () => { calls.push('begin'); },
      query: async () => [[['sql_mode','STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES']], []],
      rollback: async () => { calls.push('rollback'); },
      end: async () => undefined
    });
    await expect(mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(calls).toEqual(['begin','rollback']);
  });
  it('supports mysql2 object-row metadata without trusting an arbitrary row', async () => {
    const sqlMode = async (row: unknown) => {
      mysqlConnect.mockResolvedValueOnce({
        beginTransaction: async () => undefined,
        query: async () => [[row], []],
        rollback: async () => undefined,
        end: async () => undefined
      });
      return mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive' });
    };
    // The first query is the mode check; subsequent health read uses the same mock.
    await expect(sqlMode({Variable_name:'not_sql_mode',Value:'STRICT_TRANS_TABLES'}))
      .rejects.toMatchObject({code:'CONFIGURATION_UNAVAILABLE'});
    await expect(sqlMode({Variable_name:'sql_mode',Value:'NO_BACKSLASH_ESCAPES'}))
      .rejects.toMatchObject({code:'CONFIGURATION_UNAVAILABLE'});
    await expect(sqlMode({Variable_name:'sql_mode',Value:null}))
      .rejects.toMatchObject({code:'CONFIGURATION_UNAVAILABLE'});
  });
  it('fails closed when Hyperdrive returns an empty SQL-mode result set', async () => {
    const calls: string[] = [];
    mysqlConnect.mockResolvedValueOnce({
      beginTransaction: async () => { calls.push('begin'); },
      query: async () => [[], []],
      rollback: async () => { calls.push('rollback'); },
      end: async () => { calls.push('end'); }
    });
    await expect(mysqlHealthCheck({ ...direct('mysql'), transport: 'hyperdrive' }))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(calls).toEqual(['begin','rollback','end']);
  });
  it('rejects objects and custom SQL interpolation hooks', () => {
    expect(mysqlSafeParams(['ok', 1.5, null, false])).toEqual(['ok',1.5,null,false]);
    expect(() => mysqlSafeParams([{ toSqlString: () => '1 OR 1=1' }]))
      .toThrowError(/primitive/);
    expect(() => mysqlSafeParams([Infinity])).toThrowError(/primitive/);
  });
});
