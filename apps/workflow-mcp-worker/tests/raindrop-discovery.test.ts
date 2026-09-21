import { describe, expect, it, vi } from 'vitest';
import { discoverRaindropLiveContract, verifyRaindropToolSchema } from '../scripts/raindrop-discovery.js';

const validTool = {
  name: 'list_raindrops',
  inputSchema: {
    type: 'object',
    required: ['collectionId'],
    properties: {
      collectionId: { type: 'number' },
      page: { type: 'number' },
      perPage: { type: 'number' },
      sort: { type: 'string' },
      skipCache: { type: 'boolean' }
    }
  },
  outputSchema: {
    type: 'object', required: ['items', 'count'],
    properties: {
      count: { type: 'number' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'title', 'url', 'tags'],
          properties: {
            id: { type: 'number' }, title: { type: 'string' },
            url: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  }
};

describe('Raindrop read-only live discovery gate', () => {
  it('accepts the source-compatible input and structured output schema', () => {
    expect(verifyRaindropToolSchema(validTool)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    { ...validTool, inputSchema: { ...validTool.inputSchema, required: ['collectionId', 'other'] } },
    { ...validTool, inputSchema: { ...validTool.inputSchema, properties: {
      ...validTool.inputSchema.properties, perPage: { type: 'string' }
    } } },
    { ...validTool, outputSchema: undefined },
    { ...validTool, outputSchema: { ...validTool.outputSchema, required: ['items'] } },
    { ...validTool, outputSchema: { ...validTool.outputSchema, properties: {
      ...validTool.outputSchema.properties, items: { type: 'string' }
    } } }
  ])('fails closed on incompatible live tools/list schemas', tool => {
    expect(() => verifyRaindropToolSchema(tool)).toThrow('RAINDROP_CONTRACT_MISMATCH');
  });

  it('discovers across pages with fixed endpoint and ingress auth; emits only sanitized evidence', async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://raindrop-mcp-worker.aiyaya.workers.dev/mcp');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-ingress-token');
      expect(headers.get('Mcp-Method')).toBe('tools/list');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const params = body.params as Record<string, unknown>;
      const page = params.cursor ? { tools: [validTool] } : { tools: [], nextCursor: 'next' };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: page });
    });
    const evidence = await discoverRaindropLiveContract('test-ingress-token', fetchImpl as typeof fetch);
    expect(requests).toHaveLength(2);
    expect(requests.every(body => body.method === 'tools/list')).toBe(true);
    expect(evidence).toMatchObject({ tool: 'list_raindrops', schemaSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(evidence)).not.toContain('test-ingress-token');
  });

  it('rejects upstream unauthorized status without invoking any tool', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(discoverRaindropLiveContract('test-token', fetchImpl as typeof fetch))
      .rejects.toThrow('HTTP 401');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects missing live tool rather than inventing schema or calling it', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
    });
    await expect(discoverRaindropLiveContract('test-token', fetchImpl as typeof fetch))
      .rejects.toThrow('list_raindrops not found');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
