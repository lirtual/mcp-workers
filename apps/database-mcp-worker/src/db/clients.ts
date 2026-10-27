import { createConnection, type Connection } from 'mysql2/promise';
import { isIP } from 'node:net';
import { PublicError } from '../errors.js';
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
  if (connection.transport !== 'direct') {
    // Temporary legacy compatibility: Hyperdrive is removed at D1 cutover.
    return new PgClient({ connectionString: connection.connectionString, ...common });
  }
  // NEVER pass connectionString: pg-connection-string can override ssl options via URL params.
  return new PgClient({
    host: connection.host, port: connection.port, user: connection.user,
    password: connection.password, database: connection.database,
    ssl: { rejectUnauthorized: true, ...(connection.ca ? { ca: connection.ca } : {}) }, ...common
  });
}

export async function createMysqlClient(connection: EffectiveConnection, rowsAsArray = false): Promise<Connection> {
  const timeout = Math.min(connection.limits.queryTimeoutMs, 5_000);
  // mysql2 skips checkServerIdentity when the supplied host is an IP literal.
  // Until verified IP-SAN checking is available, fail closed even for public IPs.
  if (connection.transport === 'direct' && isIP(connection.host) !== 0) {
    throw new PublicError('INVALID_INPUT', 'MySQL Direct TLS requires a DNS hostname.');
  }
  const pending = createConnection({
    host: connection.host,
    user: connection.user,
    password: connection.password,
    ...(connection.database.length === 0 ? {} : { database: connection.database }),
    port: connection.port,
    // mysql2 must verify both the trust chain and the DNS identity of the peer.
    ...(connection.transport === 'direct' ? { ssl: { rejectUnauthorized: true, verifyIdentity: true, ...(connection.ca ? { ca: connection.ca } : {}) } } : {}),
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
