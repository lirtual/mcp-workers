import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { callMcpTool } from '../src/mcp-client.js';
import type { Env } from '../src/types.js';
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
  it.each([0, 4, 20])('invokes the read-only MCP adapter and preserves %i actual records', async count => {
    const items = Array.from({ length: count }, (_, n) => ({ id: n + 1, title: 'Bookmark ' + n }));
    const requests: Array<{ url: string; method: string; auth: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(input),
        method: String(body.method),
        auth: new Headers(init?.headers).get('Authorization'),
        body
      });
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'list_raindrops', inputSchema: {
            type: 'object', properties: {
              collectionId: { type: 'number' }, page: { type: 'number' },
              perPage: { type: 'number' }, sort: { type: 'string' },
              skipCache: { type: 'boolean' }
            }, additionalProperties: false
          } }] }
        : { structuredContent: { items, count: 120 }, content: [] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    const result = await callMcpTool(
      { RAINDROP_MCP_ACCESS_TOKEN: 'raindrop-secret' } as Env,
      'raindrop',
      'list_raindrops',
      { collectionId: 0, page: 0, perPage: 20, sort: '-created', skipCache: true },
      fetchImpl as typeof fetch
    );
    expect(result.result.structuredContent).toEqual({ items, count: 120 });
    expect(requests.map(request => request.method)).toEqual(['tools/list', 'tools/call']);
    expect(requests.every(request =>
      request.url === 'https://raindrop-mcp-worker.aiyaya.workers.dev/mcp'
      && request.auth === 'Bearer raindrop-secret'
    )).toBe(true);
    const params = requests[1]!.body.params as Record<string, unknown>;
    expect(params).toMatchObject({ name: 'list_raindrops', arguments: {
      collectionId: 0, page: 0, perPage: 20, sort: '-created', skipCache: true
    } });
  });

  it('rejects an upstream tool error rather than recording empty success', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'list_raindrops',
            inputSchema: { type: 'object', properties: {} } }] }
        : { isError: true, content: [{ type: 'text', text: 'upstream auth failure' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'Content-Type': 'application/json' }
      });
    });
    await expect(callMcpTool(
      { RAINDROP_MCP_ACCESS_TOKEN: 'raindrop-secret' } as Env,
      'raindrop', 'list_raindrops', {}, fetchImpl as typeof fetch
    )).rejects.toThrow('upstream auth failure');
  });

});
