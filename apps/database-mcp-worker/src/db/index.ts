import { PublicError } from '../errors.js';
import {
  buildAlterTableStatement,
  buildCreateIndexStatement,
  buildCreateTableStatement,
  buildDropIndexStatement,
  buildDropTableStatement,
  type AdminColumnDefinition,
  type AlterTableOperation
} from '../sql/admin.js';
import {
  assertWritePayloadWithinLimit,
  buildDeleteStatement,
  buildInsertStatement,
  buildUpdateStatement
} from '../sql/write.js';
import type {
  AdminResult,
  EffectiveAdminConnection,
  EffectiveConnection,
  EffectiveWriteConnection,
  HealthResult,
  QueryResult,
  SchemaInspection,
  WriteResult
} from '../types.js';
import { executeAdminStatement } from './admin.js';
import { mysqlExplain, mysqlHealthCheck, mysqlInspectSchema, mysqlQueryRead } from './mysql.js';
import { postgresExplain, postgresHealthCheck, postgresInspectSchema, postgresQueryRead } from './postgres.js';
import { executeGuardedWrite, executeInsertWrite } from './write.js';

export async function queryRead(
  connection: EffectiveConnection,
  sql: string,
  params: unknown[],
  rowLimit: number
): Promise<QueryResult> {
  return connection.dialect === 'postgres'
    ? postgresQueryRead(connection, sql, params, rowLimit)
    : mysqlQueryRead(connection, sql, params, rowLimit);
}

export async function explainRead(connection: EffectiveConnection, sql: string, params: unknown[]): Promise<unknown> {
  return connection.dialect === 'postgres'
    ? postgresExplain(connection, sql, params)
    : mysqlExplain(connection, sql, params);
}

export async function healthCheck(connection: EffectiveConnection): Promise<HealthResult> {
  return connection.dialect === 'postgres'
    ? postgresHealthCheck(connection)
    : mysqlHealthCheck(connection);
}

export async function inspectSchema(
  connection: EffectiveConnection,
  schema?: string,
  table?: string
): Promise<SchemaInspection> {
  return connection.dialect === 'postgres'
    ? postgresInspectSchema(connection, schema, table)
    : mysqlInspectSchema(connection, schema, table);
}

function resolveMutationSchema(
  connection: EffectiveConnection,
  requested: string | undefined,
  capability: 'write' | 'admin'
): string {
  if (connection.dialect === 'postgres') {
    return requested ?? connection.config.defaultSchema ?? 'public';
  }

  const configured = connection.database.length === 0 ? undefined : connection.database;
  if (configured !== undefined) {
    if (requested !== undefined && requested !== configured) {
      throw new PublicError('ACCESS_DENIED', `MySQL ${capability} operations are restricted to the configured database.`);
    }
    return configured;
  }

  const selected = requested ?? connection.config.defaultSchema;
  if (selected === undefined) {
    throw new PublicError(
      'INVALID_INPUT',
      `schema is required for MySQL ${capability} operations when the connection URL has no default database.`
    );
  }
  return selected;
}

export async function insertRows(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  rows: unknown
): Promise<WriteResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'write');
  assertWritePayloadWithinLimit({ schema: selectedSchema, table, rows });
  const statement = buildInsertStatement(connection.dialect, selectedSchema, table, rows);
  return executeInsertWrite(connection, statement);
}

export async function updateRows(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  set: unknown,
  where: unknown
): Promise<WriteResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'write');
  assertWritePayloadWithinLimit({ schema: selectedSchema, table, set, where });
  const statement = buildUpdateStatement(connection.dialect, selectedSchema, table, set, where);
  return executeGuardedWrite(connection, statement);
}

export async function deleteRows(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  where: unknown
): Promise<WriteResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'write');
  assertWritePayloadWithinLimit({ schema: selectedSchema, table, where });
  const statement = buildDeleteStatement(connection.dialect, selectedSchema, table, where);
  return executeGuardedWrite(connection, statement);
}

export async function createTable(
  connection: EffectiveAdminConnection,
  schema: string | undefined,
  table: string,
  columns: AdminColumnDefinition[]
): Promise<AdminResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'admin');
  return executeAdminStatement(
    connection,
    buildCreateTableStatement(connection.dialect, selectedSchema, table, columns)
  );
}

export async function alterTable(
  connection: EffectiveAdminConnection,
  schema: string | undefined,
  table: string,
  operation: AlterTableOperation
): Promise<AdminResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'admin');
  return executeAdminStatement(
    connection,
    buildAlterTableStatement(connection.dialect, selectedSchema, table, operation)
  );
}

export async function createIndex(
  connection: EffectiveAdminConnection,
  schema: string | undefined,
  table: string,
  columns: string[],
  unique: boolean,
  name?: string
): Promise<AdminResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'admin');
  return executeAdminStatement(
    connection,
    buildCreateIndexStatement(connection.dialect, selectedSchema, table, columns, unique, name)
  );
}

export async function dropIndex(
  connection: EffectiveAdminConnection,
  schema: string | undefined,
  table: string,
  name: string
): Promise<AdminResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'admin');
  return executeAdminStatement(
    connection,
    buildDropIndexStatement(connection.dialect, selectedSchema, table, name)
  );
}

export async function dropTable(
  connection: EffectiveAdminConnection,
  schema: string | undefined,
  table: string
): Promise<AdminResult> {
  const selectedSchema = resolveMutationSchema(connection, schema, 'admin');
  return executeAdminStatement(connection, buildDropTableStatement(connection.dialect, selectedSchema, table));
}
