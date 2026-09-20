import type { EffectClass } from './capabilities.js';

export type ConnectionAuth =
  | { header: string; format: 'raw'; secret: string }
  | { header: string; format: 'bearer'; secret: string }
  | { header: string; format: 'prefix'; prefix: string; secret: string };

export interface LocalToolPolicy {
  effect: EffectClass;
  operationIdArgument?: string;
}

export interface McpConnection {
  id: string;
  transport: 'streamable-http';
  protocolVersion: '2025-11-25' | '2026-07-28';
  endpoint: string;
  auth: ConnectionAuth;
  trustAnnotations: boolean;
  tools: Readonly<Record<string, LocalToolPolicy>>;
}

const connections = {
  raindrop: {
    id: 'raindrop',
    transport: 'streamable-http',
    protocolVersion: '2026-07-28',
    endpoint: 'https://raindrop-mcp-worker.aiyaya.workers.dev/mcp',
    auth: {
      header: 'Authorization',
      format: 'bearer',
      secret: 'RAINDROP_MCP_ACCESS_TOKEN'
    },
    trustAnnotations: false,
    tools: {
      list_raindrops: { effect: 'read' }
    }
  },
  'smoke-readonly': {
    id: 'smoke-readonly',
    transport: 'streamable-http',
    protocolVersion: '2025-11-25',
    endpoint: 'https://example.invalid/mcp',
    auth: {
      header: 'Authorization',
      format: 'bearer',
      secret: 'SMOKE_READONLY_MCP_TOKEN'
    },
    trustAnnotations: false,
    tools: {
      health_check: { effect: 'read' }
    }
  },
  'smoke-modern': {
    id: 'smoke-modern',
    transport: 'streamable-http',
    protocolVersion: '2026-07-28',
    endpoint: 'https://workflow-mcp-worker.aiyaya.workers.dev/mcp',
    auth: {
      header: 'Authorization',
      format: 'bearer',
      secret: 'MCP_ACCESS_TOKEN'
    },
    trustAnnotations: false,
    tools: {
      workflow_list: { effect: 'read' }
    }
  }
} as const satisfies Record<string, McpConnection>;

export function getConnection(id: string): McpConnection | undefined {
  return connections[id as keyof typeof connections];
}

export function resolveConnection(
  env: object,
  id: string
): McpConnection | undefined {
  const connection = getConnection(id);
  if (!connection) return undefined;
  const record = env as Record<string, unknown>;
  const overrideKey =
    id === 'smoke-readonly'
      ? 'SMOKE_READONLY_MCP_ENDPOINT'
      : id === 'smoke-modern'
        ? 'SMOKE_MODERN_MCP_ENDPOINT'
        : undefined;
  if (!overrideKey) return connection;

  const endpoint = record[overrideKey];
  if (typeof endpoint !== 'string' || endpoint.length === 0) return connection;
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`MCP connection "${id}" endpoint override must use HTTP(S).`);
  }
  return { ...connection, endpoint: parsed.toString() };
}

export function hasConnection(id: string): boolean {
  return getConnection(id) !== undefined;
}

export function getLocalToolPolicy(
  connectionId: string,
  toolName: string
): LocalToolPolicy | undefined {
  return getConnection(connectionId)?.tools[toolName];
}

export function buildConnectionAuthHeader(
  connection: McpConnection,
  secretValue: string
): { name: string; value: string } {
  const auth = connection.auth;
  if (auth.format === 'raw') return { name: auth.header, value: secretValue };
  if (auth.format === 'bearer') return { name: auth.header, value: `Bearer ${secretValue}` };
  return { name: auth.header, value: `${auth.prefix}${secretValue}` };
}

export function readConnectionSecret(
  env: object,
  connection: McpConnection
): string | undefined {
  const value = (env as Record<string, unknown>)[connection.auth.secret];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
