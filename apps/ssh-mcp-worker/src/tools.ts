import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHost, HostError, listHosts } from './hosts.ts';
import type { Env } from './types.ts';

function success(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const code = error instanceof HostError ? error.code
    : error instanceof Error && error.message === 'host_catalog_unavailable' ? 'host_catalog_unavailable'
    : 'host_catalog_unavailable';
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] };
}

export function buildMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: 'ssh-mcp-worker', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Discover saved EdgeSSH hosts and their metadata. Host data is read from the existing catalog; credentials are never returned.',
  });
  server.registerTool('list_hosts', {
    description: 'List saved hosts with bounded pagination and sanitized SSH trust readiness.',
    inputSchema: z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try { return success(await listHosts(env, input)); }
    catch (error) { return failure(error); }
  });
  server.registerTool('get_host', {
    description: 'Get one saved host by ID with sanitized SSH trust readiness.',
    inputSchema: z.object({ host_id: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ host_id }) => {
    try { return success({ host: await getHost(env, host_id) }); }
    catch (error) { return failure(error); }
  });
  return server;
}
