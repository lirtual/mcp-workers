import { createConnection, type Connection, type FieldPacket } from 'mysql2/promise';
import { mapDatabaseError, PublicError } from '../errors.js';
import { assertJsonWithinBytes, boundQueryResult, jsonSafe } from '../result.js';
import { guardReadQuery, injectMySqlExecutionTimeout, toReadLimitedSql } from '../sql/guard.js';
import type {
  EffectiveConnection,
  HealthResult,
  QueryColumn,
  QueryResult,
  SchemaInspection
} from '../types.js';
import { withTimeout } from './timeout.js';

async function createMysqlConnection(connection: EffectiveConnection): Promise<Connection> {
  return createConnection({
    host: connection.host,
    user: connection.user,
    password: connection.password,
    ...(connection.database.length === 0 ? {} : { database: connection.database }),
    port: connection.port,
    disableEval: true,
    rowsAsArray: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false,
    connectTimeout: Math.min(connection.limits.queryTimeoutMs, 5_000)
  });
}

async function createMysqlConnectionWithinTimeout(connection: EffectiveConnection): Promise<Connection> {
  const pendingConnection = createMysqlConnection(connection);
  const timeoutMs = Math.min(connection.limits.queryTimeoutMs, 5_000);

  return withTimeout(pendingConnection, timeoutMs, () => {
    // Promise.race does not cancel the underlying mysql2 connection attempt.
    // If it succeeds after our timeout has already been reported, immediately
    // destroy that late connection so it cannot escape the request lifecycle.
    void pendingConnection.then(
      lateClient => lateClient.destroy(),
      () => undefined
    );
  });
}

async function withConnection<T>(
  connection: EffectiveConnection,
  operation: (client: Connection) => Promise<T>
): Promise<T> {
  let client: Connection | undefined;
  try {
    client = await createMysqlConnectionWithinTimeout(connection);
    return await operation(client);
  } catch (error) {
    throw mapDatabaseError(error);
  } finally {
    if (client !== undefined) await client.end().catch(() => undefined);
  }
}

function columnsFromFields(fields: readonly FieldPacket[] | undefined): QueryColumn[] {
  if (!fields) return [];
  return fields.map(field => ({ name: field.name, type: String(field.type) }));
}

export async function mysqlQueryRead(
  connection: EffectiveConnection,
  sql: string,
  params: unknown[],
  rowLimit: number
): Promise<QueryResult> {
  const guarded = guardReadQuery(sql, 'mysql');
  const limitedSql = toReadLimitedSql(guarded.sql, 'mysql', rowLimit + 1);
  const timedSql = injectMySqlExecutionTimeout(limitedSql, connection.limits.queryTimeoutMs);

  return withConnection(connection, async client => {
    const [rows, fields] = await withTimeout(
      client.query(timedSql, params),
      connection.limits.queryTimeoutMs,
      () => client.destroy()
    );
    if (!Array.isArray(rows)) throw new PublicError('DATABASE_ERROR', 'The database returned an unexpected result shape.');
    return boundQueryResult(
      columnsFromFields(fields),
      rows as unknown[][],
      rowLimit,
      connection.limits.maxResultBytes
    );
  });
}

export async function mysqlExplain(
  connection: EffectiveConnection,
  sql: string,
  params: unknown[]
): Promise<unknown> {
  const guarded = guardReadQuery(sql, 'mysql');
  const timedSql = injectMySqlExecutionTimeout(guarded.sql, connection.limits.queryTimeoutMs);
  const explainSql = `EXPLAIN FORMAT=JSON ${timedSql}`;
  return withConnection(connection, async client => {
    const [rows] = await withTimeout(client.query(explainSql, params), connection.limits.queryTimeoutMs, () => {
      client.destroy();
    });
    const value = jsonSafe(rows);
    assertJsonWithinBytes(value, connection.limits.maxResultBytes);
    return value;
  });
}

export async function mysqlHealthCheck(connection: EffectiveConnection): Promise<HealthResult> {
  const started = performance.now();
  await withConnection(connection, async client => {
    await withTimeout(client.query('SELECT /*+ MAX_EXECUTION_TIME(2000) */ 1'), Math.min(2_000, connection.limits.queryTimeoutMs), () => {
      client.destroy();
    });
  });
  return { ok: true, latencyMs: Math.round(performance.now() - started) };
}

interface MySqlColumnRow extends Array<unknown> {
  0: string;
  1: string;
  2: string;
  3: unknown;
  4: number;
  5: string;
}

interface MySqlConstraintRow extends Array<unknown> {
  0: string;
  1: string;
  2: string;
  3: number;
  4: string | null;
  5: string | null;
  6: string | null;
}

interface MySqlIndexRow extends Array<unknown> {
  0: string;
  1: number;
  2: number;
  3: string;
  4: string;
}

function ensureMysqlSchema(connection: EffectiveConnection, requested: string | undefined): string | undefined {
  const configured = connection.database.length === 0 ? undefined : connection.database;
  if (configured !== undefined && requested !== undefined && requested !== configured) {
    throw new PublicError('ACCESS_DENIED', 'MySQL schema inspection is restricted to the configured database.');
  }
  return requested ?? configured;
}

export async function mysqlInspectSchema(
  connection: EffectiveConnection,
  schema?: string,
  table?: string
): Promise<SchemaInspection> {
  const selectedSchema = ensureMysqlSchema(connection, schema);
  return withConnection(connection, async client => {
    if (table !== undefined) {
      if (selectedSchema === undefined) {
        throw new PublicError(
          'INVALID_INPUT',
          'schema is required for MySQL table inspection when the connection URL has no default database.'
        );
      }
      const [columnRows] = await withTimeout(
        client.query(
          `SELECT /*+ MAX_EXECUTION_TIME(${connection.limits.queryTimeoutMs}) */
                  column_name, column_type, is_nullable, column_default, ordinal_position, extra
           FROM information_schema.columns
           WHERE table_schema = ? AND table_name = ?
           ORDER BY ordinal_position`,
          [selectedSchema, table]
        ),
        connection.limits.queryTimeoutMs,
        () => client.destroy()
      );
      if (!Array.isArray(columnRows) || columnRows.length === 0) {
        throw new PublicError('ACCESS_DENIED', 'The requested table is unavailable or not visible to the read account.');
      }

      const [constraintRows] = await withTimeout(
        client.query(
          `SELECT /*+ MAX_EXECUTION_TIME(${connection.limits.queryTimeoutMs}) */
                  tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position,
                  kcu.referenced_table_schema, kcu.referenced_table_name, kcu.referenced_column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_schema = kcu.constraint_schema
            AND tc.table_schema = kcu.table_schema
            AND tc.table_name = kcu.table_name
            AND tc.constraint_name = kcu.constraint_name
           WHERE tc.table_schema = ? AND tc.table_name = ?
             AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
           ORDER BY tc.constraint_name, kcu.ordinal_position`,
          [selectedSchema, table]
        ),
        connection.limits.queryTimeoutMs,
        () => client.destroy()
      );

      const [indexRows] = await withTimeout(
        client.query(
          `SELECT /*+ MAX_EXECUTION_TIME(${connection.limits.queryTimeoutMs}) */
                  index_name, non_unique, seq_in_index, column_name, index_type
           FROM information_schema.statistics
           WHERE table_schema = ? AND table_name = ?
           ORDER BY index_name, seq_in_index`,
          [selectedSchema, table]
        ),
        connection.limits.queryTimeoutMs,
        () => client.destroy()
      );

      const indexes = new Map<string, { name: string; unique: boolean; columns: string[]; type?: string }>();
      for (const row of indexRows as MySqlIndexRow[]) {
        const [name, nonUnique, , column, type] = row;
        const current = indexes.get(name) ?? { name, unique: Number(nonUnique) === 0, columns: [], type };
        current.columns.push(column);
        indexes.set(name, current);
      }

      const inspection: SchemaInspection = {
        dialect: 'mysql',
        schema: selectedSchema,
        table,
        columns: (columnRows as MySqlColumnRow[]).map(row => ({
          name: row[0],
          dataType: row[1],
          nullable: row[2] === 'YES',
          defaultValue: jsonSafe(row[3]),
          ordinalPosition: Number(row[4]),
          extra: row[5]
        })),
        primaryKeys: (constraintRows as MySqlConstraintRow[])
          .filter(row => row[1] === 'PRIMARY KEY')
          .map(row => ({ constraintName: row[0], column: row[2], ordinalPosition: Number(row[3]) })),
        foreignKeys: (constraintRows as MySqlConstraintRow[])
          .filter(row => row[1] === 'FOREIGN KEY' && row[5] !== null && row[6] !== null)
          .map(row => ({
            constraintName: row[0],
            column: row[2],
            ...(row[4] !== null ? { referencedSchema: row[4] } : {}),
            referencedTable: row[5]!,
            referencedColumn: row[6]!,
            ordinalPosition: Number(row[3])
          })),
        indexes: [...indexes.values()]
      };
      assertJsonWithinBytes(inspection, connection.limits.maxSchemaBytes);
      return inspection;
    }

    if (schema !== undefined) {
      const [rows] = await withTimeout(
        client.query(
          `SELECT /*+ MAX_EXECUTION_TIME(${connection.limits.queryTimeoutMs}) */
                  table_schema, table_name, table_type
           FROM information_schema.tables
           WHERE table_schema = ?
           ORDER BY table_type, table_name`,
          [selectedSchema]
        ),
        connection.limits.queryTimeoutMs,
        () => client.destroy()
      );
      const inspection: SchemaInspection = {
        dialect: 'mysql',
        schema: selectedSchema,
        tables: (rows as unknown[][]).map(row => ({
          schema: String(row[0]),
          name: String(row[1]),
          type: String(row[2])
        }))
      };
      assertJsonWithinBytes(inspection, connection.limits.maxSchemaBytes);
      return inspection;
    }

    if (selectedSchema !== undefined) {
      const inspection: SchemaInspection = { dialect: 'mysql', schemas: [selectedSchema] };
      assertJsonWithinBytes(inspection, connection.limits.maxSchemaBytes);
      return inspection;
    }

    const [rows] = await withTimeout(
      client.query(
        `SELECT /*+ MAX_EXECUTION_TIME(${connection.limits.queryTimeoutMs}) */ schema_name
         FROM information_schema.schemata
         ORDER BY schema_name`
      ),
      connection.limits.queryTimeoutMs,
      () => client.destroy()
    );
    const inspection: SchemaInspection = {
      dialect: 'mysql',
      schemas: (rows as unknown[][]).map(row => String(row[0]))
    };
    assertJsonWithinBytes(inspection, connection.limits.maxSchemaBytes);
    return inspection;
  });
}