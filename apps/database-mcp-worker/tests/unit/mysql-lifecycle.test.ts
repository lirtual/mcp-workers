import type { Connection } from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicError } from '../../src/errors.js';
import type { EffectiveConnection } from '../../src/types.js';

const { createConnectionMock } = vi.hoisted(() => ({
  createConnectionMock: vi.fn()
}));

vi.mock('mysql2/promise', () => ({
  createConnection: createConnectionMock
}));

import { mysqlHealthCheck } from '../../src/db/mysql.js';
import { createMysqlClient } from '../../src/db/clients.js';

const connection: EffectiveConnection = {
  config: {
    id: 'test-mysql',
    transport: 'direct',
    url: 'mysql://reader:redacted@db.example.test/test'
  },
  transport: 'direct',
  dialect: 'mysql',
  connectionString: 'mysql://redacted',
  host: 'db.example.test',
  user: 'reader',
  password: 'redacted',
  database: 'test',
  port: 3306,
  limits: {
    maxRows: 100,
    maxResultBytes: 1024,
    maxSchemaBytes: 1024,
    queryTimeoutMs: 50
  }
};

describe('MySQL connection lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('connects through the proxy database, not the reviewed origin schema', async () => {
    const client = { end: vi.fn().mockResolvedValue(undefined) } as unknown as Connection;
    createConnectionMock.mockResolvedValue(client);
    await createMysqlClient({
      ...connection, transport: 'hyperdrive',
      proxyDatabase: 'opaque-hyperdrive-proxy',
      database: 'database-mcp-test-mysql'
    });
    expect(createConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({database: 'opaque-hyperdrive-proxy'})
    );
  });

  it('destroys a connection that succeeds after the connection timeout', async () => {
    vi.useFakeTimers();

    let resolveConnection!: (client: Connection) => void;
    const pendingConnection = new Promise<Connection>(resolve => {
      resolveConnection = resolve;
    });
    createConnectionMock.mockReturnValue(pendingConnection);

    const destroy = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue([[], []]);
    const lateClient = { destroy, end, query } as unknown as Connection;

    const healthPromise = mysqlHealthCheck(connection);
    const rejection = expect(healthPromise).rejects.toMatchObject(
      { code: 'QUERY_TIMEOUT' } satisfies Partial<PublicError>
    );

    await vi.advanceTimersByTimeAsync(51);
    await rejection;
    expect(destroy).not.toHaveBeenCalled();

    resolveConnection(lateClient);
    await Promise.resolve();
    await Promise.resolve();

    expect(destroy).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
