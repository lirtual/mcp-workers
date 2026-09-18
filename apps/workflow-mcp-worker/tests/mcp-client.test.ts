import { describe, expect, it, vi } from 'vitest';
import { callMcpTool, inspectMcpTool } from '../src/mcp-client.js';
import type { Env } from '../src/types.js';

const env = {
  SMOKE_READONLY_MCP_TOKEN: 'secret'
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
      'smoke-readonly',
      'health_check',
      {},
      fetchImpl as typeof fetch
    );

    expect(result.result.structuredContent).toEqual({ ok: true });
    expect(result.dependencySnapshot).toMatchObject({
      connection: 'smoke-readonly',
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
      'smoke-modern',
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
        'smoke-readonly',
        'health_check',
        {},
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow(/MCP_INPUT_SCHEMA_MISMATCH/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
