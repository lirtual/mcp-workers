import type { Connection } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertRows } from '../../src/db/index.js';
import type { PublicError } from '../../src/errors.js';
import type { EffectiveConnection, EffectiveWriteConnection } from '../../src/types.js';

const { createConnectionMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn()
}));

vi.mock('mysql2/promise', () => ({
  createConnection: createConnectionMock
}));

import { mysqlInspectSchema } from '../../src/db/mysql.js';

const limits = {
  maxRows: 100,
  maxResultBytes: 1024,
  maxSchemaBytes: 1024,
  queryTimeoutMs: 100
};

function serverConnection(): EffectiveConnection {
  return {
    config: {
      id: 'mysql-server',
      displayName: 'MySQL Server',
      transport: 'direct',
      url: 'mysql://reader:redacted@127.0.0.1:3306',
      enabled: true
    },
    transport: 'direct',
    dialect: 'mysql',
    connectionString: 'mysql://reader:redacted@127.0.0.1:3306',
    host: '127.0.0.1',
    user: 'reader',
    password: 'redacted',
    database: '',
    port: 3306,
    limits
  };
}

describe('server-level MySQL connections', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('omits the database option and lists visible schemas when no default database is configured', async () => {
    const query = vi.fn().mockResolvedValue([[['app'], ['analytics']], []]);
    const end = vi.fn().mockResolvedValue(undefined);
    const destroy = vi.fn();
    createConnectionMock.mockResolvedValue({ query, end, destroy } as unknown as Connection);

    const result = await mysqlInspectSchema(serverConnection());

    expect(result).toEqual({ dialect: 'mysql', schemas: ['app', 'analytics'] });
    expect(createConnectionMock).toHaveBeenCalledWith(expect.not.objectContaining({ database: expect.anything() }));
    expect(query).toHaveBeenCalledOnce();
  });

  it('requires an explicit schema for Safe Write when the writer URL has no default database', async () => {
    const read = serverConnection();
    const write: EffectiveWriteConnection = {
      ...read,
      config: {
        ...read.config,
        write: { transport: 'direct', url: 'mysql://writer:redacted@127.0.0.1:3306' }
      },
      user: 'writer',
      maxAffectedRows: 20
    };

    const rejection = expect(insertRows(write, undefined, 'users', [{ name: 'Ada' }])).rejects.toMatchObject(
      { code: 'INVALID_INPUT' } satisfies Partial<PublicError>
    );
    await rejection;
    expect(createConnectionMock).not.toHaveBeenCalled();
  });
});
