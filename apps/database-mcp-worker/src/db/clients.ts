import { createConnection, type Connection } from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import type { EffectiveConnection } from '../types.js';
import { withTimeout } from './timeout.js';

/** One hardened transport policy shared by read, health, Safe Write and Safe Admin. */
export function createPostgresClient(connection: EffectiveConnection): PgClient {
  const timeout = Math.min(connection.limits.queryTimeoutMs, 5_000);
  const common = {
    statement_timeout: connection.limits.queryTimeoutMs,
    query_timeout: connection.limits.queryTimeoutMs,
    connectionTimeoutMillis: timeout,
    application_name: 'cloudflare-database-mcp'
  };
  // NEVER pass connectionString: pg-connection-string can override ssl options via URL params.
  return new PgClient({
    host: connection.transport === 'direct' ? (connection.dialHost ?? connection.host) : connection.host,
    port: connection.port, user: connection.user,
    password: connection.password, database: connection.database,
    ssl: false, ...common
  });
}

export async function createMysqlClient(connection: EffectiveConnection, rowsAsArray = false): Promise<Connection> {
  const timeout = Math.min(connection.limits.queryTimeoutMs, 5_000);
  // TLS is terminated and verified upstream by Hyperdrive; Direct is expressly plaintext.
  // Never send a fake client CA to either driver.
  const driverDatabase = connection.transport === 'hyperdrive'
    ? (connection.proxyDatabase ?? connection.database) : connection.database;
  const pending = createConnection({
    host: connection.transport === 'direct' ? (connection.dialHost ?? connection.host) : connection.host,
    user: connection.user,
    password: connection.password,
    ...(driverDatabase.length === 0 ? {} : { database: driverDatabase }),
    port: connection.port,
    // mysql2 must verify both the trust chain and the DNS identity of the peer.
    disableEval: true,
    rowsAsArray,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    connectTimeout: timeout
  });
  return withTimeout(pending, timeout, () => {
    // A timed-out connection attempt may still resolve: destroy that late client.
    void pending.then(lateClient => lateClient.destroy(), () => undefined);
  });
}
