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
  'workflow-self': {
    id: 'workflow-self',
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
