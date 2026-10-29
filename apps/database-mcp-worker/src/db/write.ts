import type { Connection } from 'mysql2/promise';
import type { Client as PgClient } from 'pg';
import { createPostgresClient, createMysqlClient } from './clients.js';
import { assertMysqlInterpolationSqlMode, mysqlSafeParams } from './mysql-mode.js';
import { mapDatabaseError, PublicError } from '../errors.js';
import type { BuiltWriteStatement } from '../sql/write.js';
import type { EffectiveWriteConnection, WriteResult } from '../types.js';
import { withTimeout } from './timeout.js';

async function withPostgresClient<T>(
  connection: EffectiveWriteConnection,
  operation: (client: PgClient) => Promise<T>
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

function postgresTimed<T>(
  client: PgClient,
  connection: EffectiveWriteConnection,
  query: Promise<T>
): Promise<T> {
  return withTimeout(query, connection.limits.queryTimeoutMs, () => {
    void client.end().catch(() => undefined);
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

function mysqlTimed<T>(client: Connection, connection: EffectiveWriteConnection, query: Promise<T>): Promise<T> {
  return withTimeout(query, connection.limits.queryTimeoutMs, () => client.destroy());
}

function mysqlAffectedRows(result: unknown): number {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new PublicError('DATABASE_ERROR', 'The database returned an unexpected write result.');
  }
  const affectedRows = (result as { affectedRows?: unknown }).affectedRows;
  if (typeof affectedRows !== 'number' || !Number.isInteger(affectedRows) || affectedRows < 0) {
    throw new PublicError('DATABASE_ERROR', 'The database returned an unexpected write result.');
  }
  return affectedRows;
}

function limitError(connection: EffectiveWriteConnection): PublicError {
  return new PublicError(
    'WRITE_LIMIT_EXCEEDED',
    `Write affected more than the configured maximum of ${connection.maxAffectedRows} rows and was rolled back.`
  );
}

async function postgresInsert(
  connection: EffectiveWriteConnection,
  statement: BuiltWriteStatement
): Promise<WriteResult> {
  return withPostgresClient(connection, async client => {
    const result = await postgresTimed(
      client,
      connection,
      client.query({ text: statement.sql, values: statement.params })
    );
    return { affectedRows: Math.max(0, result.rowCount ?? 0) };
  });
}

async function postgresGuardedMutation(
  connection: EffectiveWriteConnection,
  statement: BuiltWriteStatement
): Promise<WriteResult> {
  return withPostgresClient(connection, async client => {
    let transactionOpen = false;
    try {
      await postgresTimed(client, connection, client.query('BEGIN'));
      transactionOpen = true;
      const result = await postgresTimed(
        client,
        connection,
        client.query({ text: statement.sql, values: statement.params })
      );
      const affectedRows = Math.max(0, result.rowCount ?? 0);
      if (affectedRows > connection.maxAffectedRows) {
        await postgresTimed(client, connection, client.query('ROLLBACK'));
        transactionOpen = false;
        throw limitError(connection);
      }
      await postgresTimed(client, connection, client.query('COMMIT'));
      transactionOpen = false;
      return { affectedRows };
    } catch (error) {
      if (transactionOpen) {
        await postgresTimed(client, connection, client.query('ROLLBACK')).catch(() => undefined);
      }
      throw error;
    }
  });
}

async function mysqlInsert(
  connection: EffectiveWriteConnection,
  statement: BuiltWriteStatement
): Promise<WriteResult> {
  return withMysqlClient(connection, async client => {
    const params = mysqlSafeParams(statement.params);
    if (connection.transport === 'direct') {
      // Some Direct origins reject COM_STMT_PREPARE. Use the same checked
      // dedicated session and bounded client interpolation as Direct reads.
      await assertMysqlInterpolationSqlMode(client, connection);
      const [result] = await mysqlTimed(client, connection, client.query(statement.sql, params));
      return { affectedRows: mysqlAffectedRows(result) };
    }
    let transactionOpen = false;
    try {
      await mysqlTimed(client, connection, client.beginTransaction());
      transactionOpen = true;
      await assertMysqlInterpolationSqlMode(client, connection);
      const [result] = await mysqlTimed(client, connection, client.query(statement.sql, params));
      const affectedRows = mysqlAffectedRows(result);
      await mysqlTimed(client, connection, client.commit());
      transactionOpen = false;
      return { affectedRows };
    } finally {
      if (transactionOpen) await mysqlTimed(client, connection, client.rollback()).catch(() => undefined);
    }
  });
}

async function mysqlGuardedMutation(
  connection: EffectiveWriteConnection,
  statement: BuiltWriteStatement
): Promise<WriteResult> {
  return withMysqlClient(connection, async client => {
    let transactionOpen = false;
    try {
      await mysqlTimed(client, connection, client.beginTransaction());
      transactionOpen = true;
      // For both transports, validate the actual session's escaping mode
      // inside the transaction before interpolating parameters.
      await assertMysqlInterpolationSqlMode(client, connection);
      const params = mysqlSafeParams(statement.params);
      const [result] = await mysqlTimed(client, connection, client.query(statement.sql, params));
      const affectedRows = mysqlAffectedRows(result);
      if (affectedRows > connection.maxAffectedRows) {
        await mysqlTimed(client, connection, client.rollback());
        transactionOpen = false;
        throw limitError(connection);
      }
      await mysqlTimed(client, connection, client.commit());
      transactionOpen = false;
      return { affectedRows };
    } catch (error) {
      if (transactionOpen) {
        await mysqlTimed(client, connection, client.rollback()).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function executeInsertWrite(
  connection: EffectiveWriteConnection,
  statement: BuiltWriteStatement
): Promise<WriteResult> {
  return connection.dialect === 'postgres'
    ? postgresInsert(connection, statement)
    : mysqlInsert(connection, statement);
}

export async function executeGuardedWrite(
  connection: EffectiveWriteConnection,
  statement: BuiltWriteStatement
): Promise<WriteResult> {
  return connection.dialect === 'postgres'
    ? postgresGuardedMutation(connection, statement)
    : mysqlGuardedMutation(connection, statement);
}
