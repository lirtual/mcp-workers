import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { admitManualWorkflow, PublicWorkflowError } from './admission.js';
import { artifactReadReferences } from './artifacts.js';
import { requestWorkflowCancellation } from './cancellation.js';
import { findWorkflow, getWorkflowRegistry } from './registry.js';
import { D1WorkflowStore } from './storage.js';
import type { Env } from './types.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

interface ToolRegistrar {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema: z.ZodType;
      annotations?: {
        readOnlyHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    handler: (args: unknown) => Promise<ToolResult>
  ): unknown;
}

const workflowIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const runIdSchema = z.string().min(1).max(100);
const terminalStates = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'indeterminate'
]);

function success(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data
  };
}

function failure(code: string, message: string): ToolResult {
  const body = { error: { code, message } };
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true
  };
}

function requiredEnv(env: Env | undefined): Env {
  if (!env) throw new PublicWorkflowError('RUNTIME_NOT_CONFIGURED', 'Workflow runtime bindings are not configured.');
  return env;
}

async function runSafely(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PublicWorkflowError) return failure(error.code, error.message);
    const message = error instanceof Error ? error.message : 'Unexpected workflow runtime error.';
    return failure('WORKFLOW_RUNTIME_ERROR', message.slice(0, 500));
  }
}

export function registerWorkflowTools(server: ToolRegistrar, env?: Env): void {
  server.registerTool(
    'workflow_list',
    {
      description: 'List compiled Workflow MCP definitions available for new runs.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async () =>
      success({
        workflows: getWorkflowRegistry().map(entry => entry.metadata)
      })
  );

  server.registerTool(
    'workflow_get',
    {
      description: 'Get safe metadata for one compiled Workflow MCP definition.',
      inputSchema: z.object({ workflow: workflowIdSchema }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async rawArgs => {
      const parsed = z.object({ workflow: workflowIdSchema }).parse(rawArgs);
      const entry = findWorkflow(parsed.workflow);
      if (!entry) return failure('WORKFLOW_NOT_FOUND', 'Workflow definition was not found.');
      return success({
        workflow: entry.metadata,
        sourcePath: entry.sourcePath
      });
    }
  );

  server.registerTool(
    'workflow_run',
    {
      description: 'Asynchronously admit and start one compiled workflow.',
      inputSchema: z
        .object({
          workflow: workflowIdSchema,
          input: z.record(z.string(), z.unknown()).default({}),
          idempotencyKey: z.string().min(1).max(128).optional()
        })
        .strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false }
    },
    async rawArgs =>
      runSafely(async () => {
        const parsed = z
          .object({
            workflow: workflowIdSchema,
            input: z.record(z.string(), z.unknown()).default({}),
            idempotencyKey: z.string().min(1).max(128).optional()
          })
          .parse(rawArgs);
        const result = await admitManualWorkflow(
          requiredEnv(env),
          parsed.workflow,
          parsed.input,
          parsed.idempotencyKey
        );
        return success({
          runId: result.runId,
          state: result.state,
          definitionDigest: result.definitionDigest,
          alreadyAdmitted: result.alreadyAdmitted
        });
      })
  );

  server.registerTool(
    'workflow_status',
    {
      description: 'Return durable status for one workflow run.',
      inputSchema: z.object({ runId: runIdSchema }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async rawArgs =>
      runSafely(async () => {
        const { runId } = z.object({ runId: runIdSchema }).parse(rawArgs);
        const store = new D1WorkflowStore(requiredEnv(env).DB);
        const run = await store.getRun(runId);
        if (!run) return failure('RUN_NOT_FOUND', 'Workflow run was not found.');
        return success({
          runId: run.runId,
          workflowId: run.workflowId,
          definitionDigest: run.definitionDigest,
          state: run.state,
          createdAt: run.createdAt,
          ...(run.startedAt ? { startedAt: run.startedAt } : {}),
          ...(run.endedAt ? { endedAt: run.endedAt } : {}),
          ...(run.errorCode ? { errorCode: run.errorCode, errorSummary: run.errorSummary } : {}),
          steps: await store.listStepSummaries(runId)
        });
      })
  );

  server.registerTool(
    'workflow_result',
    {
      description: 'Return terminal workflow outputs when ready without blocking for completion.',
      inputSchema: z.object({ runId: runIdSchema }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async rawArgs =>
      runSafely(async () => {
        const { runId } = z.object({ runId: runIdSchema }).parse(rawArgs);
        const runtime = requiredEnv(env);
        const store = new D1WorkflowStore(runtime.DB);
        const run = await store.getRun(runId);
        if (!run) return failure('RUN_NOT_FOUND', 'Workflow run was not found.');
        const ready = terminalStates.has(run.state);
        const artifacts = ready ? await artifactReadReferences(runtime, runId, { store }) : [];
        return success({
          runId,
          ready,
          state: run.state,
          ...(ready ? { outputs: run.output ?? {}, artifacts } : {}),
          ...(run.errorCode ? { errorCode: run.errorCode, errorSummary: run.errorSummary } : {})
        });
      })
  );

  server.registerTool(
    'workflow_cancel',
    {
      description: 'Cooperatively request cancellation of one workflow run.',
      inputSchema: z.object({ runId: runIdSchema }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
    },
    async rawArgs =>
      runSafely(async () => {
        const { runId } = z.object({ runId: runIdSchema }).parse(rawArgs);
        const result = await requestWorkflowCancellation(requiredEnv(env), runId);
        if (!result) return failure('RUN_NOT_FOUND', 'Workflow run was not found.');
        return success(result);
      })
  );

  server.registerTool(
    'workflow_logs',
    {
      description: 'Return ordered essential lifecycle events for one workflow run.',
      inputSchema: z
        .object({
          runId: runIdSchema,
          cursor: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(100).default(50)
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async rawArgs =>
      runSafely(async () => {
        const parsed = z
          .object({
            runId: runIdSchema,
            cursor: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(100).default(50)
          })
          .parse(rawArgs);
        const store = new D1WorkflowStore(requiredEnv(env).DB);
        const run = await store.getRun(parsed.runId);
        if (!run) return failure('RUN_NOT_FOUND', 'Workflow run was not found.');
        const events = await store.listEvents(parsed.runId, parsed.cursor, parsed.limit);
        return success({
          runId: parsed.runId,
          events,
          nextCursor: events.length === parsed.limit ? events.at(-1)!.eventId : null
        });
      })
  );
}

export function buildWorkflowMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'workflow-mcp-worker', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Deterministic Workflow MCP control surface for compiled workflows, durable run state, and asynchronous execution.'
    }
  );
  registerWorkflowTools(server as unknown as ToolRegistrar, env);
  return server;
}
