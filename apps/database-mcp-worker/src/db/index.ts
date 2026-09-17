import { PublicError } from '../errors.js';
import {
  assertWritePayloadWithinLimit,
  buildDeleteStatement,
  buildInsertStatement,
  buildUpdateStatement
} from '../sql/write.js';
import type {
  EffectiveConnection,
  EffectiveWriteConnection,
  HealthResult,
  QueryResult,
  SchemaInspection,
  WriteResult
} from '../types.js';
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

function resolveWriteSchema(connection: EffectiveWriteConnection, requested: string | undefined): string {
  if (connection.dialect === 'postgres') {
    return requested ?? connection.config.defaultSchema ?? 'public';
  }

  const configured = connection.database.length === 0 ? undefined : connection.database;
  if (configured !== undefined) {
    if (requested !== undefined && requested !== configured) {
      throw new PublicError('ACCESS_DENIED', 'MySQL writes are restricted to the configured database.');
    }
    return configured;
  }

  const selected = requested ?? connection.config.defaultSchema;
  if (selected === undefined) {
    throw new PublicError(
      'INVALID_INPUT',
      'schema is required for MySQL writes when the write connection URL has no default database.'
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
  const selectedSchema = resolveWriteSchema(connection, schema);
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
  const selectedSchema = resolveWriteSchema(connection, schema);
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
  const selectedSchema = resolveWriteSchema(connection, schema);
  assertWritePayloadWithinLimit({ schema: selectedSchema, table, where });
  const statement = buildDeleteStatement(connection.dialect, selectedSchema, table, where);
  return executeGuardedWrite(connection, statement);
}