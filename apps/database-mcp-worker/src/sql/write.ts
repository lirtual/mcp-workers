import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';

export const MAX_WRITE_PAYLOAD_BYTES = 256 * 1024;
const MAX_COLUMNS = 100;
const MAX_PREDICATE_COLUMNS = 20;
const MAX_IN_VALUES = 100;
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/;

export interface BuiltWriteStatement {
  sql: string;
  params: unknown[];
}

function invalid(message: string): never {
  throw new PublicError('INVALID_INPUT', message);
}

export function quoteIdentifier(identifier: string, dialect: Dialect): string {
  if (
    typeof identifier !== 'string' ||
    identifier.length === 0 ||
    identifier.length > 128 ||
    CONTROL_CHARACTER_RE.test(identifier)
  ) {
    invalid('SQL identifiers must contain 1 to 128 non-control characters.');
  }
  return dialect === 'postgres'
    ? `"${identifier.replaceAll('"', '""')}"`
    : `\`${identifier.replaceAll('`', '``')}\``;
}

function qualifiedTable(dialect: Dialect, schema: string | undefined, table: string): string {
  const quotedTable = quoteIdentifier(table, dialect);
  return schema === undefined ? quotedTable : `${quoteIdentifier(schema, dialect)}.${quotedTable}`;
}

function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?';
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectKeysWithinLimit(value: Record<string, unknown>, label: string, max: number): string[] {
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > max) {
    invalid(`${label} must contain 1 to ${max} columns.`);
  }
  for (const key of keys) quoteIdentifier(key, 'postgres');
  return keys;
}

function isPredicateScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function pushEquality(
  dialect: Dialect,
  quotedColumn: string,
  value: unknown,
  params: unknown[]
): string {
  if (!isPredicateScalar(value)) {
    invalid('Equality predicates require a non-null scalar value; use isNull for null checks.');
  }
  params.push(value);
  return `${quotedColumn} = ${placeholder(dialect, params.length)}`;
}

function buildPredicate(
  dialect: Dialect,
  column: string,
  predicate: unknown,
  params: unknown[]
): string {
  const quotedColumn = quoteIdentifier(column, dialect);
  if (isPredicateScalar(predicate)) return pushEquality(dialect, quotedColumn, predicate, params);
  if (predicate === null || Array.isArray(predicate) || typeof predicate !== 'object') {
    invalid('Predicates must be scalar equality or exactly one supported operator object.');
  }

  const object = predicate as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 1) invalid('Each predicate column must use exactly one operator.');
  const operator = keys[0]!;

  if (operator === 'eq') return pushEquality(dialect, quotedColumn, object.eq, params);

  if (operator === 'in') {
    const values = object.in;
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_IN_VALUES) {
      invalid(`Membership predicates must contain 1 to ${MAX_IN_VALUES} values.`);
    }
    const placeholders = values.map(value => {
      if (!isPredicateScalar(value)) {
        invalid('Membership predicates accept only non-null scalar values.');
      }
      params.push(value);
      return placeholder(dialect, params.length);
    });
    return `${quotedColumn} IN (${placeholders.join(', ')})`;
  }

  if (operator === 'isNull') {
    if (typeof object.isNull !== 'boolean') invalid('isNull predicates require a boolean value.');
    return `${quotedColumn} IS ${object.isNull ? '' : 'NOT '}NULL`;
  }

  invalid(`Unsupported predicate operator '${operator}'.`);
}

function buildWhere(dialect: Dialect, whereValue: unknown, params: unknown[]): string {
  const where = plainRecord(whereValue, 'where');
  const columns = objectKeysWithinLimit(where, 'where', MAX_PREDICATE_COLUMNS);
  return columns.map(column => buildPredicate(dialect, column, where[column], params)).join(' AND ');
}

export function assertWritePayloadWithinLimit(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid('Write payload must be JSON serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_WRITE_PAYLOAD_BYTES) {
    invalid(`Write payload exceeds the ${MAX_WRITE_PAYLOAD_BYTES}-byte limit.`);
  }
}

export function buildInsertStatement(
  dialect: Dialect,
  schema: string | undefined,
  table: string,
  rowsValue: unknown
): BuiltWriteStatement {
  if (!Array.isArray(rowsValue) || rowsValue.length === 0 || rowsValue.length > 100) {
    invalid('rows must contain 1 to 100 objects.');
  }

  const first = plainRecord(rowsValue[0], 'Each insert row');
  const columns = objectKeysWithinLimit(first, 'Each insert row', MAX_COLUMNS);
  const expected = [...columns].sort();
  const params: unknown[] = [];
  const tuples: string[] = [];

  for (const rawRow of rowsValue) {
    const row = plainRecord(rawRow, 'Each insert row');
    const keys = objectKeysWithinLimit(row, 'Each insert row', MAX_COLUMNS);
    const actual = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      invalid('All insert rows must have exactly the same column set.');
    }

    const tuple = columns.map(column => {
      params.push(row[column]);
      return placeholder(dialect, params.length);
    });
    tuples.push(`(${tuple.join(', ')})`);
  }

  return {
    sql: `INSERT INTO ${qualifiedTable(dialect, schema, table)} (${columns
      .map(column => quoteIdentifier(column, dialect))
      .join(', ')}) VALUES ${tuples.join(', ')}`,
    params
  };
}

export function buildUpdateStatement(
  dialect: Dialect,
  schema: string | undefined,
  table: string,
  setValue: unknown,
  whereValue: unknown
): BuiltWriteStatement {
  const set = plainRecord(setValue, 'set');
  const columns = objectKeysWithinLimit(set, 'set', MAX_COLUMNS);
  const params: unknown[] = [];
  const assignments = columns.map(column => {
    params.push(set[column]);
    return `${quoteIdentifier(column, dialect)} = ${placeholder(dialect, params.length)}`;
  });
  const where = buildWhere(dialect, whereValue, params);
  return {
    sql: `UPDATE ${qualifiedTable(dialect, schema, table)} SET ${assignments.join(', ')} WHERE ${where}`,
    params
  };
}

export function buildDeleteStatement(
  dialect: Dialect,
  schema: string | undefined,
  table: string,
  whereValue: unknown
): BuiltWriteStatement {
  const params: unknown[] = [];
  const where = buildWhere(dialect, whereValue, params);
  return {
    sql: `DELETE FROM ${qualifiedTable(dialect, schema, table)} WHERE ${where}`,
    params
  };
}
