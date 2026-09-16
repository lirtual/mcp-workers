import { createConnection, type Connection } from 'mysql2/promise';
import { Client } from 'pg';
import { mapDatabaseError, PublicError } from '../errors.js';
import { buildDeleteStatement, buildInsertStatement, buildUpdateStatement, type WriteStatement } from '../sql/write.js';
import type { EffectiveWriteConnection, WriteResult } from '../types.js';
import { withTimeout } from './timeout.js';

async function createMysqlClient(connection: EffectiveWriteConnection): Promise<Connection> {
  const pending = createConnection({
    host: connection.host,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    port: connection.port,
    disableEval: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    connectTimeout: Math.min(connection.limits.queryTimeoutMs, 5_000)
  });
  const timeoutMs = Math.min(connection.limits.queryTimeoutMs, 5_000);
  return withTimeout(pending, timeoutMs, () => {
    void pending.then(client => client.destroy(), () => undefined);
  });
}

async function withMysqlClient<T>(
  connection: EffectiveWriteConnection,
  operation: (client: Connection) => Promise<T>
): Promise<T> {
  let client: Connection | undefined;
  try {
    client = await createMysqlClient(connection);
    return await operation(client);
  } catch (error) {
    throw mapDatabaseError(error);
  } finally {
    if (client !== undefined) await client.end().catch(() => undefined);
  }
}

function createPostgresClient(connection: EffectiveWriteConnection): Client {
  return new Client({
    connectionString: connection.connectionString,
    ...(connection.transport === 'direct' ? { ssl: false } : {}),
    statement_timeout: connection.limits.queryTimeoutMs,
    query_timeout: connection.limits.queryTimeoutMs,
    connectionTimeoutMillis: Math.min(connection.limits.queryTimeoutMs, 5_000),
    application_name: 'cloudflare-database-mcp-write'
  });
}

async function withPostgresClient<T>(
  connection: EffectiveWriteConnection,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  const client = createPostgresClient(connection);
  try {
    await withTimeout(client.connect(), Math.min(connection.limits.queryTimeoutMs, 5_000), () => {
      void client.end().catch(() => undefined);
    });
    return await operation(client);
  } catch (error) {
    throw mapDatabaseError(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function mysqlAffectedRows(value: unknown): { affectedRows: number; insertId?: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PublicError('DATABASE_ERROR', 'The database returned an unexpected write result shape.');
  }
  const result = value as { affectedRows?: unknown; insertId?: unknown };
  if (typeof result.affectedRows !== 'number' || !Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0) {
    throw new PublicError('DATABASE_ERROR', 'The database returned an unexpected write result shape.');
  }
  return {
    affectedRows: result.affectedRows,
    ...(typeof result.insertId === 'number' && Number.isSafeInteger(result.insertId) && result.insertId > 0
      ? { insertId: result.insertId }
      : {})
  };
}

async function mysqlQueryMutation(
  client: Connection,
  connection: EffectiveWriteConnection,
  statement: WriteStatement
): Promise<{ affectedRows: number; insertId?: number }> {
  const [result] = await withTimeout(
    client.query(statement.sql, statement.params),
    connection.limits.queryTimeoutMs,
    () => client.destroy()
  );
  return mysqlAffectedRows(result);
}

async function mysqlGuardedMutation(
  connection: EffectiveWriteConnection,
  statement: WriteStatement
): Promise<WriteResult> {
  return withMysqlClient(connection, async client => {
    let inTransaction = false;
    try {
      await withTimeout(client.query('START TRANSACTION'), connection.limits.queryTimeoutMs, () => client.destroy());
      inTransaction = true;
      const result = await mysqlQueryMutation(client, connection, statement);
      if (result.affectedRows > connection.maxAffectedRows) {
        await client.query('ROLLBACK').catch(() => undefined);
        inTransaction = false;
        throw new PublicError(
          'WRITE_LIMIT_EXCEEDED',
          'The write affected more rows than allowed and was rolled back.'
        );
      }
      await withTimeout(client.query('COMMIT'), connection.limits.queryTimeoutMs, () => client.destroy());
      inTransaction = false;
      return { affectedRows: result.affectedRows };
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

async function postgresQueryMutation(
  client: Client,
  connection: EffectiveWriteConnection,
  statement: WriteStatement
): Promise<number> {
  const result = await withTimeout(
    client.query({ text: statement.sql, values: statement.params }),
    connection.limits.queryTimeoutMs,
    () => void client.end().catch(() => undefined)
  );
  return result.rowCount ?? 0;
}

async function postgresGuardedMutation(
  connection: EffectiveWriteConnection,
  statement: WriteStatement
): Promise<WriteResult> {
  return withPostgresClient(connection, async client => {
    let inTransaction = false;
    try {
      await withTimeout(client.query('BEGIN'), connection.limits.queryTimeoutMs, () => {
        void client.end().catch(() => undefined);
      });
      inTransaction = true;
      const affectedRows = await postgresQueryMutation(client, connection, statement);
      if (affectedRows > connection.maxAffectedRows) {
        await client.query('ROLLBACK').catch(() => undefined);
        inTransaction = false;
        throw new PublicError(
          'WRITE_LIMIT_EXCEEDED',
          'The write affected more rows than allowed and was rolled back.'
        );
      }
      await withTimeout(client.query('COMMIT'), connection.limits.queryTimeoutMs, () => {
        void client.end().catch(() => undefined);
      });
      inTransaction = false;
      return { affectedRows };
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export async function insertRows(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  rows: Array<Record<string, unknown>>
): Promise<WriteResult> {
  const statement = buildInsertStatement(connection, schema, table, rows);
  if (connection.dialect === 'postgres') {
    return withPostgresClient(connection, async client => ({
      affectedRows: await postgresQueryMutation(client, connection, statement)
    }));
  }

  return withMysqlClient(connection, async client => {
    const result = await mysqlQueryMutation(client, connection, statement);
    return {
      affectedRows: result.affectedRows,
      ...(statement.rowCount === 1 && result.insertId !== undefined ? { insertId: result.insertId } : {})
    };
  });
}

export async function updateRows(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  set: Record<string, unknown>,
  where: Record<string, unknown>
): Promise<WriteResult> {
  const statement = buildUpdateStatement(connection, schema, table, set, where);
  return connection.dialect === 'postgres'
    ? postgresGuardedMutation(connection, statement)
    : mysqlGuardedMutation(connection, statement);
}

export async function deleteRows(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  where: Record<string, unknown>
): Promise<WriteResult> {
  const statement = buildDeleteStatement(connection, schema, table, where);
  return connection.dialect === 'postgres'
    ? postgresGuardedMutation(connection, statement)
    : mysqlGuardedMutation(connection, statement);
}
