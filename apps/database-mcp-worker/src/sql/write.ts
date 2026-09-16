import { PublicError } from '../errors.js';
import type { Dialect, EffectiveWriteConnection } from '../types.js';

const MAX_WRITE_PAYLOAD_BYTES = 256 * 1024;
const MAX_INSERT_ROWS = 100;
const MAX_COLUMNS = 100;
const MAX_PREDICATES = 20;
const MAX_IN_VALUES = 100;
const MAX_IDENTIFIER_LENGTH = 128;

export interface WriteStatement {
  sql: string;
  params: unknown[];
}

export interface InsertStatement extends WriteStatement {
  rowCount: number;
}

function invalid(message: string): never {
  throw new PublicError('INVALID_INPUT', message);
}

function jsonBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return new TextEncoder().encode(serialized).byteLength;
}

export function assertWritePayloadWithinLimit(value: unknown): void {
  if (jsonBytes(value) > MAX_WRITE_PAYLOAD_BYTES) {
    invalid('Write payload exceeds the maximum supported size.');
  }
}

function validateIdentifier(value: string, kind: string): string {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || value.includes('\0')) {
    invalid(`Invalid ${kind} identifier.`);
  }
  return value;
}

export function quoteWriteIdentifier(value: string, dialect: Dialect): string {
  const identifier = validateIdentifier(value, 'SQL');
  return dialect === 'postgres'
    ? `"${identifier.replaceAll('"', '""')}"`
    : `\`${identifier.replaceAll('`', '``')}\``;
}

function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?';
}

function qualifiedTable(connection: EffectiveWriteConnection, schema: string | undefined, table: string): string {
  const quotedTable = quoteWriteIdentifier(validateIdentifier(table, 'table'), connection.dialect);
  if (connection.dialect === 'postgres') {
    const selectedSchema = schema ?? connection.config.defaultSchema ?? 'public';
    return `${quoteWriteIdentifier(validateIdentifier(selectedSchema, 'schema'), 'postgres')}.${quotedTable}`;
  }

  if (schema !== undefined && schema !== connection.database) {
    throw new PublicError('ACCESS_DENIED', 'MySQL writes are restricted to the configured database.');
  }
  return `${quoteWriteIdentifier(validateIdentifier(connection.database, 'database'), 'mysql')}.${quotedTable}`;
}

function objectEntries(value: Record<string, unknown>, kind: string, max: number): Array<[string, unknown]> {
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > max) invalid(`${kind} must contain 1 to ${max} columns.`);
  for (const [column] of entries) validateIdentifier(column, 'column');
  return entries;
}

function buildWhere(
  dialect: Dialect,
  where: Record<string, unknown>,
  params: unknown[]
): string {
  const entries = objectEntries(where, 'where', MAX_PREDICATES);
  const clauses: string[] = [];

  for (const [column, predicate] of entries) {
    const quotedColumn = quoteWriteIdentifier(column, dialect);

    if (typeof predicate === 'string' || typeof predicate === 'number' || typeof predicate === 'boolean') {
      params.push(predicate);
      clauses.push(`${quotedColumn} = ${placeholder(dialect, params.length)}`);
      continue;
    }

    if (predicate === null) {
      invalid(`Null predicate for '${column}' must use isNull.`);
    }
    if (typeof predicate !== 'object' || Array.isArray(predicate)) {
      invalid(`Invalid predicate for '${column}'.`);
    }

    const record = predicate as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1) invalid(`Predicate for '${column}' must contain exactly one operator.`);

    const operator = keys[0]!;
    if (operator === 'eq') {
      params.push(record.eq);
      clauses.push(`${quotedColumn} = ${placeholder(dialect, params.length)}`);
      continue;
    }

    if (operator === 'in') {
      if (!Array.isArray(record.in) || record.in.length === 0 || record.in.length > MAX_IN_VALUES) {
        invalid(`IN predicate for '${column}' must contain 1 to ${MAX_IN_VALUES} values.`);
      }
      const marks = record.in.map(value => {
        params.push(value);
        return placeholder(dialect, params.length);
      });
      clauses.push(`${quotedColumn} IN (${marks.join(', ')})`);
      continue;
    }

    if (operator === 'isNull') {
      if (typeof record.isNull !== 'boolean') invalid(`isNull predicate for '${column}' must be boolean.`);
      clauses.push(`${quotedColumn} IS ${record.isNull ? '' : 'NOT '}NULL`);
      continue;
    }

    invalid(`Unsupported predicate operator for '${column}'.`);
  }

  return clauses.join(' AND ');
}

function assertSameColumns(rows: Array<Record<string, unknown>>, columns: string[]): void {
  const expected = [...columns].sort();
  for (const row of rows) {
    const actual = Object.keys(row).sort();
    if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
      invalid('All inserted rows must contain exactly the same columns.');
    }
  }
}

export function buildInsertStatement(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  rows: Array<Record<string, unknown>>
): InsertStatement {
  assertWritePayloadWithinLimit(rows);
  if (rows.length === 0 || rows.length > MAX_INSERT_ROWS) {
    invalid(`rows must contain 1 to ${MAX_INSERT_ROWS} objects.`);
  }

  const first = rows[0]!;
  const columns = Object.keys(first);
  if (columns.length === 0 || columns.length > MAX_COLUMNS) {
    invalid(`Inserted rows must contain 1 to ${MAX_COLUMNS} columns.`);
  }
  for (const column of columns) validateIdentifier(column, 'column');
  assertSameColumns(rows, columns);

  const params: unknown[] = [];
  const valueGroups = rows.map(row => {
    const marks = columns.map(column => {
      params.push(row[column]);
      return placeholder(connection.dialect, params.length);
    });
    return `(${marks.join(', ')})`;
  });
  const tableName = qualifiedTable(connection, schema, table);
  const columnSql = columns.map(column => quoteWriteIdentifier(column, connection.dialect)).join(', ');

  return {
    sql: `INSERT INTO ${tableName} (${columnSql}) VALUES ${valueGroups.join(', ')}`,
    params,
    rowCount: rows.length
  };
}

export function buildUpdateStatement(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  set: Record<string, unknown>,
  where: Record<string, unknown>
): WriteStatement {
  assertWritePayloadWithinLimit({ set, where });
  const setEntries = objectEntries(set, 'set', MAX_COLUMNS);
  const params: unknown[] = [];
  const assignments = setEntries.map(([column, value]) => {
    params.push(value);
    return `${quoteWriteIdentifier(column, connection.dialect)} = ${placeholder(connection.dialect, params.length)}`;
  });
  const whereSql = buildWhere(connection.dialect, where, params);

  return {
    sql: `UPDATE ${qualifiedTable(connection, schema, table)} SET ${assignments.join(', ')} WHERE ${whereSql}`,
    params
  };
}

export function buildDeleteStatement(
  connection: EffectiveWriteConnection,
  schema: string | undefined,
  table: string,
  where: Record<string, unknown>
): WriteStatement {
  assertWritePayloadWithinLimit(where);
  const params: unknown[] = [];
  const whereSql = buildWhere(connection.dialect, where, params);
  return {
    sql: `DELETE FROM ${qualifiedTable(connection, schema, table)} WHERE ${whereSql}`,
    params
  };
}
