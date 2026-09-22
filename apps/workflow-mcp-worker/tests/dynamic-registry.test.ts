import { describe, expect, it } from 'vitest';
import { registerWorkflowTools } from '../src/mcp.js';
import { getWorkflowRegistry } from '../src/registry.js';
import type { Env } from '../src/types.js';

type Reply = { structuredContent?: unknown; isError?: boolean };
type Handler = (args: unknown) => Promise<Reply>;
class FakeServer {
  readonly tools = new Map<string, Handler>();
  registerTool(name: string, _config: unknown, handler: Handler): void {
    this.tools.set(name, handler);
  }
}
function tools(env: Env): FakeServer {
  const server = new FakeServer();
  registerWorkflowTools(server as unknown as Parameters<typeof registerWorkflowTools>[0], env);
  return server;
}
const staged = getWorkflowRegistry().find(entry => entry.metadata.id === 'local-http-smoke')!;

describe('OFF-by-default authoritative D1 workflow discovery', () => {
  it('uses the legacy registry until an explicit read-only feature gate is enabled', async () => {
    const server = tools({ DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'false' } as Env);
    const response = await server.tools.get('workflow_list')!({});
    const data = response.structuredContent as { workflows: unknown[] };
    expect(data.workflows).toHaveLength(4);
  });

  it('shows the activated digest and hides disabled or unstaged entries', async () => {
    const db = {
      prepare: (sql: string) => ({
        all: async () => {
          expect(sql).toContain("a.state = 'enabled'");
          return { results: [{
            workflow_id: staged.metadata.id,
            active_digest: staged.definitionDigest,
            normalized_plan_json: JSON.stringify(staged.plan),
            source_path: staged.sourcePath
          }] };
        }
      })
    } as unknown as D1Database;
    const server = tools({ DB: db, DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true' } as Env);
    const result = await server.tools.get('workflow_list')!({});
    const listing = result.structuredContent as {
      workflows: Array<{ id: string; definitionDigest: string }>
    };
    expect(listing.workflows).toEqual([expect.objectContaining({
      id: 'local-http-smoke', definitionDigest: staged.definitionDigest
    })]);
    const found = await server.tools.get('workflow_get')!({ workflow: 'local-http-smoke' });
    expect(found.structuredContent).toMatchObject({ workflow: { id: 'local-http-smoke' } });
    const missing = await server.tools.get('workflow_get')!({ workflow: 'raindrop-daily-snapshot' });
    expect(missing.isError).toBe(true);
  });

  it('never falls back to static discovery when D1 binding or read fails', async () => {
    const missing = tools({ DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true' } as Env);
    const denied = await missing.tools.get('workflow_list')!({});
    expect(denied.isError).toBe(true);
    const db = {
      prepare: () => ({ all: async () => { throw new Error('D1 unavailable'); } })
    } as unknown as D1Database;
    const failed = tools({ DB: db, DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true' } as Env);
    expect((await failed.tools.get('workflow_get')!({ workflow: 'local-http-smoke' })).isError).toBe(true);
  });
});
