import type { Connection } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveConnection } from '../../src/types.js';

const { createConnectionMock } = vi.hoisted(() => ({ createConnectionMock: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createConnection: createConnectionMock }));

import { mysqlExplain, mysqlInspectSchema, mysqlQueryRead } from '../../src/db/mysql.js';

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

  it('pins a native read-only transaction before Direct mode verification and parameter interpolation', async () => {
    const client = mockClient();
    const value = "a'\\\\b";
    await mysqlQueryRead(base, 'SELECT ? AS value', [value], 2);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION READ ONLY',
      "SHOW SESSION VARIABLES LIKE 'sql_mode'",
      expect.stringContaining('SELECT ? AS value')
    ]);
    expect(client.query.mock.calls[2]?.[1]).toEqual([value]);
    expect(client.rollback).toHaveBeenCalledOnce();
    expect(client.beginTransaction).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('requires native read-only mode for Direct constant SELECT as well', async () => {
    const client = mockClient();
    await mysqlQueryRead(base, 'SELECT 1 AS value', [], 2);
    expect(client.query.mock.calls[0]?.[0]).toBe('START TRANSACTION READ ONLY');
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.rollback).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('fails closed if native read-only transaction cannot be established', async () => {
    const client = mockClient();
    client.query.mockRejectedValueOnce(new Error('read-only transaction not supported'));
    await expect(mysqlQueryRead(base, 'SELECT 1', [], 2)).rejects.toBeTruthy();
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('rejects unsafe Direct mode before interpolating a value and rolls back', async () => {
    const client = mockClient('NO_BACKSLASH_ESCAPES');
    await expect(mysqlQueryRead(base, 'SELECT ? AS value', ["'\\x"], 2))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.rollback).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('enforces native read-only mode for Direct EXPLAIN parameters', async () => {
    const client = mockClient();
    await mysqlExplain(base, 'SELECT ? AS value', ["'\\value"]);
    expect(client.query.mock.calls[0]?.[0]).toBe('START TRANSACTION READ ONLY');
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2]?.[0]).toContain('EXPLAIN FORMAT=JSON');
    expect(client.rollback).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('preserves Direct schema introspection behavior', async () => {
    const client = mockClient();
    await mysqlInspectSchema(base, 'app', 'users');
    expect(client.query).toHaveBeenCalledTimes(6);
    expect(client.query.mock.calls.filter(([sql]) => String(sql).startsWith('SHOW SESSION VARIABLES'))).toHaveLength(3);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('pins Hyperdrive read queries within a single native read-only transaction', async () => {
    const client = mockClient();
    await mysqlQueryRead({ ...base, transport: 'hyperdrive' }, 'SELECT ? AS value', ['safe'], 2);
    expect(client.beginTransaction).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0]?.[0]).toBe('START TRANSACTION READ ONLY');
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.rollback).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('fails closed on incompatible Hyperdrive SQL mode', async () => {
    const client = mockClient('NO_BACKSLASH_ESCAPES');
    await expect(mysqlQueryRead({ ...base, transport: 'hyperdrive' }, 'SELECT ? AS value', ['safe'], 2))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.rollback).toHaveBeenCalledOnce();
  });
});
