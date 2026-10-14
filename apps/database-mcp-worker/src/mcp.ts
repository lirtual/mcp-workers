import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveAdminConnection } from './admin-config.js';
import { resolveConnection, resolveConnectionDialect, resolveWriteConnection } from './config.js';
import {
  alterTable,
  createIndex,
  createTable,
  deleteRows,
  dropIndex,
  dropTable,
  explainRead,
  healthCheck,
  insertRows,
  inspectSchema,
  queryRead,
  updateRows
} from './db/index.js';
import { getSchemaContext } from './db/schema-context.js';
import { PublicError, toPublicError } from './errors.js';
import { emitLog, principalLogId, sqlLogFields } from './logging.js';
import { clampRequestedLimit, jsonSafe } from './result.js';
import type { ConnectionConfig, Env } from './types.js';

interface ToolContextLike {
  http?: {
    authInfo?: {
      clientId: string;
      scopes: string[];
    };
  };
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

function success(data: unknown): ToolResult {
  const safe = jsonSafe(data);
  return {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe
  };
}

function failure(error: PublicError): ToolResult {
  const body = { error: { code: error.code, message: error.message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true
  };
}

function principal(ctx: ToolContextLike): string {
  const id = ctx.http?.authInfo?.clientId;
  if (!id) throw new PublicError('AUTH_REQUIRED', 'Authenticated caller identity is required.');
  return id;
}

async function enforceRateLimit(env: Env, principalId: string, connectionId: string): Promise<void> {
  const principalKey = await principalLogId(principalId);
  const { success: allowed } = await env.RATE_LIMITER.limit({ key: `${principalKey}:${connectionId}` });
  if (!allowed) throw new PublicError('RATE_LIMITED', 'Rate limit exceeded for this connection.');
}

interface ToolRunOptions<T> {
  env: Env;
  ctx: ToolContextLike;
  tool: string;
  connectionId?: string | undefined;
  sql?: string;
  run: () => Promise<T>;
  summarize?: (value: T) => Record<string, unknown>;
}

async function runTool<T>(options: ToolRunOptions<T>): Promise<ToolResult> {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  let principalId = 'unknown';
  try {
    principalId = principal(options.ctx);
    await enforceRateLimit(options.env, principalId, options.connectionId ?? '__catalog__');
    const value = await options.run();
    const sqlFields = options.sql ? await sqlLogFields(options.sql) : {};
    emitLog({
      event: 'mcp_tool',
      requestId,
      principal: await principalLogId(principalId),
      tool: options.tool,
      connection: options.connectionId,
      durationMs: Math.round(performance.now() - started),
      success: true,
      ...sqlFields,
      ...(options.summarize?.(value) ?? {})
    });
    return success(value);
  } catch (unknownError) {
    const error = toPublicError(unknownError);
    const sqlFields = options.sql ? await sqlLogFields(options.sql) : {};
    emitLog({
      event: 'mcp_tool',
      requestId,
      principal: principalId === 'unknown' ? 'unknown' : await principalLogId(principalId),
      tool: options.tool,
      connection: options.connectionId,
      durationMs: Math.round(performance.now() - started),
      success: false,
      errorCode: error.code,
      ...sqlFields
    });
    return failure(error);
  }
}

const connectionIdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const sqlSchema = z.string().min(1).max(100_000);
const paramsSchema = z.array(z.unknown()).max(100).default([]);
const databaseIdentifierSchema = z.string().min(1).max(128);
const predicateScalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const predicateSchema = z.union([
  predicateScalarSchema,
  z.object({ eq: predicateScalarSchema }).strict(),
  z.object({ in: z.array(predicateScalarSchema).min(1).max(100) }).strict(),
  z.object({ isNull: z.boolean() }).strict()
]);
const writeRecordSchema = z
  .record(databaseIdentifierSchema, z.unknown())
  .refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 100, {
    message: 'Write objects must contain 1 to 100 columns.'
  });
const whereSchema = z
  .record(databaseIdentifierSchema, predicateSchema)
  .refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 20, {
    message: 'where must contain 1 to 20 predicate columns.'
  });

const adminColumnTypeSchema = z.enum([
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'varchar',
  'text',
  'boolean',
  'date',
  'timestamp',
  'datetime',
  'json'
]);
const adminDefaultSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const adminColumnSchema = z
  .object({
    name: databaseIdentifierSchema,
    type: adminColumnTypeSchema,
    length: z.number().int().positive().max(65_535).optional(),
    precision: z.number().int().positive().max(65).optional(),
    scale: z.number().int().min(0).max(30).optional(),
    nullable: z.boolean().optional(),
    default: adminDefaultSchema.optional(),
    primaryKey: z.boolean().optional(),
    unique: z.boolean().optional()
  })
  .strict();
const alterOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_column'), column: adminColumnSchema }).strict(),
  z.object({ action: z.literal('drop_column'), column: databaseIdentifierSchema }).strict(),
  z
    .object({ action: z.literal('rename_column'), column: databaseIdentifierSchema, newName: databaseIdentifierSchema })
    .strict(),
  z.object({ action: z.literal('rename_table'), newName: databaseIdentifierSchema }).strict()
]);

export function buildMcpServer(env: Env, catalog: ConnectionConfig[]): McpServer {
  const server = new McpServer(
    { name: 'database-mcp-worker', version: '0.3.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Database access with bounded reads and structured writes/DDL. Each named connection uses one database principal; database grants control its permissions. Omit connection only when one connection is configured; specify an id when multiple connections exist. No tool accepts arbitrary write/admin SQL.'
    }
  );

  server.registerTool(
    'list_connections',
    {
      description: 'List configured logical connection ids, dialects, and transports.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (_args, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'list_connections',
        run: async () => ({
          connections: catalog.map(connection => ({
            id: connection.id,
            dialect: resolveConnectionDialect(env, connection),
            transport: connection.transport,
          }))
        }),
        summarize: value => ({ connectionCount: value.connections.length })
      })
  );

  server.registerTool(
    'inspect_schema',
    {
      description:
        'Inspect schemas, tables/views, or one table\'s columns, keys, foreign keys, and indexes. No routine source code is returned.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema.optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'inspect_schema',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => {
          const resolved = resolveConnection(env, catalog, connection);
          return inspectSchema(resolved, schema, table);
        }
      })
  );

  server.registerTool(
    'get_schema_context',
    {
      description:
        'Return compact, token-efficient schema context for up to 100 tables: columns, primary keys, and foreign-key relationships. Use inspect_schema for detailed indexes and defaults.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        tableLimit: z.number().int().min(1).max(100).default(50)
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ connection, schema, tableLimit }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'get_schema_context',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => getSchemaContext(resolveConnection(env, catalog, connection), schema, tableLimit),
        summarize: value => ({
          tableCount: value.tableCount,
          totalTables: value.totalTables,
          truncated: value.truncated
        })
      })
  );

  server.registerTool(
    'query_read',
    {
      description:
        'Execute exactly one bounded read query using the configured database principal; database grants determine whether the requested read succeeds. Writes, locking reads, multi-statements, and dangerous MySQL read side effects are rejected.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        sql: sqlSchema,
        params: paramsSchema,
        rowLimit: z.number().int().positive().max(5_000).optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ connection, sql, params, rowLimit }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'query_read',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        sql,
        run: async () => {
          const resolved = resolveConnection(env, catalog, connection);
          const effectiveLimit = clampRequestedLimit(rowLimit, resolved.limits.maxRows);
          return queryRead(resolved, sql, params, effectiveLimit);
        },
        summarize: value => ({ rowCount: value.rowCount, truncated: value.truncated, truncationReason: value.truncationReason })
      })
  );

  server.registerTool(
    'explain',
    {
      description: 'Return a non-ANALYZE execution plan for one read query. The underlying statement is not intentionally executed.',
      inputSchema: z.object({ connection: connectionIdSchema.optional(), sql: sqlSchema, params: paramsSchema }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ connection, sql, params }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'explain',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        sql,
        run: async () => explainRead(resolveConnection(env, catalog, connection), sql, params)
      })
  );

  server.registerTool(
    'health_check',
    {
      description: 'Check whether one logical connection can establish a usable read path without exposing network details.',
      inputSchema: z.object({ connection: connectionIdSchema.optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ connection }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'health_check',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => {
          const resolved = resolveConnection(env, catalog, connection);
          const health = await healthCheck(resolved);
          return { connection: resolved.config.id, dialect: resolved.dialect, transport: resolved.transport, ...health };
        },
        summarize: value => ({ latencyMs: value.latencyMs })
      })
  );

  server.registerTool(
    'insert_rows',
    {
      description:
        'Insert 1 to 100 rows into one table using a configured database principal and internally parameterized SQL. Raw SQL, UPSERT, and client-supplied RETURNING expressions are not accepted.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        rows: z.array(writeRecordSchema).min(1).max(100)
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ connection, schema, table, rows }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'insert_rows',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => insertRows(resolveWriteConnection(env, catalog, connection), schema, table, rows),
        summarize: value => ({ affectedRows: value.affectedRows })
      })
  );

  server.registerTool(
    'update_rows',
    {
      description:
        'Update targeted rows through structured AND-only eq/in/isNull predicates. The mutation is rolled back when its affected-row count exceeds the configured safety limit.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        set: writeRecordSchema,
        where: whereSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table, set, where }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'update_rows',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => updateRows(resolveWriteConnection(env, catalog, connection), schema, table, set, where),
        summarize: value => ({ affectedRows: value.affectedRows })
      })
  );

  server.registerTool(
    'delete_rows',
    {
      description:
        'Delete targeted rows through structured AND-only eq/in/isNull predicates. The mutation is rolled back when its affected-row count exceeds the configured safety limit.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        where: whereSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table, where }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'delete_rows',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => deleteRows(resolveWriteConnection(env, catalog, connection), schema, table, where),
        summarize: value => ({ affectedRows: value.affectedRows })
      })
  );

  server.registerTool(
    'create_table',
    {
      description:
        'Create one table through a bounded structured column definition using the configured database principal. Arbitrary type strings, defaults, constraints, and raw DDL are rejected.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        columns: z.array(adminColumnSchema).min(1).max(100)
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ connection, schema, table, columns }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'create_table',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => createTable(resolveAdminConnection(env, catalog, connection), schema, table, columns),
        summarize: value => ({ adminOperation: value.operation })
      })
  );

  server.registerTool(
    'alter_table',
    {
      description:
        'Perform one structured table alteration with the configured database principal: add/drop/rename a column or rename the table. Dropping a column changes schema and may destroy data.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        operation: alterOperationSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table, operation }, ctx) => {
      return runTool({
        env,
        ctx,
        tool: 'alter_table',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => alterTable(resolveAdminConnection(env, catalog, connection), schema, table, operation),
        summarize: value => ({ adminOperation: value.operation })
      });
    }
  );

  server.registerTool(
    'create_index',
    {
      description:
        'Create a simple column index through structured input using the configured database principal. Expression, partial, fulltext, spatial, and operator-class indexes are not accepted.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        columns: z.array(databaseIdentifierSchema).min(1).max(16),
        unique: z.boolean().default(false),
        name: databaseIdentifierSchema.optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false }
    },
    async ({ connection, schema, table, columns, unique, name }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'create_index',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => createIndex(resolveAdminConnection(env, catalog, connection), schema, table, columns, unique, name),
        summarize: value => ({ adminOperation: value.operation })
      })
  );

  server.registerTool(
    'drop_index',
    {
      description:
        'Drop one explicitly named index using the configured database principal. Schema change; never automatically retried.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        name: databaseIdentifierSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table, name }, ctx) => {
      return runTool({
        env,
        ctx,
        tool: 'drop_index',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => dropIndex(resolveAdminConnection(env, catalog, connection), schema, table, name),
        summarize: value => ({ adminOperation: value.operation })
      });
    }
  );

  server.registerTool(
    'drop_table',
    {
      description:
        'Drop one explicitly named table using the configured database principal. Schema change; never automatically retried.',
      inputSchema: z.object({
        connection: connectionIdSchema.optional(),
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table }, ctx) => {
      return runTool({
        env,
        ctx,
        tool: 'drop_table',
        connectionId: connection ?? (catalog.length === 1 ? catalog[0]?.id : undefined),
        run: async () => dropTable(resolveAdminConnection(env, catalog, connection), schema, table),
        summarize: value => ({ adminOperation: value.operation })
      });
    }
  );

  return server;
}
