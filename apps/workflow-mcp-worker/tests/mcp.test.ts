import { describe, expect, it } from 'vitest';
import { registerWorkflowTools } from '../src/mcp.js';

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}>;

class FakeServer {
  readonly tools = new Map<string, Handler>();

  registerTool(_name: string, _config: unknown, _handler: Handler): void {
    this.tools.set(_name, _handler);
  }
}

function registered(): FakeServer {
  const server = new FakeServer();
  registerWorkflowTools(server as unknown as Parameters<typeof registerWorkflowTools>[0]);
  return server;
}

describe('workflow discovery tools', () => {
  it('lists both compiled tracer workflows without secret configuration', async () => {
    const server = registered();
    const result = await server.tools.get('workflow_list')!({});
    const data = result.structuredContent as { workflows: Array<{ id: string; definitionDigest: string }> };

    expect(data.workflows.map(workflow => workflow.id)).toEqual([
      'local-http-smoke',
      'mcp-connection-smoke',
      'trigger-http-smoke',
      'web-archive-smoke'
    ]);
    for (const workflow of data.workflows) {
      expect(workflow.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(JSON.stringify(result)).not.toContain('MCP_ACCESS_TOKEN');
  });

  it('returns safe metadata for a known workflow', async () => {
    const server = registered();
    const result = await server.tools.get('workflow_get')!({ workflow: 'web-archive-smoke' });
    const data = result.structuredContent as {
      workflow: { id: string; stepCapabilities: string[] };
      sourcePath: string;
    };

    expect(data.workflow.id).toBe('web-archive-smoke');
    expect(data.workflow.stepCapabilities).toEqual(['http.read', 'github.archive_markdown']);
    expect(data.sourcePath).toBe('workflows/web-archive-smoke.yaml');
  });

  it('returns a bounded error for an unknown workflow', async () => {
    const server = registered();
    const result = await server.tools.get('workflow_get')!({ workflow: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'WORKFLOW_NOT_FOUND',
        message: 'Workflow definition was not found.'
      }
    });
  });
});
