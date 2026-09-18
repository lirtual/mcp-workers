import { describe, expect, it } from 'vitest';
import {
  buildConnectionAuthHeader,
  resolveConnection,
  type McpConnection
} from '../src/connections.js';

function connection(auth: McpConnection['auth']): McpConnection {
  return {
    id: 'test',
    transport: 'streamable-http',
    protocolVersion: '2025-11-25',
    endpoint: 'https://example.invalid/mcp',
    auth,
    trustAnnotations: false,
    tools: {}
  };
}

describe('MCP connection auth formatting', () => {
  it('supports raw header values', () => {
    expect(
      buildConnectionAuthHeader(
        connection({ header: 'X-Api-Key', format: 'raw', secret: 'TOKEN' }),
        'secret'
      )
    ).toEqual({ name: 'X-Api-Key', value: 'secret' });
  });

  it('supports Bearer values', () => {
    expect(
      buildConnectionAuthHeader(
        connection({ header: 'Authorization', format: 'bearer', secret: 'TOKEN' }),
        'secret'
      )
    ).toEqual({ name: 'Authorization', value: 'Bearer secret' });
  });

  it('overrides only the smoke endpoint while preserving static policy and auth', () => {
    const resolved = resolveConnection(
      { SMOKE_READONLY_MCP_ENDPOINT: 'https://staging.example.test/mcp' },
      'smoke-readonly'
    );
    expect(resolved).toMatchObject({
      id: 'smoke-readonly',
      endpoint: 'https://staging.example.test/mcp',
      protocolVersion: '2025-11-25',
      trustAnnotations: false,
      tools: {
        health_check: { effect: 'read' }
      },
      auth: {
        header: 'Authorization',
        format: 'bearer',
        secret: 'SMOKE_READONLY_MCP_TOKEN'
      }
    });
  });

  it('resolves the modern staging self-connection with Bearer auth and read-only policy', () => {
    const resolved = resolveConnection(
      { SMOKE_MODERN_MCP_ENDPOINT: 'https://staging.example.test/mcp' },
      'smoke-modern'
    );
    expect(resolved).toMatchObject({
      endpoint: 'https://staging.example.test/mcp',
      protocolVersion: '2026-07-28',
      trustAnnotations: false,
      tools: { workflow_list: { effect: 'read' } },
      auth: {
        header: 'Authorization',
        format: 'bearer',
        secret: 'SMOKE_READONLY_MCP_TOKEN'
      }
    });
  });

  it('uses the checked-in endpoint when no staging override is configured', () => {
    expect(resolveConnection({}, 'smoke-readonly')?.endpoint).toBe(
      'https://example.invalid/mcp'
    );
  });

  it('supports explicit custom prefixes without assuming Bearer', () => {
    expect(
      buildConnectionAuthHeader(
        connection({
          header: 'Authorization',
          format: 'prefix',
          prefix: 'Sentry-Bearer ',
          secret: 'TOKEN'
        }),
        'secret'
      )
    ).toEqual({ name: 'Authorization', value: 'Sentry-Bearer secret' });
  });
});
