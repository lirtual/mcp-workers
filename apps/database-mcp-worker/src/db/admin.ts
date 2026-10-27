import type { Connection } from 'mysql2/promise';
import { createPostgresClient, createMysqlClient } from './clients.js';
import { mapDatabaseError } from '../errors.js';
import type { BuiltAdminStatement } from '../sql/admin.js';
import type { AdminResult, EffectiveAdminConnection } from '../types.js';
import { withTimeout } from './timeout.js';

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
