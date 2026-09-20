import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileWorkflowText } from '../src/compiler.js';
import { getConnection, buildConnectionAuthHeader } from '../src/connections.js';
import { resolveMcpOperationPolicy } from '../src/effective-policy.js';
import { resolveRuntimeValue, asRuntimePlan } from '../src/runtime-plan.js';

const source = readFileSync(new URL('../workflows/raindrop-daily-snapshot.yaml', import.meta.url), 'utf8');
const compiled = compileWorkflowText(source, 'workflows/raindrop-daily-snapshot.yaml');
const plan = asRuntimePlan(compiled.plan);

describe('Raindrop daily snapshot', () => {
  it('compiles with manual and Asia/Shanghai 09:00 schedule and fixed read-only arguments', () => {
    expect(compiled.metadata.triggerTypes).toEqual(['manual', 'schedule']);
    expect(plan.triggers[1]).toMatchObject({
      id: 'daily-nine', cron: '0 9 * * *', timezone: 'Asia/Shanghai', misfire: 'latest'
    });
    expect(plan.inputs).toEqual({});
    expect(plan.steps.fetch).toMatchObject({
      uses: 'mcp.call',
      executor: 'cloudflare',
      with: {
        connection: 'raindrop',
        tool: 'list_raindrops',
        arguments: { collectionId: 0, page: 0, perPage: 20, sort: '-created', skipCache: true }
      }
    });
    expect(Object.values(plan.steps).every(step => step.executor === 'cloudflare')).toBe(true);
  });

  it('uses one immutable endpoint, independent credential, and explicit local read policy', () => {
    const connection = getConnection('raindrop');
    expect(connection).toMatchObject({
      endpoint: 'https://raindrop-mcp-worker.aiyaya.workers.dev/mcp',
      protocolVersion: '2026-07-28',
      trustAnnotations: false,
      tools: { list_raindrops: { effect: 'read' } }
    });
    expect(connection && buildConnectionAuthHeader(connection, 'secret')).toEqual({
      name: 'Authorization', value: 'Bearer secret'
    });
    expect(connection?.auth.secret).toBe('RAINDROP_MCP_ACCESS_TOKEN');
    expect(resolveMcpOperationPolicy('raindrop', 'list_raindrops', { destructiveHint: true }))
      .toMatchObject({ effect: 'read', source: 'local_tool_policy' });
  });

  it.each([0, 4, 20])('preserves %i structured bookmarks without a GitHub step', count => {
    const items = Array.from({ length: count }, (_, n) => ({
      id: n + 1, title: 'Bookmark ' + (n + 1), url: 'https://example.com/' + n, tags: []
    }));
    const result = { structuredContent: { items, count } };
    const context = { input: {}, stepOutputs: { fetch: { result } } };
    expect(resolveRuntimeValue(plan.outputs.bookmarks, context)).toEqual(items);
    expect(resolveRuntimeValue(plan.outputs.count, context)).toBe(count);
  });

  it('never converts upstream errors into an empty successful list', () => {
    const context = { input: {}, stepOutputs: { fetch: { error: 'UPSTREAM_UNAVAILABLE' } } };
    expect(resolveRuntimeValue(plan.outputs.bookmarks, context)).toBeUndefined();
  });
});
