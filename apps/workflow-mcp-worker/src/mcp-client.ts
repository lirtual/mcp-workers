import * as z from 'zod/v4';
import {
  buildConnectionAuthHeader,
  getConnection,
  readConnectionSecret,
  type McpConnection
} from './connections.js';
import {
  authorizePinnedConnectionAttempt,
  readLiveConnectionControl,
  type PinnedConnectionAuthority
} from './connection-revocation.js';
import type { McpToolAnnotations } from './effective-policy.js';
import type { Env } from './types.js';

const MODERN_PROTOCOL = '2026-07-28';
const CLIENT_INFO = { name: 'workflow-mcp-worker', version: '0.1.0' };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

interface ServerInfo {
  name?: string;
  version?: string;
}

interface McpSession {
  era: 'modern' | 'legacy';
  protocolVersion: string;
  sessionId?: string;
  serverInfo?: ServerInfo;
}

export interface ToolInspection {
  connection: McpConnection;
  tool: McpTool;
  session: McpSession;
  dependencySnapshot: Record<string, unknown>;
}

export interface McpToolCallResult {
  result: Record<string, unknown>;
  dependencySnapshot: Record<string, unknown>;
}

interface RpcEnvelope {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  _meta?: Record<string, unknown>;
}

class McpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

class McpRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string
  ) {
    super(message);
  }
}

export class McpToolCallTransportError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function inspectMcpTool(
  env: Env,
  connectionId: string,
  toolName: string,
  fetchImpl: typeof fetch = fetch,
  approvedConnection?: McpConnection,
  options?: PinnedMcpCallOptions
): Promise<ToolInspection> {
  if (options && (options.pinned.connectionId !== connectionId || options.pinned.toolName !== toolName)) {
    throw new McpConnectionDeniedError();
  }
  const connection = approvedConnection ?? getConnection(connectionId);
  if (!connection) throw new Error(`MCP connection "${connectionId}" is not configured.`);

  const secret = readConnectionSecret(env, connection);
  if (!secret) throw new Error(`MCP connection "${connectionId}" credential is not configured.`);

  const requestFetch = options ? guardedFetch(fetchImpl, connectionId, options) : fetchImpl;
  const listed =
    connection.protocolVersion === MODERN_PROTOCOL
      ? await listToolsModern(connection, secret, requestFetch)
      : await listToolsLegacy(connection, secret, requestFetch);
  const { session, tools } = listed;

  const tool = tools.find(candidate => candidate.name === toolName);
  if (!tool) throw new Error(`MCP tool "${toolName}" was not found on connection "${connectionId}".`);

  return {
    connection,
    tool,
    session,
    dependencySnapshot: await dependencySnapshot(connectionId, tool, session.serverInfo)
  };
}

export interface PinnedMcpCallOptions {
  pinned: PinnedConnectionAuthority;
  db: D1Database;
  legacy?: boolean;
}

export class McpConnectionDeniedError extends Error {
  constructor() {
    super('MCP_CONNECTION_AUTHORITY_DENIED');
  }
}

/**
 * For versioned Runs, read live controls immediately before EACH outgoing request,
 * including discovery and tools/call. Keep pre-fetch rejection distinct from an
 * unknown transport outcome: no remote write was attempted when this guard fails.
 */
function guardedFetch(
  fetchImpl: typeof fetch,
  connectionId: string,
  options: PinnedMcpCallOptions
): typeof fetch {
  return (async (resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // A D1 read or decoding failure occurs before the external request. Treat
    // it as a fail-closed denial, never as an unknown transmitted write.
    let control;
    try {
      control = await readLiveConnectionControl(options.db, connectionId);
    } catch {
      throw new McpConnectionDeniedError();
    }
    const verdict = authorizePinnedConnectionAttempt(options.pinned, control);
    // Only pre-v0.2 static runs may use an absent control. Once a control
    // exists, emergency disable/tightening applies to them as well.
    if (!verdict.allowed && !(options.legacy && !control)) throw new McpConnectionDeniedError();
    if (String(resource) !== options.pinned.endpoint) throw new McpConnectionDeniedError();
    return fetchImpl(resource, init);
  }) as typeof fetch;
}

/** Run-aware discovery must use the same live authorization boundary as tools/call. */
export async function inspectPinnedMcpTool(
  env: Env,
  connectionId: string,
  toolName: string,
  options: PinnedMcpCallOptions,
  fetchImpl: typeof fetch = fetch
): Promise<ToolInspection> {
  if (options.pinned.connectionId !== connectionId || options.pinned.toolName !== toolName) {
    throw new McpConnectionDeniedError();
  }
  return inspectMcpTool(
    env, connectionId, toolName,
    guardedFetch(fetchImpl, connectionId, options),
    options.pinned.connection
  );
}

export async function callMcpTool(
  env: Env,
  connectionId: string,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  options?: PinnedMcpCallOptions
): Promise<McpToolCallResult> {
  if (options && (options.pinned.connectionId !== connectionId || options.pinned.toolName !== toolName)) {
    throw new McpConnectionDeniedError();
  }
  const requestFetch = options ? guardedFetch(fetchImpl, connectionId, options) : fetchImpl;
  const inspection = await inspectMcpTool(env, connectionId, toolName, requestFetch, options?.pinned.connection);
  validateToolArguments(inspection.tool, args);

  const secret = readConnectionSecret(env, inspection.connection);
  if (!secret) throw new Error(`MCP connection "${connectionId}" credential is not configured.`);

  try {
    const envelope =
      inspection.session.era === 'modern'
        ? await modernRpc(
            inspection.connection,
            secret,
            'tools/call',
            { name: toolName, arguments: args },
            requestFetch,
            toolName
          )
        : await legacyRpc(
            inspection.connection,
            secret,
            inspection.session,
            'tools/call',
            { name: toolName, arguments: args },
            requestFetch
          );

    const result = asObject(envelope.result, 'MCP tools/call result is invalid.');
    if (result.resultType === 'input_required') {
      throw new Error('MCP_INPUT_REQUIRED_UNSUPPORTED');
    }
    if (result.resultType === 'task') {
      throw new Error('MCP_TASK_RESULT_UNSUPPORTED');
    }
    if (result.isError === true) {
      throw new McpRpcError(undefined, extractToolError(result));
    }
    // A successful tool call must honor the discovered structured output contract.
    if (inspection.tool.outputSchema) {
      try {
        z.fromJSONSchema(
          inspection.tool.outputSchema as Parameters<typeof z.fromJSONSchema>[0]
        ).parse(result.structuredContent);
      } catch {
        throw new Error('MCP_OUTPUT_SCHEMA_MISMATCH: tools/call structuredContent does not match the discovered output schema.');
      }
    }

    return {
      result,
      dependencySnapshot: inspection.dependencySnapshot
    };
  } catch (error) {
    if (error instanceof McpRpcError || error instanceof McpConnectionDeniedError) throw error;
    throw new McpToolCallTransportError(
      error instanceof Error ? error.message : 'MCP tool call transport failed.'
    );
  }
}

function validateToolArguments(tool: McpTool, args: Record<string, unknown>): void {
  try {
    const schema = z.fromJSONSchema(
      tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]
    );
    schema.parse(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP tool input contract rejected the invocation.';
    throw new Error(`MCP_INPUT_SCHEMA_MISMATCH: ${message}`);
  }
}

async function listToolsModern(
  connection: McpConnection,
  secret: string,
  fetchImpl: typeof fetch
): Promise<{ session: McpSession; tools: McpTool[] }> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  let serverInfo: ServerInfo | undefined;

  for (let page = 0; page < 10; page += 1) {
    const envelope = await modernRpc(
      connection,
      secret,
      'tools/list',
      cursor ? { cursor } : {},
      fetchImpl
    );
    const result = asObject(envelope.result, 'MCP tools/list result is invalid.');
    const pageTools = Array.isArray(result.tools) ? result.tools.map(asTool) : [];
    tools.push(...pageTools);
    serverInfo ??= extractServerInfo(envelope, result);

    const next = result.nextCursor;
    if (typeof next !== 'string' || next.length === 0) {
      return {
        session: { era: 'modern', protocolVersion: connection.protocolVersion, ...(serverInfo ? { serverInfo } : {}) },
        tools
      };
    }
    cursor = next;
  }

  throw new Error('MCP tools/list pagination exceeded 10 pages.');
}

async function listToolsLegacy(
  connection: McpConnection,
  secret: string,
  fetchImpl: typeof fetch
): Promise<{ session: McpSession; tools: McpTool[] }> {
  const initialized = await rawPost(
    connection,
    secret,
    {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: connection.protocolVersion,
        capabilities: {},
        clientInfo: CLIENT_INFO
      }
    },
    fetchImpl,
    {}
  );

  const initResult = asObject(initialized.envelope.result, 'MCP initialize result is invalid.');
  const negotiatedVersion =
    typeof initResult.protocolVersion === 'string' ? initResult.protocolVersion : connection.protocolVersion;
  const serverInfo = isObject(initResult.serverInfo)
    ? {
        ...(typeof initResult.serverInfo.name === 'string' ? { name: initResult.serverInfo.name } : {}),
        ...(typeof initResult.serverInfo.version === 'string' ? { version: initResult.serverInfo.version } : {})
      }
    : undefined;
  const session: McpSession = {
    era: 'legacy',
    protocolVersion: negotiatedVersion,
    ...(initialized.sessionId ? { sessionId: initialized.sessionId } : {}),
    ...(serverInfo ? { serverInfo } : {})
  };

  await rawPost(
    connection,
    secret,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    fetchImpl,
    legacyHeaders(session),
    true
  );

  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const envelope = await legacyRpc(
      connection,
      secret,
      session,
      'tools/list',
      cursor ? { cursor } : {},
      fetchImpl
    );
    const result = asObject(envelope.result, 'MCP tools/list result is invalid.');
    tools.push(...(Array.isArray(result.tools) ? result.tools.map(asTool) : []));
    const next = result.nextCursor;
    if (typeof next !== 'string' || next.length === 0) return { session, tools };
    cursor = next;
  }

  throw new Error('MCP tools/list pagination exceeded 10 pages.');
}

async function modernRpc(
  connection: McpConnection,
  secret: string,
  method: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch,
  name?: string
): Promise<RpcEnvelope> {
  const meta = {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
    'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
    'io.modelcontextprotocol/clientCapabilities': {}
  };
  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method,
    params: { ...params, _meta: meta }
  };

  const headers: Record<string, string> = {
    'MCP-Protocol-Version': connection.protocolVersion,
    'Mcp-Method': method
  };
  if (name) headers['Mcp-Name'] = name;

  const response = await rawPost(connection, secret, body, fetchImpl, headers);
  return response.envelope;
}

async function legacyRpc(
  connection: McpConnection,
  secret: string,
  session: McpSession,
  method: string,
  params: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<RpcEnvelope> {
  const response = await rawPost(
    connection,
    secret,
    {
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params
    },
    fetchImpl,
    legacyHeaders(session)
  );
  return response.envelope;
}

function legacyHeaders(session: McpSession): Record<string, string> {
  return {
    'MCP-Protocol-Version': session.protocolVersion,
    ...(session.sessionId ? { 'Mcp-Session-Id': session.sessionId } : {})
  };
}

async function rawPost(
  connection: McpConnection,
  secret: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  extraHeaders: Record<string, string>,
  allowEmpty = false
): Promise<{ envelope: RpcEnvelope; sessionId?: string }> {
  const auth = buildConnectionAuthHeader(connection, secret);
  const response = await fetchImpl(connection.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      [auth.name]: auth.value,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new McpHttpError(response.status, `MCP HTTP request failed with status ${response.status}.`);
  }

  const text = await response.text();
  if (text.trim() === '' && allowEmpty) {
    return { envelope: {}, ...(sessionHeader(response) ? { sessionId: sessionHeader(response)! } : {}) };
  }
  const envelope = parseRpcEnvelope(text, response.headers.get('content-type'));
  if (envelope.error) {
    throw new McpRpcError(envelope.error.code, envelope.error.message ?? 'MCP JSON-RPC error.');
  }

  const sessionId = sessionHeader(response);
  return { envelope, ...(sessionId ? { sessionId } : {}) };
}

function parseRpcEnvelope(text: string, contentType: string | null): RpcEnvelope {
  if (contentType?.includes('text/event-stream')) {
    const events = text.split(/\r?\n\r?\n/);
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      const parsed: unknown = JSON.parse(data);
      if (isObject(parsed)) return parsed as RpcEnvelope;
    }
    throw new Error('MCP SSE response did not contain a JSON-RPC envelope.');
  }

  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error('MCP response is not a JSON-RPC object.');
  return parsed as RpcEnvelope;
}

function asTool(value: unknown): McpTool {
  const object = asObject(value, 'MCP tools/list contained an invalid tool.');
  if (typeof object.name !== 'string' || !isObject(object.inputSchema)) {
    throw new Error('MCP tools/list contained a tool without name/inputSchema.');
  }
  return {
    name: object.name,
    ...(typeof object.description === 'string' ? { description: object.description } : {}),
    inputSchema: object.inputSchema,
    ...(isObject(object.outputSchema) ? { outputSchema: object.outputSchema } : {}),
    ...(isObject(object.annotations) ? { annotations: object.annotations as McpToolAnnotations } : {})
  };
}

function extractServerInfo(envelope: RpcEnvelope, result: Record<string, unknown>): ServerInfo | undefined {
  const meta = isObject(result._meta) ? result._meta : envelope._meta;
  if (!meta) return undefined;
  const raw = meta['io.modelcontextprotocol/serverInfo'];
  if (!isObject(raw)) return undefined;
  return {
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {})
  };
}

async function dependencySnapshot(
  connectionId: string,
  tool: McpTool,
  serverInfo: ServerInfo | undefined
): Promise<Record<string, unknown>> {
  return {
    connection: connectionId,
    tool: tool.name,
    schemaDigest: await sha256Hex(stableStringify(tool.inputSchema)),
    ...(serverInfo?.name ? { serverName: serverInfo.name } : {}),
    ...(serverInfo?.version ? { serverVersion: serverInfo.version } : {})
  };
}

function extractToolError(result: Record<string, unknown>): string {
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter(isObject)
      .map(item => (item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join(' ')
      .slice(0, 500);
    if (text) return text;
  }
  return 'MCP tool reported an error result.';
}

function sessionHeader(response: Response): string | null {
  return response.headers.get('mcp-session-id') ?? response.headers.get('Mcp-Session-Id');
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(message);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
