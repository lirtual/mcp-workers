import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolveConnection, resolveConnectionDialect, resolveWriteConnection } from './config.js';
import { deleteRows, explainRead, healthCheck, insertRows, inspectSchema, queryRead, updateRows } from './db/index.js';
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

export function buildMcpServer(env: Env, catalog: ConnectionConfig[]): McpServer {
  const server = new McpServer(
    { name: 'database-mcp-worker', version: '0.2.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Database access with bounded reads and optional structured Safe Write. Use inspect_schema before unfamiliar queries. query_read never writes; insert_rows, update_rows, and delete_rows use separately configured writer credentials and never accept raw write SQL.'
    }
  );

  server.registerTool(
    'list_connections',
    {
      description: 'List statically configured logical database connections and non-secret read/write capabilities.',
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
        schema: z.string().min(1).max(128).optional(),
        table: z.string().min(1).max(128).optional()
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
        summarize: value => ({
          rowCount: value.rowCount,
          truncated: value.truncated,
          truncationReason: value.truncationReason
        })
      })
  );

  server.registerTool(
    'explain',
    {
      description: 'Return a non-ANALYZE execution plan for one read query. The underlying statement is not intentionally executed.',
      inputSchema: z.object({
        connection: connectionIdSchema,
        sql: sqlSchema,
        params: paramsSchema
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ connection, sql, params }, ctx) =>
      runTool({
        env,
        ctx,
        tool: 'explain',
        connectionId: connection,
        sql,
        run: async () => {
          const resolved = resolveConnection(env, catalog, connection);
          return explainRead(resolved, sql, params);
        }
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
        run: async () => {
          const resolved = resolveWriteConnection(env, catalog, connection);
          return insertRows(resolved, schema, table, rows);
        },
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
        run: async () => {
          const resolved = resolveWriteConnection(env, catalog, connection);
          return updateRows(resolved, schema, table, set, where);
        },
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
        run: async () => {
          const resolved = resolveWriteConnection(env, catalog, connection);
          return deleteRows(resolved, schema, table, where);
        },
        summarize: value => ({ affectedRows: value.affectedRows })
      })
  );

  return server;
}
