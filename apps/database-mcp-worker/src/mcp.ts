import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { adminConfirmation } from './admin-confirmation.js';
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
  connectionId?: string;
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

function confirmationFailure(message: string): ToolResult {
  return failure(new PublicError('ADMIN_CONFIRMATION_REQUIRED', message));
}

export function buildMcpServer(env: Env, catalog: ConnectionConfig[]): McpServer {
  const server = new McpServer(
    { name: 'database-mcp-worker', version: '0.3.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Database access with bounded reads, optional structured Safe Write, and optional structured Safe Admin/DDL. READ, WRITE, and ADMIN credentials are separate. No tool accepts arbitrary write/admin SQL. Destructive DDL requires MCP protocol-level user confirmation.'
    }
  );

  server.registerTool(
    'list_connections',
    {
      description: 'List statically configured logical database connections and non-secret read/write/admin capabilities.',
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
            displayName: connection.displayName,
            dialect: resolveConnectionDialect(env, connection),
            transport: connection.transport,
            enabled: connection.enabled,
            writeEnabled: connection.write !== undefined,
            ...(connection.write ? { writeTransport: connection.write.transport } : {}),
            adminEnabled: connection.admin !== undefined,
            ...(connection.admin ? { adminTransport: connection.admin.transport } : {}),
            ...(connection.defaultSchema ? { defaultSchema: connection.defaultSchema } : {})
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
        connection: connectionIdSchema,
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
        connectionId: connection,
        run: async () => {
          const resolved = resolveConnection(env, catalog, connection);
          return inspectSchema(resolved, schema, table);
        }
      })
  );

  server.registerTool(
    'query_read',
    {
      description:
        'Execute exactly one bounded read query using a dedicated read-only database credential. Writes, locking reads, multi-statements, and dangerous MySQL read side effects are rejected.',
      inputSchema: z.object({
        connection: connectionIdSchema,
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
        connectionId: connection,
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
      inputSchema: z.object({ connection: connectionIdSchema, sql: sqlSchema, params: paramsSchema }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ connection, sql, params }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'explain',
        connectionId: connection,
        sql,
        run: async () => explainRead(resolveConnection(env, catalog, connection), sql, params)
      })
  );

  server.registerTool(
    'health_check',
    {
      description: 'Check whether one logical connection can establish a usable read path without exposing network details.',
      inputSchema: z.object({ connection: connectionIdSchema }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ connection }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'health_check',
        connectionId: connection,
        run: async () => {
          const resolved = resolveConnection(env, catalog, connection);
          const health = await healthCheck(resolved);
          return { connection, dialect: resolved.dialect, transport: resolved.transport, ...health };
        },
        summarize: value => ({ latencyMs: value.latencyMs })
      })
  );

  server.registerTool(
    'insert_rows',
    {
      description:
        'Insert 1 to 100 rows into one table using a separately configured writer credential and internally parameterized SQL. Raw SQL, UPSERT, and client-supplied RETURNING expressions are not accepted.',
      inputSchema: z.object({
        connection: connectionIdSchema,
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
        connectionId: connection,
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
        connection: connectionIdSchema,
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
        connectionId: connection,
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
        connection: connectionIdSchema,
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
        connectionId: connection,
        run: async () => deleteRows(resolveWriteConnection(env, catalog, connection), schema, table, where),
        summarize: value => ({ affectedRows: value.affectedRows })
      })
  );

  server.registerTool(
    'create_table',
    {
      description:
        'Create one table through a bounded structured column definition using the separately configured ADMIN credential. Arbitrary type strings, defaults, constraints, and raw DDL are rejected.',
      inputSchema: z.object({
        connection: connectionIdSchema,
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
        connectionId: connection,
        run: async () => createTable(resolveAdminConnection(env, catalog, connection), schema, table, columns),
        summarize: value => ({ adminOperation: value.operation })
      })
  );

  server.registerTool(
    'alter_table',
    {
      description:
        'Perform one structured table alteration with the ADMIN credential: add/drop/rename a column or rename the table. Dropping a column requires MCP protocol-level user confirmation.',
      inputSchema: z.object({
        connection: connectionIdSchema,
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        operation: alterOperationSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table, operation }, ctx) => {
      if (operation.action === 'drop_column') {
        const decision = adminConfirmation(
          ctx.mcpReq.inputResponses,
          `Drop column ${operation.column} from ${schema ? `${schema}.` : ''}${table}? This can permanently destroy data.`
        );
        if (decision.kind === 'input_required') return decision.result;
        if (decision.kind === 'denied') return confirmationFailure(decision.message);
      }
      return runTool({
        env,
        ctx,
        tool: 'alter_table',
        connectionId: connection,
        run: async () => alterTable(resolveAdminConnection(env, catalog, connection), schema, table, operation),
        summarize: value => ({ adminOperation: value.operation })
      });
    }
  );

  server.registerTool(
    'create_index',
    {
      description:
        'Create a simple column index through structured input using the ADMIN credential. Expression, partial, fulltext, spatial, and operator-class indexes are not accepted.',
      inputSchema: z.object({
        connection: connectionIdSchema,
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
        connectionId: connection,
        run: async () => createIndex(resolveAdminConnection(env, catalog, connection), schema, table, columns, unique, name),
        summarize: value => ({ adminOperation: value.operation })
      })
  );

  server.registerTool(
    'drop_index',
    {
      description:
        'Drop one explicitly named index using the ADMIN credential. Requires MCP protocol-level user confirmation and is never automatically retried.',
      inputSchema: z.object({
        connection: connectionIdSchema,
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema,
        name: databaseIdentifierSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table, name }, ctx) => {
      const decision = adminConfirmation(
        ctx.mcpReq.inputResponses,
        `Drop index ${name} from ${schema ? `${schema}.` : ''}${table}? This schema change cannot be automatically undone.`
      );
      if (decision.kind === 'input_required') return decision.result;
      if (decision.kind === 'denied') return confirmationFailure(decision.message);
      return runTool({
        env,
        ctx,
        tool: 'drop_index',
        connectionId: connection,
        run: async () => dropIndex(resolveAdminConnection(env, catalog, connection), schema, table, name),
        summarize: value => ({ adminOperation: value.operation })
      });
    }
  );

  server.registerTool(
    'drop_table',
    {
      description:
        'Drop one explicitly named table using the ADMIN credential. Requires MCP protocol-level user confirmation and is never automatically retried.',
      inputSchema: z.object({
        connection: connectionIdSchema,
        schema: databaseIdentifierSchema.optional(),
        table: databaseIdentifierSchema
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ connection, schema, table }, ctx) => {
      const decision = adminConfirmation(
        ctx.mcpReq.inputResponses,
        `Drop table ${schema ? `${schema}.` : ''}${table}? This permanently deletes the table and its data.`
      );
      if (decision.kind === 'input_required') return decision.result;
      if (decision.kind === 'denied') return confirmationFailure(decision.message);
      return runTool({
        env,
        ctx,
        tool: 'drop_table',
        connectionId: connection,
        run: async () => dropTable(resolveAdminConnection(env, catalog, connection), schema, table),
        summarize: value => ({ adminOperation: value.operation })
      });
    }
  );

  return server;
}
