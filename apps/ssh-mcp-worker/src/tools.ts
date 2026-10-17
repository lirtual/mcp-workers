import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHost, HostError, listHosts } from './hosts.ts';
import type { Env } from './types.ts';
import { MCP_TOOL_RESULT_MAX_BYTES, serializeMcpToolResult } from './result-budget.ts';
import { validExecInput } from './validation.ts';

function success(value: unknown) {
  const serialized = serializeMcpToolResult(value);
  if (serialized.byteLength > MCP_TOOL_RESULT_MAX_BYTES) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'result_too_large' }) }] };
  }
  return { content: [{ type: 'text' as const, text: serialized.text }] };
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
  server.registerTool('ssh_exec', {
    description: 'Execute one bounded command on a saved, publicly reachable host with a pinned SSH host key and durable operation receipt.',
    inputSchema: z.object({
      host_id: z.string().uuid(),
      command: z.string().min(1),
      operation_id: z.string().uuid(),
      timeout_ms: z.number().int().min(1_000).max(60_000).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ host_id, command, operation_id, timeout_ms }) => {
    const timeoutMs = timeout_ms ?? 30_000;
    const invalid = validExecInput(host_id, operation_id, command, timeoutMs);
    if (invalid) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: invalid }) }] };
    try {
      const stub = env.SSH_OPERATIONS.getByName('single-admin-operations');
      return success(await stub.execute({ hostId: host_id, operationId: operation_id, command, timeoutMs }));
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  });
  server.registerTool('get_operation_status', {
    description: 'Read the durable status of one SSH operation without dispatching it.',
    inputSchema: z.object({ operation_id: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ operation_id }) => {
    try {
      const result = await env.SSH_OPERATIONS.getByName('single-admin-operations').getOperationStatus(operation_id);
      return result ? success(result) : { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'operation_not_found' }) }] };
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  });
  return server;
}
