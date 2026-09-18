import { describe, expect, it } from 'vitest';
import {
  buildConnectionAuthHeader,
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
