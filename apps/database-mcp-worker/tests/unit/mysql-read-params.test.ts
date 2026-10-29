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

function mockClient() {
  const execute = vi.fn().mockResolvedValue([[['safe']], []]);
  const query = vi.fn().mockResolvedValue([[['safe']], []]);
  const beginTransaction = vi.fn().mockResolvedValue(undefined);
  const rollback = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn().mockResolvedValue(undefined);
  const destroy = vi.fn();
  createConnectionMock.mockResolvedValue({ execute, query, beginTransaction, rollback, end, destroy } as unknown as Connection);
  return { execute, query, beginTransaction, rollback };
}

describe('MySQL read parameter binding', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses server-side binding for Direct query_read (including SQL-mode-sensitive values)', async () => {
    const client = mockClient();
    const value = "a'\\\\b";
    await mysqlQueryRead(base, 'SELECT ? AS value', [value], 2);
    expect(client.execute).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('SELECT ? AS value'), [value]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('uses server-side binding for Direct explain', async () => {
    const client = mockClient();
    await mysqlExplain(base, 'SELECT ? AS value', ["'\\value"]);
    expect(client.execute).toHaveBeenCalledWith(expect.stringContaining('EXPLAIN FORMAT=JSON'), ["'\\value"]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('uses server-side binding for Direct schema introspection', async () => {
    const client = mockClient();
    client.execute.mockResolvedValueOnce([[['id', 'int', 'NO', null, 1, '']], []])
      .mockResolvedValueOnce([[], []]).mockResolvedValueOnce([[], []]);
    await mysqlInspectSchema(base, 'app', 'users');
    expect(client.execute).toHaveBeenCalledTimes(3);
    expect(client.execute.mock.calls.every(([sql, params]) => typeof sql === 'string' &&
      sql.includes(' = ?') && Array.isArray(params) && params.includes('users'))).toBe(true);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('preserves Hyperdrive query interpolation only after pinned SQL-mode verification', async () => {
    const client = mockClient();
    client.query.mockResolvedValueOnce([[{ Variable_name: 'sql_mode', Value: 'STRICT_TRANS_TABLES' }], []])
      .mockResolvedValueOnce([[['safe']], []]);
    await mysqlQueryRead({ ...base, transport: 'hyperdrive' }, 'SELECT ? AS value', ['safe'], 2);
    expect(client.beginTransaction).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.rollback).toHaveBeenCalledOnce();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('rejects Hyperdrive interpolation when session mode cannot be verified', async () => {
    const client = mockClient();
    client.query.mockResolvedValueOnce([[{ Variable_name: 'sql_mode', Value: 'NO_BACKSLASH_ESCAPES' }], []]);
    await expect(mysqlQueryRead({ ...base, transport: 'hyperdrive' }, 'SELECT ? AS value', ['safe'], 2))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.rollback).toHaveBeenCalledOnce();
  });
});
