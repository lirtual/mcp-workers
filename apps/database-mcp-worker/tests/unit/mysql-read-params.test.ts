import type { Connection } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveConnection } from '../../src/types.js';

const { createConnectionMock } = vi.hoisted(() => ({ createConnectionMock: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createConnection: createConnectionMock }));

import { mysqlExplain, mysqlInspectSchema, mysqlQueryRead } from '../../src/db/mysql.js';
import { ConfirmedReadFailure, ConfirmedNoSqlFailure } from '../../src/db/completion.js';

const base: EffectiveConnection = {
  config: { id: 'example', transport: 'direct', url: 'mysql://reader@db.example.org/app' },
  transport: 'direct', dialect: 'mysql',
  connectionString: 'mysql://reader@db.example.org/app',
  host: 'db.example.org', port: 3306, user: 'reader', password: 'test', database: 'app',
  limits: { maxRows: 10, maxResultBytes: 10000, maxSchemaBytes: 10000, queryTimeoutMs: 5000 }
};

function mockClient(sqlMode = 'STRICT_TRANS_TABLES') {
  const execute = vi.fn().mockRejectedValue(new Error('unsupported COM_STMT_PREPARE'));
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SHOW SESSION VARIABLES')) {
      return [[{ Variable_name: 'sql_mode', Value: sqlMode }], []];
    }
    if (sql.includes('information_schema.columns')) return [[['id', 'int', 'NO', null, 1, '']], []];
    return [[['safe']], []];
  });
  const beginTransaction = vi.fn().mockResolvedValue(undefined);
  const rollback = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn().mockResolvedValue(undefined);
  const destroy = vi.fn();
  createConnectionMock.mockResolvedValue({ execute, query, beginTransaction, rollback, end, destroy } as unknown as Connection);
  return { execute, query, beginTransaction, rollback };
}

describe('MySQL read interpolation safety and Direct compatibility', () => {
  afterEach(() => vi.clearAllMocks());

  it('marks a failed Hyperdrive connection before query creation as no-SQL evidence', async () => {
    createConnectionMock.mockRejectedValueOnce(new Error('handshake refused'));
    await expect(mysqlQueryRead({ ...base, transport: 'hyperdrive' }, 'SELECT 1', [], 2))
      .rejects.toBeInstanceOf(ConfirmedNoSqlFailure);
    createConnectionMock.mockRejectedValueOnce(new Error('handshake refused'));
    await expect(mysqlQueryRead(base, 'SELECT 1', [], 2))
      .rejects.not.toBeInstanceOf(ConfirmedNoSqlFailure);
  });
  it('checks Direct session SQL mode before interpolating SQL-mode-sensitive values, without COM_STMT_PREPARE', async () => {
    const client = mockClient();
    const value = "a'\\\\b";
    await mysqlQueryRead(base, 'SELECT ? AS value', [value], 2);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[0]?.[0]).toContain('SHOW SESSION VARIABLES');
    expect(client.query.mock.calls[1]?.[0]).toContain('SELECT ? AS value');
    expect(client.query.mock.calls[1]?.[1]).toEqual([value]);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('preserves Direct constant SELECT without requiring a mode-dependent interpolation check', async () => {
    const client = mockClient();
    await mysqlQueryRead(base, 'SELECT 1 AS value', [], 2);
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('rejects unsafe Direct session mode before interpolating a value', async () => {
    const client = mockClient('NO_BACKSLASH_ESCAPES');
    await expect(mysqlQueryRead(base, 'SELECT ? AS value', ["'\\x"], 2))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('checks session SQL mode for Direct EXPLAIN parameters', async () => {
    const client = mockClient();
    await mysqlExplain(base, 'SELECT ? AS value', ["'\\value"]);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1]?.[0]).toContain('EXPLAIN FORMAT=JSON');
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('checks session SQL mode for Direct schema introspection parameters', async () => {
    const client = mockClient();
    await mysqlInspectSchema(base, 'app', 'users');
    expect(client.query).toHaveBeenCalledTimes(6);
    expect(client.query.mock.calls.filter(([sql]) => String(sql).startsWith('SHOW SESSION VARIABLES'))).toHaveLength(3);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('keeps Hyperdrive interpolation behind a pinned session-mode check', async () => {
    const client = mockClient();
    await mysqlQueryRead({ ...base, transport: 'hyperdrive' }, 'SELECT ? AS value', ['safe'], 2);
    expect(client.beginTransaction).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.rollback).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('reports a failed Hyperdrive read as settled only when rollback is acknowledged',async()=>{
    const client=mockClient();
    const serverError=Object.assign(new Error('unknown table'),{code:'ER_NO_SUCH_TABLE'});
    client.query.mockImplementation(async (sql:string)=>{
      if(sql.startsWith('SHOW SESSION VARIABLES')) return [[{Variable_name:'sql_mode',Value:'STRICT_TRANS_TABLES'}],[]];
      throw serverError;
    });
    await expect(mysqlQueryRead({...base,transport:'hyperdrive'},'SELECT 1',[],2))
      .rejects.toBeInstanceOf(ConfirmedReadFailure);
    expect(client.rollback).toHaveBeenCalledOnce();
    client.rollback.mockRejectedValue(new Error('lost backend connection'));
    await expect(mysqlQueryRead({...base,transport:'hyperdrive'},'SELECT 1',[],2))
      .rejects.not.toBeInstanceOf(ConfirmedReadFailure);
  });
  it('rejects Hyperdrive interpolation on incompatible SQL mode', async () => {
    const client = mockClient('NO_BACKSLASH_ESCAPES');
    await expect(mysqlQueryRead({ ...base, transport: 'hyperdrive' }, 'SELECT ? AS value', ['safe'], 2))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.rollback).toHaveBeenCalledOnce();
  });
});
