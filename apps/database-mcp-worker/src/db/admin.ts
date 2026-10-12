import { createConnection, type Connection } from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import { mapDatabaseError } from '../errors.js';
import type { BuiltAdminStatement } from '../sql/admin.js';
import type { AdminResult, EffectiveAdminConnection } from '../types.js';
import { withTimeout } from './timeout.js';

function createPostgresClient(connection: EffectiveAdminConnection): PgClient {
  return new PgClient({
    connectionString: connection.connectionString,
    ...(connection.transport === 'direct' ? { ssl: false } : {}),
    statement_timeout: connection.limits.queryTimeoutMs,
    query_timeout: connection.limits.queryTimeoutMs,
    connectionTimeoutMillis: Math.min(connection.limits.queryTimeoutMs, 5_000),
    application_name: 'cloudflare-database-mcp-admin'
  });
}

async function executePostgresAdmin(
  connection: EffectiveAdminConnection,
  statement: BuiltAdminStatement
): Promise<AdminResult> {
  const client = createPostgresClient(connection);
  try {
    await withTimeout(client.connect(), Math.min(connection.limits.queryTimeoutMs, 5_000), () => {
      void client.end().catch(() => undefined);
    });
    await withTimeout(client.query(statement.sql), connection.limits.queryTimeoutMs, () => {
      void client.end().catch(() => undefined);
    });
    return { ok: true, operation: statement.operation };
  } catch (error) {
    throw mapDatabaseError(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function createMysqlClient(connection: EffectiveAdminConnection): Promise<Connection> {
  const pending = createConnection({
    host: connection.host,
    user: connection.user,
    password: connection.password,
    ...(connection.database.length === 0 ? {} : { database: connection.database }),
    port: connection.port,
    disableEval: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    connectTimeout: Math.min(connection.limits.queryTimeoutMs, 5_000)
  });
  return withTimeout(pending, Math.min(connection.limits.queryTimeoutMs, 5_000), () => {
    void pending.then(
      lateClient => lateClient.destroy(),
      () => undefined
    );
  });
}

async function executeMysqlAdmin(
  connection: EffectiveAdminConnection,
  statement: BuiltAdminStatement
): Promise<AdminResult> {
  let client: Connection | undefined;
  try {
    client = await createMysqlClient(connection);
    await withTimeout(client.query(statement.sql), connection.limits.queryTimeoutMs, () => client?.destroy());
    return { ok: true, operation: statement.operation };
  } catch (error) {
    throw mapDatabaseError(error);
  } finally {
    if (client !== undefined) await client.end().catch(() => undefined);
  }
}

export async function executeAdminStatement(
  connection: EffectiveAdminConnection,
  statement: BuiltAdminStatement
): Promise<AdminResult> {
  return connection.dialect === 'postgres'
    ? executePostgresAdmin(connection, statement)
    : executeMysqlAdmin(connection, statement);
}
