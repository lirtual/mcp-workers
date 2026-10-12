import { Client } from 'pg';
import { mapDatabaseError, PublicError } from '../errors.js';
import { assertJsonWithinBytes, boundQueryResult, jsonSafe } from '../result.js';
import { guardReadQuery, toReadLimitedSql } from '../sql/guard.js';
import type {
  EffectiveConnection,
  HealthResult,
  QueryColumn,
  QueryResult,
  SchemaInspection
} from '../types.js';
import { withTimeout } from './timeout.js';

function createClient(connection: EffectiveConnection): Client {
  return new Client({
    connectionString: connection.connectionString,
    ...(connection.transport === 'direct' ? { ssl: false } : {}),
    statement_timeout: connection.limits.queryTimeoutMs,
    query_timeout: connection.limits.queryTimeoutMs,
    connectionTimeoutMillis: Math.min(connection.limits.queryTimeoutMs, 5_000),
    application_name: 'cloudflare-database-mcp'
  });
}

async function withClient<T>(connection: EffectiveConnection, operation: (client: Client) => Promise<T>): Promise<T> {
  const client = createClient(connection);
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

export async function postgresQueryRead(
  connection: EffectiveConnection,
  sql: string,
  params: unknown[],
  rowLimit: number
): Promise<QueryResult> {
  const guarded = guardReadQuery(sql, 'postgres');
  const limitedSql = toReadLimitedSql(guarded.sql, 'postgres', rowLimit + 1);

  return withClient(connection, async client => {
    const result = await withTimeout(
      client.query({ text: limitedSql, values: params, rowMode: 'array' }),
      connection.limits.queryTimeoutMs,
      () => void client.end().catch(() => undefined)
    );
    const columns: QueryColumn[] = result.fields.map(field => ({
      name: field.name,
      type: String(field.dataTypeID)
    }));
    return boundQueryResult(columns, result.rows as unknown[][], rowLimit, connection.limits.maxResultBytes);
  });
}

export async function postgresExplain(
  connection: EffectiveConnection,
  sql: string,
  params: unknown[]
): Promise<unknown> {
  const guarded = guardReadQuery(sql, 'postgres');
  const explainSql = `EXPLAIN (FORMAT JSON, ANALYZE FALSE, VERBOSE FALSE, COSTS TRUE) ${guarded.sql}`;
  return withClient(connection, async client => {
    const result = await withTimeout(
      client.query({ text: explainSql, values: params, rowMode: 'array' }),
      connection.limits.queryTimeoutMs,
      () => void client.end().catch(() => undefined)
    );
    const value = jsonSafe((result.rows as unknown[][])[0]?.[0] ?? null);
    assertJsonWithinBytes(value, connection.limits.maxResultBytes);
    return value;
  });
}

export async function postgresHealthCheck(connection: EffectiveConnection): Promise<HealthResult> {
  const started = performance.now();
  await withClient(connection, async client => {
    await withTimeout(client.query('SELECT 1'), connection.limits.queryTimeoutMs, () => {
      void client.end().catch(() => undefined);
    });
  });
  return { ok: true, latencyMs: Math.round(performance.now() - started) };
}

interface PgColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: unknown;
  ordinal_position: number;
}

interface PgConstraintRow {
  constraint_name: string;
  constraint_type: string;
  column_name: string;
  ordinal_position: number;
  foreign_table_schema: string | null;
  foreign_table_name: string | null;
  foreign_column_name: string | null;
}

interface PgIndexRow {
  indexname: string;
  indexdef: string;
}

export async function postgresInspectSchema(
  connection: EffectiveConnection,
  schema?: string,
  table?: string
): Promise<SchemaInspection> {
  return withClient(connection, async client => {
    if (table !== undefined) {
      const selectedSchema = schema ?? connection.config.defaultSchema ?? 'public';
      const [columnsResult, constraintsResult, indexesResult] = await Promise.all([
        client.query<PgColumnRow>(
          `SELECT column_name, data_type, is_nullable, column_default, ordinal_position
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [selectedSchema, table]
        ),
        client.query<PgConstraintRow>(
          `SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, kcu.ordinal_position,
                  ref_kcu.table_schema AS foreign_table_schema,
                  ref_kcu.table_name AS foreign_table_name,
                  ref_kcu.column_name AS foreign_column_name
           FROM information_schema.table_constraints tc
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
           WHERE tc.table_schema = $1 AND tc.table_name = $2
             AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
           ORDER BY tc.constraint_name, kcu.ordinal_position`,
          [selectedSchema, table]
        ),
        client.query<PgIndexRow>(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = $1 AND tablename = $2
           ORDER BY indexname`,
          [selectedSchema, table]
        )
      ]);

      if (columnsResult.rows.length === 0) {
        throw new PublicError('ACCESS_DENIED', 'The requested table is unavailable or not visible to the read account.');
      }

      const inspection: SchemaInspection = {
        dialect: 'postgres',
        schema: selectedSchema,
        table,
        columns: columnsResult.rows.map(row => ({
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          defaultValue: jsonSafe(row.column_default),
          ordinalPosition: Number(row.ordinal_position)
        })),
        primaryKeys: constraintsResult.rows
          .filter(row => row.constraint_type === 'PRIMARY KEY')
          .map(row => ({
            constraintName: row.constraint_name,
            column: row.column_name,
            ordinalPosition: Number(row.ordinal_position)
          })),
        foreignKeys: constraintsResult.rows
          .filter(
            row =>
              row.constraint_type === 'FOREIGN KEY' &&
              row.foreign_table_name !== null &&
              row.foreign_column_name !== null
          )
          .map(row => ({
            constraintName: row.constraint_name,
            column: row.column_name,
            ...(row.foreign_table_schema !== null ? { referencedSchema: row.foreign_table_schema } : {}),
            referencedTable: row.foreign_table_name!,
            referencedColumn: row.foreign_column_name!,
            ordinalPosition: Number(row.ordinal_position)
          })),
        indexes: indexesResult.rows.map(row => ({
          name: row.indexname,
          unique: /CREATE\s+UNIQUE\s+INDEX/i.test(row.indexdef),
          definition: row.indexdef
        }))
      };
      assertJsonWithinBytes(inspection, connection.limits.maxSchemaBytes);
      return inspection;
    }

    if (schema !== undefined) {
      const tablesResult = await client.query<{ table_schema: string; table_name: string; table_type: string }>(
        `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_type, table_name`,
        [schema]
      );
      const inspection: SchemaInspection = {
        dialect: 'postgres',
        schema,
        tables: tablesResult.rows.map(row => ({
          schema: row.table_schema,
          name: row.table_name,
          type: row.table_type
        }))
      };
      assertJsonWithinBytes(inspection, connection.limits.maxSchemaBytes);
      return inspection;
    }

    const schemasResult = await client.query<{ name: string }>(
      `SELECT n.nspname AS name
       FROM pg_catalog.pg_namespace n
       WHERE n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
         AND n.nspname <> 'information_schema'
         AND has_schema_privilege(n.nspname, 'USAGE')
       ORDER BY n.nspname`
    );
    const inspection: SchemaInspection = {
      dialect: 'postgres',
      schemas: schemasResult.rows.map(row => row.name)
    };
    assertJsonWithinBytes(inspection, connection.limits.maxSchemaBytes);
    return inspection;
  });
}
