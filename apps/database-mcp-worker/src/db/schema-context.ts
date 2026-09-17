import { PublicError } from '../errors.js';
import { assertJsonWithinBytes } from '../result.js';
import type { EffectiveConnection, QueryResult } from '../types.js';
import { mysqlQueryRead } from './mysql.js';
import { postgresQueryRead } from './postgres.js';

const MAX_CONTEXT_TABLES = 100;

interface ContextColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

interface ContextTable {
  name: string;
  type: string;
  columns: ContextColumn[];
}

export interface SchemaContextResult {
  dialect: EffectiveConnection['dialect'];
  schema: string;
  tableCount: number;
  totalTables: number;
  truncated: boolean;
  context: string;
}

function resolveContextSchema(connection: EffectiveConnection, requested: string | undefined): string {
  if (connection.dialect === 'postgres') {
    return requested ?? connection.config.defaultSchema ?? 'public';
  }

  const configured = connection.database.length === 0 ? undefined : connection.database;
  if (configured !== undefined && requested !== undefined && requested !== configured) {
    throw new PublicError('ACCESS_DENIED', 'MySQL schema context is restricted to the configured database.');
  }

  const selected = requested ?? configured ?? connection.config.defaultSchema;
  if (selected === undefined) {
    throw new PublicError(
      'INVALID_INPUT',
      'schema is required for MySQL schema context when the connection URL has no default database.'
    );
  }
  return selected;
}

async function readMetadata(
  connection: EffectiveConnection,
  sql: string,
  params: unknown[],
  rowLimit: number
): Promise<QueryResult> {
  return connection.dialect === 'postgres'
    ? postgresQueryRead(connection, sql, params, rowLimit)
    : mysqlQueryRead(connection, sql, params, rowLimit);
}

function refName(schema: string, referencedSchema: string | null, table: string, column: string): string {
  return referencedSchema !== null && referencedSchema !== schema
    ? `${referencedSchema}.${table}.${column}`
    : `${table}.${column}`;
}

export function formatSchemaContextRows(
  dialect: EffectiveConnection['dialect'],
  schema: string,
  columnsResult: QueryResult,
  constraintsResult: QueryResult,
  maxSchemaBytes: number
): SchemaContextResult {
  const tables = new Map<string, ContextTable>();
  let totalTables = 0;

  for (const row of columnsResult.rows) {
    const tableName = String(row[0]);
    const tableType = String(row[1]);
    totalTables = Math.max(totalTables, Number(row[2]) || 0);
    const table = tables.get(tableName) ?? { name: tableName, type: tableType, columns: [] };
    table.columns.push({
      name: String(row[3]),
      dataType: String(row[4]),
      nullable: String(row[5]).toUpperCase() === 'YES'
    });
    tables.set(tableName, table);
  }

  const primaryKeys = new Set<string>();
  const foreignKeys = new Map<string, string[]>();
  for (const row of constraintsResult.rows) {
    const tableName = String(row[0]);
    const constraintType = String(row[1]);
    const columnName = String(row[2]);
    const key = `${tableName}\u0000${columnName}`;
    if (constraintType === 'PRIMARY KEY') {
      primaryKeys.add(key);
      continue;
    }
    if (constraintType !== 'FOREIGN KEY' || row[4] === null || row[5] === null) continue;
    const target = refName(
      schema,
      row[3] === null ? null : String(row[3]),
      String(row[4]),
      String(row[5])
    );
    const current = foreignKeys.get(key) ?? [];
    if (!current.includes(target)) current.push(target);
    foreignKeys.set(key, current);
  }

  const lines = [...tables.values()].map(table => {
    const columns = table.columns.map(column => {
      const key = `${table.name}\u0000${column.name}`;
      let text = `${column.name} ${column.dataType}`;
      if (primaryKeys.has(key)) text += ' PK';
      if (!column.nullable) text += ' NOT NULL';
      const references = foreignKeys.get(key);
      if (references?.length) text += ` -> ${references.join('|')}`;
      return text;
    });
    const label = table.type === 'BASE TABLE' ? table.name : `${table.name} [${table.type}]`;
    return `${label}(${columns.join(', ')})`;
  });

  const result: SchemaContextResult = {
    dialect,
    schema,
    tableCount: tables.size,
    totalTables,
    truncated: columnsResult.truncated || constraintsResult.truncated || totalTables > tables.size,
    context: lines.join('\n')
  };
  assertJsonWithinBytes(result, maxSchemaBytes);
  return result;
}

export async function getSchemaContext(
  connection: EffectiveConnection,
  schema: string | undefined,
  tableLimit: number
): Promise<SchemaContextResult> {
  if (!Number.isInteger(tableLimit) || tableLimit < 1 || tableLimit > MAX_CONTEXT_TABLES) {
    throw new PublicError('INVALID_INPUT', `tableLimit must be an integer from 1 to ${MAX_CONTEXT_TABLES}.`);
  }

  const selectedSchema = resolveContextSchema(connection, schema);
  const rowLimit = Math.min(connection.limits.maxRows, 5_000);

  const columnsSql =
    connection.dialect === 'postgres'
      ? `SELECT selected.table_name, selected.table_type, selected.total_tables,
                c.column_name, c.data_type, c.is_nullable, c.ordinal_position
         FROM (
           SELECT table_name, table_type,
                  ROW_NUMBER() OVER (ORDER BY table_name) AS table_rank,
                  COUNT(*) OVER() AS total_tables
           FROM information_schema.tables
           WHERE table_schema = $1
         ) AS selected
         JOIN information_schema.columns c
           ON c.table_schema = $1 AND c.table_name = selected.table_name
         WHERE selected.table_rank <= $2
         ORDER BY selected.table_name, c.ordinal_position`
      : `SELECT selected.table_name, selected.table_type, selected.total_tables,
                c.column_name, c.column_type, c.is_nullable, c.ordinal_position
         FROM (
           SELECT table_name, table_type,
                  ROW_NUMBER() OVER (ORDER BY table_name) AS table_rank,
                  COUNT(*) OVER() AS total_tables
           FROM information_schema.tables
           WHERE table_schema = ?
         ) AS selected
         JOIN information_schema.columns c
           ON c.table_schema = ? AND c.table_name = selected.table_name
         WHERE selected.table_rank <= ?
         ORDER BY selected.table_name, c.ordinal_position`;
  const columnsParams =
    connection.dialect === 'postgres'
      ? [selectedSchema, tableLimit]
      : [selectedSchema, selectedSchema, tableLimit];

  const constraintsSql =
    connection.dialect === 'postgres'
      ? `SELECT tc.table_name, tc.constraint_type, kcu.column_name,
                ref_kcu.table_schema AS foreign_table_schema,
                ref_kcu.table_name AS foreign_table_name,
                ref_kcu.column_name AS foreign_column_name,
                kcu.ordinal_position
         FROM information_schema.table_constraints tc
         JOIN (
           SELECT table_name, ROW_NUMBER() OVER (ORDER BY table_name) AS table_rank
           FROM information_schema.tables
           WHERE table_schema = $1
         ) AS selected ON selected.table_name = tc.table_name
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.constraint_schema = kcu.constraint_schema
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         LEFT JOIN information_schema.referential_constraints rc
           ON tc.constraint_name = rc.constraint_name
          AND tc.constraint_schema = rc.constraint_schema
         LEFT JOIN information_schema.key_column_usage ref_kcu
           ON rc.unique_constraint_name = ref_kcu.constraint_name
          AND rc.unique_constraint_schema = ref_kcu.constraint_schema
          AND kcu.position_in_unique_constraint = ref_kcu.ordinal_position
         WHERE tc.table_schema = $1
           AND selected.table_rank <= $2
           AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
         ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`
      : `SELECT tc.table_name, tc.constraint_type, kcu.column_name,
                kcu.referenced_table_schema, kcu.referenced_table_name,
                kcu.referenced_column_name, kcu.ordinal_position
         FROM information_schema.table_constraints tc
         JOIN (
           SELECT table_name, ROW_NUMBER() OVER (ORDER BY table_name) AS table_rank
           FROM information_schema.tables
           WHERE table_schema = ?
         ) AS selected ON selected.table_name = tc.table_name
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_schema = kcu.constraint_schema
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
          AND tc.constraint_name = kcu.constraint_name
         WHERE tc.table_schema = ?
           AND selected.table_rank <= ?
           AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
         ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`;
  const constraintsParams =
    connection.dialect === 'postgres'
      ? [selectedSchema, tableLimit]
      : [selectedSchema, selectedSchema, tableLimit];

  const columnsResult = await readMetadata(connection, columnsSql, columnsParams, rowLimit);
  const constraintsResult = await readMetadata(connection, constraintsSql, constraintsParams, rowLimit);
  return formatSchemaContextRows(
    connection.dialect,
    selectedSchema,
    columnsResult,
    constraintsResult,
    connection.limits.maxSchemaBytes
  );
}
