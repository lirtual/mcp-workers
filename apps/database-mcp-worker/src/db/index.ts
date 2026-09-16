import type { EffectiveConnection, HealthResult, QueryResult, SchemaInspection } from '../types.js';
import { mysqlExplain, mysqlHealthCheck, mysqlInspectSchema, mysqlQueryRead } from './mysql.js';
import { postgresExplain, postgresHealthCheck, postgresInspectSchema, postgresQueryRead } from './postgres.js';

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
