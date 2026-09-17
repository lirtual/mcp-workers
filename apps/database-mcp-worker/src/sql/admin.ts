import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';

export interface BuiltAdminStatement {
  sql: string;
  operation: string;
}

export type AdminColumnType =
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'decimal'
  | 'varchar'
  | 'text'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'datetime'
  | 'json';

export interface AdminColumnDefinition {
  name: string;
  type: AdminColumnType;
  length?: number | undefined;
  precision?: number | undefined;
  scale?: number | undefined;
  nullable?: boolean | undefined;
  default?: string | number | boolean | null | undefined;
  primaryKey?: boolean | undefined;
  unique?: boolean | undefined;
}

const IDENTIFIER_RE = /^[^\0]+$/;

function identifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !IDENTIFIER_RE.test(value)) {
    throw new PublicError('INVALID_INPUT', `Invalid ${field}.`);
  }
  return value;
}

function quoteIdentifier(dialect: Dialect, value: string): string {
  const checked = identifier(value, 'database identifier');
  return dialect === 'postgres' ? `"${checked.replaceAll('"', '""')}"` : `\`${checked.replaceAll('`', '``')}\``;
}

function qualified(dialect: Dialect, schema: string, table: string): string {
  return `${quoteIdentifier(dialect, schema)}.${quoteIdentifier(dialect, table)}`;
}

function positiveBoundedInteger(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new PublicError('INVALID_INPUT', `Invalid ${field}.`);
  }
  return value;
}

function boundedScale(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 30) {
    throw new PublicError('INVALID_INPUT', 'Invalid numeric scale.');
  }
  return value;
}

function renderType(dialect: Dialect, column: AdminColumnDefinition): string {
  switch (column.type) {
    case 'integer':
      return 'INTEGER';
    case 'bigint':
      return 'BIGINT';
    case 'text':
      return 'TEXT';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'timestamp':
      return 'TIMESTAMP';
    case 'datetime':
      return dialect === 'postgres' ? 'TIMESTAMP' : 'DATETIME';
    case 'json':
      return dialect === 'postgres' ? 'JSONB' : 'JSON';
    case 'varchar': {
      const length = positiveBoundedInteger(column.length, 'varchar length', 65_535);
      if (length === undefined) throw new PublicError('INVALID_INPUT', 'varchar requires length.');
      return `VARCHAR(${length})`;
    }
    case 'numeric':
    case 'decimal': {
      const precision = positiveBoundedInteger(column.precision, 'numeric precision', 65);
      const scale = boundedScale(column.scale);
      if (precision === undefined && scale !== undefined) {
        throw new PublicError('INVALID_INPUT', 'numeric scale requires precision.');
      }
      if (precision !== undefined && scale !== undefined && scale > precision) {
        throw new PublicError('INVALID_INPUT', 'numeric scale cannot exceed precision.');
      }
      return precision === undefined
        ? column.type.toUpperCase()
        : `${column.type.toUpperCase()}(${precision}${scale === undefined ? '' : `,${scale}`})`;
    }
  }
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderDefault(dialect: Dialect, value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return quoteString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PublicError('INVALID_INPUT', 'Column default number must be finite.');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  throw new PublicError('INVALID_INPUT', 'Unsupported column default value.');
}

function renderColumn(dialect: Dialect, column: AdminColumnDefinition): string {
  identifier(column.name, 'column name');
  if (column.length !== undefined && column.type !== 'varchar') {
    throw new PublicError('INVALID_INPUT', 'length is only supported for varchar columns.');
  }
  if ((column.precision !== undefined || column.scale !== undefined) && column.type !== 'numeric' && column.type !== 'decimal') {
    throw new PublicError('INVALID_INPUT', 'precision/scale are only supported for numeric/decimal columns.');
  }
  const parts = [quoteIdentifier(dialect, column.name), renderType(dialect, column)];
  if (column.nullable === false || column.primaryKey === true) parts.push('NOT NULL');
  if (column.default !== undefined) parts.push(`DEFAULT ${renderDefault(dialect, column.default)}`);
  if (column.primaryKey === true) parts.push('PRIMARY KEY');
  if (column.unique === true) parts.push('UNIQUE');
  return parts.join(' ');
}

function requireColumns(columns: AdminColumnDefinition[]): AdminColumnDefinition[] {
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 100) {
    throw new PublicError('INVALID_INPUT', 'columns must contain 1 to 100 column definitions.');
  }
  const names = new Set<string>();
  for (const column of columns) {
    if (typeof column !== 'object' || column === null) throw new PublicError('INVALID_INPUT', 'Invalid column definition.');
    identifier(column.name, 'column name');
    if (names.has(column.name)) throw new PublicError('INVALID_INPUT', 'Duplicate column name.');
    names.add(column.name);
  }
  return columns;
}

export function buildCreateTableStatement(
  dialect: Dialect,
  schema: string,
  table: string,
  columns: AdminColumnDefinition[]
): BuiltAdminStatement {
  requireColumns(columns);
  return {
    operation: 'create_table',
    sql: `CREATE TABLE ${qualified(dialect, schema, table)} (${columns.map(column => renderColumn(dialect, column)).join(', ')})`
  };
}

export type AlterTableOperation =
  | { action: 'add_column'; column: AdminColumnDefinition }
  | { action: 'drop_column'; column: string }
  | { action: 'rename_column'; column: string; newName: string }
  | { action: 'rename_table'; newName: string };

export function buildAlterTableStatement(
  dialect: Dialect,
  schema: string,
  table: string,
  operation: AlterTableOperation
): BuiltAdminStatement {
  const target = qualified(dialect, schema, table);
  switch (operation.action) {
    case 'add_column':
      return { operation: 'alter_table_add_column', sql: `ALTER TABLE ${target} ADD COLUMN ${renderColumn(dialect, operation.column)}` };
    case 'drop_column':
      return {
        operation: 'alter_table_drop_column',
        sql: `ALTER TABLE ${target} DROP COLUMN ${quoteIdentifier(dialect, operation.column)}`
      };
    case 'rename_column':
      return {
        operation: 'alter_table_rename_column',
        sql: `ALTER TABLE ${target} RENAME COLUMN ${quoteIdentifier(dialect, operation.column)} TO ${quoteIdentifier(dialect, operation.newName)}`
      };
    case 'rename_table':
      return dialect === 'postgres'
        ? {
            operation: 'alter_table_rename_table',
            sql: `ALTER TABLE ${target} RENAME TO ${quoteIdentifier(dialect, operation.newName)}`
          }
        : {
            operation: 'alter_table_rename_table',
            sql: `RENAME TABLE ${target} TO ${qualified(dialect, schema, operation.newName)}`
          };
  }
}

function generatedIndexName(table: string, columns: string[], unique: boolean): string {
  const raw = `${table}_${columns.join('_')}_${unique ? 'uniq' : 'idx'}`.replace(/[^A-Za-z0-9_]/g, '_');
  return raw.slice(0, 60) || 'mcp_index';
}

export function buildCreateIndexStatement(
  dialect: Dialect,
  schema: string,
  table: string,
  columns: string[],
  unique = false,
  name?: string
): BuiltAdminStatement {
  if (!Array.isArray(columns) || columns.length < 1 || columns.length > 16) {
    throw new PublicError('INVALID_INPUT', 'index columns must contain 1 to 16 columns.');
  }
  const checkedColumns = columns.map(column => quoteIdentifier(dialect, column));
  const indexName = name ?? generatedIndexName(table, columns, unique);
  identifier(indexName, 'index name');
  return {
    operation: 'create_index',
    sql: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(dialect, indexName)} ON ${qualified(dialect, schema, table)} (${checkedColumns.join(', ')})`
  };
}

export function buildDropIndexStatement(
  dialect: Dialect,
  schema: string,
  table: string,
  name: string
): BuiltAdminStatement {
  identifier(name, 'index name');
  return {
    operation: 'drop_index',
    sql:
      dialect === 'postgres'
        ? `DROP INDEX ${quoteIdentifier(dialect, schema)}.${quoteIdentifier(dialect, name)}`
        : `DROP INDEX ${quoteIdentifier(dialect, name)} ON ${qualified(dialect, schema, table)}`
  };
}

export function buildDropTableStatement(dialect: Dialect, schema: string, table: string): BuiltAdminStatement {
  return { operation: 'drop_table', sql: `DROP TABLE ${qualified(dialect, schema, table)}` };
}
