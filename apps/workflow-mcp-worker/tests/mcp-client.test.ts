import { describe, expect, it, vi } from 'vitest';
import { callMcpTool, inspectMcpTool, McpConnectionDeniedError } from '../src/mcp-client.js';
import type { Env } from '../src/types.js';

vi.mock('../src/connections.js', async importOriginal => {
  const actual = await importOriginal<{ getConnection: (id: string) => unknown }>();
  return {
    ...actual,
    getConnection(id: string) {
      if (id !== 'legacy-test') return actual.getConnection(id);
      return {
        id: 'legacy-test',
        transport: 'streamable-http',
        protocolVersion: '2025-11-25',
        endpoint: 'https://example.invalid/mcp',
        auth: { header: 'Authorization', format: 'bearer', secret: 'MCP_ACCESS_TOKEN' },
        trustAnnotations: false,
        tools: { health_check: { effect: 'read' } }
      };
    }
  };
});

const env = {
  MCP_ACCESS_TOKEN: 'secret'
} as unknown as Env;

function jsonResponse(
  body: unknown,
  init: ResponseInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init
  });
}

describe('MCP Streamable HTTP client', () => {
  it('uses the declared 2025-11-25 sessionful protocol and preserves the session id', async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers });
      const method = body.method;

      if (method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'legacy-smoke', version: '1.2.3' }
            }
          },
          { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-123' } }
        );
      }
      if (method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'health_check',
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false
                },
                annotations: { readOnlyHint: true }
              }
            ]
          }
        });
      }
      if (method === 'tools/call') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: 'ok' }],
            structuredContent: { ok: true }
          }
        });
      }
      throw new Error(`unexpected method ${String(method)}`);
    });

    const result = await callMcpTool(
      env,
      'legacy-test',
      'health_check',
      {},
      fetchImpl as typeof fetch
    );

    expect(result.result.structuredContent).toEqual({ ok: true });
    expect(result.dependencySnapshot).toMatchObject({
      connection: 'legacy-test',
      tool: 'health_check',
      serverName: 'legacy-smoke',
      serverVersion: '1.2.3'
    });
    expect(result.dependencySnapshot.schemaDigest).toMatch(/^[a-f0-9]{64}$/);

    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer secret');
    for (const request of requests.slice(1)) {
      expect(request.headers.get('Mcp-Session-Id')).toBe('session-123');
    }
  });

  it('uses the declared 2026-07-28 stateless protocol without initialize fallback', async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers });

      expect(body.method).toBe('tools/list');
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            {
              name: 'modern_read',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true }
            }
          ]
        }
      });
    });

    const inspection = await inspectMcpTool(
      env,
      'workflow-self',
      'modern_read',
      fetchImpl as typeof fetch
    );

    expect(inspection.tool.name).toBe('modern_read');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get('MCP-Protocol-Version')).toBe('2026-07-28');
    expect(requests[0]!.headers.get('Mcp-Method')).toBe('tools/list');
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer secret');
    expect(requests[0]!.headers.get('Mcp-Session-Id')).toBeNull();
  });

  it('rejects a live input contract mismatch before tools/call', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.method === 'initialize') {
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: {} }
          },
          { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's' } }
        );
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'health_check',
                inputSchema: {
                  type: 'object',
                  required: ['requiredValue'],
                  properties: { requiredValue: { type: 'string' } },
                  additionalProperties: false
                }
              }
            ]
          }
        });
      }
      throw new Error('tools/call should not be reached for invalid arguments');
    });

    await expect(
      callMcpTool(
        env,
        'legacy-test',
        'health_check',
        {},
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/MCP_INPUT_SCHEMA_MISMATCH/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});


describe('pinned MCP external boundary', () => {
  it('rechecks D1 after discovery and prevents tools/call when revoked', async () => {
    let disabled = false;
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            connection_id: 'workflow-self',
            disabled: disabled ? 1 : 0,
            allowed_tools_json: '{"workflow_list":["read"]}'
          })
        })
      })
    } as unknown as D1Database;
    const outgoing: string[] = [];
    const fetchImpl = vi.fn(async (_resource: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: string };
      outgoing.push(body.method);
      if (body.method === 'tools/list') {
        disabled = true;
        return jsonResponse({
          jsonrpc: '2.0', id: body.id,
          result: { tools: [{ name: 'workflow_list', inputSchema: { type: 'object', properties: {} } }] }
        });
      }
      throw new Error('revoked tools/call must not be transmitted');
    });
    await expect(callMcpTool(
      env, 'workflow-self', 'workflow_list', {},
      fetchImpl as typeof fetch,
      {
        db,
        pinned: {
          connectionId: 'workflow-self', version: 1,
          endpoint: 'https://workflow-mcp-worker.aiyaya.workers.dev/mcp',
          toolName: 'workflow_list', effect: 'read'
        }
      }
    )).rejects.toBeInstanceOf(McpConnectionDeniedError);
    expect(outgoing).toEqual(['tools/list']);
  });

  it('fails closed before discovery if the live controls are missing', async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
    const fetchImpl = vi.fn();
    await expect(callMcpTool(
      env, 'workflow-self', 'workflow_list', {},
      fetchImpl as typeof fetch,
      {
        db,
        pinned: {
          connectionId: 'workflow-self', version: 1,
          endpoint: 'https://workflow-mcp-worker.aiyaya.workers.dev/mcp',
          toolName: 'workflow_list', effect: 'read'
        }
      }
    )).rejects.toBeInstanceOf(McpConnectionDeniedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


describe('legacy Run live revocation compatibility', () => {
  const pin = {
    connectionId: 'workflow-self', version: 0,
    endpoint: 'https://workflow-mcp-worker.aiyaya.workers.dev/mcp',
    toolName: 'workflow_list', effect: 'read' as const
  };
  it('rejects a disabled static Connection before any external request', async () => {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => ({
        connection_id: 'workflow-self', disabled: 1,
        allowed_tools_json: '{"workflow_list":["read"]}'
      }) }) })
    } as unknown as D1Database;
    const outgoing = vi.fn();
    await expect(callMcpTool(env, 'workflow-self', 'workflow_list', {},
      outgoing as typeof fetch, { db, pinned: pin, legacy: true }
    )).rejects.toBeInstanceOf(McpConnectionDeniedError);
    expect(outgoing).not.toHaveBeenCalled();
  });
  it('permits the legacy static lookup when there is no versioned control', async () => {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => null }) })
    } as unknown as D1Database;
    const outgoing = vi.fn(async (_resource: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: string };
      if (body.method === 'tools/list') return jsonResponse({
        jsonrpc: '2.0', id: body.id,
        result: { tools: [{ name: 'workflow_list', inputSchema: { type: 'object', properties: {} } }] }
      });
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [] } });
    });
    await callMcpTool(env, 'workflow-self', 'workflow_list', {},
      outgoing as typeof fetch, { db, pinned: pin, legacy: true });
    expect(outgoing).toHaveBeenCalledTimes(2);
  });
});


describe('pre-send D1 failure classification', () => {
  it('rejects a failed revocation read without transmitting an external write', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => { throw new Error('D1 temporarily unavailable'); }
        })
      })
    } as unknown as D1Database;
    const outgoing = vi.fn();
    await expect(callMcpTool(
      env, 'workflow-self', 'workflow_list', {},
      outgoing as typeof fetch, {
        db,
        pinned: {
          connectionId: 'workflow-self', version: 1,
          endpoint: 'https://workflow-mcp-worker.aiyaya.workers.dev/mcp',
          toolName: 'workflow_list', effect: 'read'
        }
      }
    )).rejects.toBeInstanceOf(McpConnectionDeniedError);
    expect(outgoing).not.toHaveBeenCalled();
  });
});
