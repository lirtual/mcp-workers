import type { Connection } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveWriteConnection } from '../../src/types.js';

const { createConnectionMock } = vi.hoisted(() => ({ createConnectionMock: vi.fn() }));
vi.mock('mysql2/promise', () => ({ createConnection: createConnectionMock }));

import { executeGuardedWrite, executeInsertWrite } from '../../src/db/write.js';

const direct: EffectiveWriteConnection = {
  config: { id: 'example', transport: 'direct', url: 'mysql://writer@db.example.org/app' },
  transport: 'direct', dialect: 'mysql',
  connectionString: 'mysql://writer@db.example.org/app',
  host: 'db.example.org', port: 3306, user: 'writer', password: 'test', database: 'app',
  limits: { maxRows: 10, maxResultBytes: 10000, maxSchemaBytes: 10000, queryTimeoutMs: 5000 },
  maxAffectedRows: 1
};

function mockClient(sqlMode = 'STRICT_TRANS_TABLES', affectedRows = 1) {
  const order: string[] = [];
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.startsWith('SHOW SESSION VARIABLES')) {
      order.push('mode');
      return [[{ Variable_name: 'sql_mode', Value: sqlMode }], []];
    }
    order.push('write');
    return [{ affectedRows }, []];
  });
  const execute = vi.fn().mockRejectedValue(new Error('unsupported COM_STMT_PREPARE'));
  const beginTransaction = vi.fn().mockImplementation(async () => { order.push('begin'); });
  const commit = vi.fn().mockImplementation(async () => { order.push('commit'); });
  const rollback = vi.fn().mockImplementation(async () => { order.push('rollback'); });
  const end = vi.fn().mockResolvedValue(undefined);
  const destroy = vi.fn();
  createConnectionMock.mockResolvedValue({
    query, execute, beginTransaction, commit, rollback, end, destroy
  } as unknown as Connection);
  return { query, execute, beginTransaction, commit, rollback, order };
}

describe('MySQL write interpolation and Direct protocol compatibility', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses the checked Direct session for INSERT without COM_STMT_PREPARE', async () => {
    const client = mockClient();
    const tricky = "quote'\\backslash; -- 你好";
    const statement = {
      sql: 'INSERT INTO items (name, flag) VALUES (?, ?)',
      params: [tricky, true]
    };
    await expect(executeInsertWrite(direct, statement)).resolves.toEqual({ affectedRows: 1 });
    expect(client.order).toEqual(['mode', 'write']);
    expect(client.query).toHaveBeenNthCalledWith(2, statement.sql, [tricky, true]);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('checks SQL mode after BEGIN and commits a bounded Direct UPDATE', async () => {
    const client = mockClient();
    const statement = {
      sql: 'UPDATE items SET name = ? WHERE id = ?',
      params: ["x'\\; DROP TABLE items", 4]
    };
    await expect(executeGuardedWrite(direct, statement)).resolves.toEqual({ affectedRows: 1 });
    expect(client.order).toEqual(['begin', 'mode', 'write', 'commit']);
    expect(client.query).toHaveBeenNthCalledWith(2, statement.sql, statement.params);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('rolls back a Direct DELETE exceeding the affected-row limit', async () => {
    const client = mockClient('STRICT_TRANS_TABLES', 2);
    await expect(executeGuardedWrite(direct, {
      sql: 'DELETE FROM items WHERE type = ?', params: ['temporary']
    })).rejects.toMatchObject({ code: 'WRITE_LIMIT_EXCEEDED' });
    expect(client.order).toEqual(['begin', 'mode', 'write', 'rollback']);
    expect(client.commit).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('fails closed before INSERT when Direct SQL mode permits unsafe escaping', async () => {
    const client = mockClient('STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES');
    await expect(executeInsertWrite(direct, {
      sql: 'INSERT INTO items (name) VALUES (?)', params: ["'\\injection"]
    })).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(client.order).toEqual(['mode']);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('fails closed and rolls back before UPDATE in an unsafe Direct session', async () => {
    const client = mockClient('NO_BACKSLASH_ESCAPES');
    await expect(executeGuardedWrite(direct, {
      sql: 'UPDATE items SET name = ? WHERE id = ?',
      params: ["'\\injection", 4]
    })).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(client.order).toEqual(['begin', 'mode', 'rollback']);
    expect(client.commit).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('rejects exotic client-interpolation hooks as parameters', async () => {
    const client = mockClient();
    await expect(executeInsertWrite(direct, {
      sql: 'INSERT INTO items (name) VALUES (?)',
      params: [{ toSqlString: () => '1); DROP TABLE items;' }]
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(client.query).not.toHaveBeenCalled();
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('preserves pinned Hyperdrive transaction-mode verification for writes', async () => {
    const client = mockClient();
    await expect(executeGuardedWrite({ ...direct, transport: 'hyperdrive' }, {
      sql: 'UPDATE items SET name = ? WHERE id = ?',
      params: ['safe', 4]
    })).resolves.toEqual({ affectedRows: 1 });
    expect(client.order).toEqual(['begin', 'mode', 'write', 'commit']);
    expect(client.execute).not.toHaveBeenCalled();
  });
});
