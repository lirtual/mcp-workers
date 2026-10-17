import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHost, HostError, listHosts } from './hosts.ts';
import type { Env } from './types.ts';
import { fitsMcpToolResultBudget, MCP_TOOL_RESULT_MAX_BYTES, serializeMcpToolResult } from './result-budget.ts';
import type { SessionReply, SftpListReply, SftpReadReply } from './operations.ts';
import { validExecInput, validSessionInput, validSessionLookupInput, validSessionStartInput, validSessionStop, validSftpInput } from './validation.ts';

function success(value: unknown) {
  const serialized = serializeMcpToolResult(value);
  if (serialized.byteLength > MCP_TOOL_RESULT_MAX_BYTES) {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'result_too_large' }) }] };
  }
  return { content: [{ type: 'text' as const, text: serialized.text }] };
}

const outputEncoder = new TextEncoder();

function boundedPrefix(bytes: Uint8Array): { text: string; consumed: number } {
  for (let trim = 0; trim <= 3 && trim <= bytes.byteLength; trim++) {
    const consumed = bytes.byteLength - trim;
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, consumed)), consumed };
    } catch { /* a shorter prefix may end on a code-unit boundary */ }
  }
  return { text: '', consumed: 0 };
}

function sessionResult(reply: SessionReply) {
  if (reply.error === 'session_not_found') {
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'session_not_found' }) }] };
  }
  if (typeof reply.output !== 'string' || fitsMcpToolResultBudget(reply)) return success(reply);
  const encoded = outputEncoder.encode(reply.output);
  let low = 0;
  let high = encoded.byteLength;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = boundedPrefix(encoded.subarray(0, mid));
    const candidate = {
      ...reply,
      output: prefix.text,
      truncated: true,
      next_offset: (reply.output_offset ?? 0) + prefix.consumed,
    };
    if (fitsMcpToolResultBudget(candidate)) {
      best = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  const fitted = boundedPrefix(encoded.subarray(0, best));
  return success({
    ...reply,
    output: fitted.text,
    truncated: true,
    next_offset: (reply.output_offset ?? 0) + fitted.consumed,
  });
}

function fitSftpRead(reply: SftpReadReply) {
  if (reply.text === undefined || fitsMcpToolResultBudget(reply)) return success(reply);
  // No read offset exists, so an envelope overflow is a refusal, not a resumable prefix.
  return success({ status: 'failed', error: 'output_truncated', truncated: true });
}

function fitSftpList(reply: SftpListReply) {
  if (!reply.entries || fitsMcpToolResultBudget(reply)) return success(reply);
  let low = 0;
  let high = reply.entries.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = { ...reply, entries: reply.entries.slice(0, mid), truncated: true };
    if (fitsMcpToolResultBudget(candidate)) {
      best = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return success({ ...reply, entries: reply.entries.slice(0, best), truncated: true });
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
    instructions: 'Discover saved EdgeSSH hosts and run bounded SSH commands, managed shells, or short SFTP directory and UTF-8 reads. Credentials are never returned. SFTP reads do not keep a shell open. A managed shell can outlive one call, but output polling does not extend it and a lost shell is not reconnected. Interactive input is admitted once per operation id and is never rewritten. Stopping a shell closes only that owned channel and does not promise remote descendants were reaped.',
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
  const sftpSchema = z.object({
    host_id: z.string().uuid(),
    path: z.string().min(1),
    timeout_ms: z.number().int().min(1_000).max(60_000).optional(),
  }).strict();
  const runSftp = async (name: 'sftp_list' | 'sftp_read_text', hostId: string, path: string, timeoutMs: number) => {
    const invalid = validSftpInput(hostId, path, timeoutMs);
    if (invalid) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: invalid }) }] };
    try {
      const stub = env.SSH_OPERATIONS.getByName('single-admin-operations');
      const request = { hostId, path, timeoutMs };
      return name === 'sftp_list' ? fitSftpList(await stub.listDirectory(request)) : fitSftpRead(await stub.readText(request));
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  };
  server.registerTool('sftp_list', {
    description: 'List at most 100 entries in one remote directory over a short SSH connection. The connection closes when the call finishes and no mutation receipt is written.',
    inputSchema: sftpSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ host_id, path, timeout_ms }) => runSftp('sftp_list', host_id, path, timeout_ms ?? 30_000));
  server.registerTool('sftp_read_text', {
    description: 'Read one remote UTF-8 text file up to 64 KiB over a short SSH connection. Oversized, non-UTF-8, or over-budget content is refused without a file body. The connection closes when the call finishes.',
    inputSchema: sftpSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ host_id, path, timeout_ms }) => runSftp('sftp_read_text', host_id, path, timeout_ms ?? 30_000));
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
  server.registerTool('ssh_session_start', {
    description: 'Open one managed PTY shell on a saved host. The operation receipt is durable; the TCP session is not reconnected after loss.',
    inputSchema: z.object({
      host_id: z.string().uuid(),
      operation_id: z.string().uuid(),
      term_type: z.string().min(1).max(32).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ host_id, operation_id, term_type }) => {
    const invalid = validSessionStartInput(host_id, operation_id, term_type);
    if (invalid) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: invalid }) }] };
    try {
      const stub = env.SSH_OPERATIONS.getByName('single-admin-operations');
      return sessionResult(await stub.startSession({ hostId: host_id, operationId: operation_id, termType: term_type }));
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  });
  server.registerTool('ssh_session_input', {
    description: 'Send one UTF-8 PTY batch of at most 16 KiB to a live owned shell. The same operation id is never written twice; a changed batch conflicts. Uncertain bytes are not replayed.',
    inputSchema: z.object({
      session_id: z.string().uuid(),
      operation_id: z.string().uuid(),
      input: z.string(),
    }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ session_id, operation_id, input }) => {
    const invalid = validSessionInput(session_id, operation_id, input);
    if (invalid) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: invalid }) }] };
    try {
      const stub = env.SSH_OPERATIONS.getByName('single-admin-operations');
      return sessionResult(await stub.inputSession({ sessionId: session_id, operationId: operation_id, input }));
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  });
  server.registerTool('ssh_session_stop', {
    description: 'Close the SSH channel and TCP connection for one live owned shell. Detached remote processes are not observed. If the receipt cannot be stored, a provably live owned shell is still closed and the result is unknown.',
    inputSchema: z.object({
      session_id: z.string().uuid(),
      operation_id: z.string().uuid(),
    }).strict(),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ session_id, operation_id }) => {
    const invalid = validSessionStop(session_id, operation_id);
    if (invalid) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: invalid }) }] };
    try {
      const stub = env.SSH_OPERATIONS.getByName('single-admin-operations');
      return sessionResult(await stub.stopSession({ sessionId: session_id, operationId: operation_id }));
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  });
  server.registerTool('ssh_session_output', {
    description: 'Read at most 64 KiB of retained PTY output. Polling does not extend the session idle deadline or open a connection.',
    inputSchema: z.object({
      session_id: z.string().uuid(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(65_536).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ session_id, offset, limit }) => {
    const invalid = validSessionLookupInput(session_id, offset, limit);
    if (invalid) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: invalid }) }] };
    try {
      const stub = env.SSH_OPERATIONS.getByName('single-admin-operations');
      return sessionResult(await stub.readSessionOutput({ sessionId: session_id, offset, limit }));
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  });
  server.registerTool('ssh_session_status', {
    description: 'Read managed-shell liveness, deadlines and output cursor without creating an SSH connection.',
    inputSchema: z.object({ session_id: z.string().uuid() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ session_id }) => {
    const invalid = validSessionLookupInput(session_id);
    if (invalid) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: invalid }) }] };
    try {
      const stub = env.SSH_OPERATIONS.getByName('single-admin-operations');
      return sessionResult(await stub.readSessionStatus(session_id));
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: 'receipt_store_unavailable' }) }] };
    }
  });
  return server;
}
