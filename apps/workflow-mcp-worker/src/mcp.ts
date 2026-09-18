import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { findWorkflow, getWorkflowRegistry } from './registry.js';

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

export function registerWorkflowTools(server: ToolRegistrar): void {
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
      inputSchema: z.object({
        workflow: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async rawArgs => {
      const parsed = z.object({ workflow: z.string() }).parse(rawArgs);
      const entry = findWorkflow(parsed.workflow);
      if (!entry) return failure('WORKFLOW_NOT_FOUND', 'Workflow definition was not found.');
      return success({
        workflow: entry.metadata,
        sourcePath: entry.sourcePath
      });
    }
  );
}

export function buildWorkflowMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'workflow-mcp-worker', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Deterministic Workflow MCP control surface. v0.1 exposes compiled workflow discovery first; execution tools are added by later implementation tickets.'
    }
  );
  registerWorkflowTools(server as unknown as ToolRegistrar);
  return server;
}
