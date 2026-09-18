import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const baseUrl = required('WORKFLOW_MCP_STAGING_URL').replace(/\/+$/, '');
const accessToken = required('WORKFLOW_MCP_STAGING_ACCESS_TOKEN');
const sourceUrl = process.env.WORKFLOW_MCP_STAGING_SOURCE_URL || 'https://example.com/';
const evidencePath = process.env.STAGING_EVIDENCE_PATH || 'staging-evidence.json';
const timeoutMs = Number(process.env.STAGING_TIMEOUT_MS || 15 * 60 * 1000);
const pollMs = Number(process.env.STAGING_POLL_MS || 5000);

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  baseUrl,
  sourceUrl
};

await assertHealth();
const listed = await callTool('workflow_list', {});
const workflowIds = asArray(listed.workflows).map(item => stringField(asObject(item), 'id'));
for (const requiredWorkflow of ['web-archive-smoke', 'mcp-connection-smoke']) {
  if (!workflowIds.includes(requiredWorkflow)) {
    throw new Error(`Staging workflow_list is missing "${requiredWorkflow}".`);
  }
}

const heavyAdmission = await callTool('workflow_run', {
  workflow: 'web-archive-smoke',
  input: { url: sourceUrl },
  idempotencyKey: `staging-heavy-${process.env.GITHUB_RUN_ID || Date.now()}`
});
const heavyRunId = stringField(heavyAdmission, 'runId');
const heavyStatus = await waitForTerminal(heavyRunId, 'heavy');
if (heavyStatus.state !== 'succeeded') {
  throw new Error(`Heavy staging run ended as ${String(heavyStatus.state)}: ${JSON.stringify(heavyStatus)}`);
}
const heavyResult = await callTool('workflow_result', { runId: heavyRunId });
if (heavyResult.ready !== true || heavyResult.state !== 'succeeded') {
  throw new Error(`Heavy workflow_result was not succeeded/ready: ${JSON.stringify(heavyResult)}`);
}
const artifacts = asArray(heavyResult.artifacts);
if (artifacts.length < 1) throw new Error('Heavy staging run produced no canonical Artifact reference.');
const artifact = asObject(artifacts[0]);
const readUrl = stringField(artifact, 'readUrl');
const artifactResponse = await fetch(readUrl);
if (!artifactResponse.ok) {
  throw new Error(`Artifact GET failed with status ${artifactResponse.status}.`);
}
const artifactBytes = new Uint8Array(await artifactResponse.arrayBuffer());
if (artifactBytes.byteLength === 0) throw new Error('Artifact GET returned an empty object.');
const heavyLogs = await callTool('workflow_logs', { runId: heavyRunId, cursor: 0, limit: 100 });

const mcpAdmission = await callTool('workflow_run', {
  workflow: 'mcp-connection-smoke',
  input: {},
  idempotencyKey: `staging-mcp-${process.env.GITHUB_RUN_ID || Date.now()}`
});
const mcpRunId = stringField(mcpAdmission, 'runId');
const mcpStatus = await waitForTerminal(mcpRunId, 'mcp');
if (mcpStatus.state !== 'succeeded') {
  throw new Error(`MCP staging run ended as ${String(mcpStatus.state)}: ${JSON.stringify(mcpStatus)}`);
}
const mcpResult = await callTool('workflow_result', { runId: mcpRunId });
const mcpOutputs = asObject(mcpResult.outputs);
const nestedMcpResult = asObject(mcpOutputs.result);
const nestedStructured = asObject(nestedMcpResult.structuredContent);
if (asArray(nestedStructured.workflows).length < 2) {
  throw new Error('MCP smoke did not return the Workflow MCP workflow_list payload.');
}

Object.assign(evidence, {
  completedAt: new Date().toISOString(),
  heavy: {
    runId: heavyRunId,
    state: heavyStatus.state,
    engineVersion: heavyStatus.engineVersion,
    artifact: {
      artifactId: artifact.artifactId,
      name: artifact.name,
      mediaType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
      downloadedBytes: artifactBytes.byteLength
    },
    lifecycleEvents: asArray(heavyLogs.events).map(item => asObject(item).eventType)
  },
  mcp: {
    runId: mcpRunId,
    state: mcpStatus.state,
    returnedWorkflowCount: asArray(nestedStructured.workflows).length
  }
});

await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
appendGitHubOutput('heavy_run_id', heavyRunId);
appendGitHubOutput('mcp_run_id', mcpRunId);
appendGitHubOutput('evidence_path', evidencePath);
console.log(JSON.stringify(evidence, null, 2));

async function assertHealth(): Promise<void> {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error(`Staging health failed with status ${response.status}.`);
  const body = asObject(await response.json());
  if (body.status !== 'ok') throw new Error('Staging health payload is invalid.');
}

async function waitForTerminal(runId: string, label: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await callTool('workflow_status', { runId });
    if (['succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate'].includes(String(status.state))) {
      return status;
    }
    console.log(`[${label}] ${runId} state=${String(status.state)}`);
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${label} run ${runId}.`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'workflow-mcp-staging-tracer',
            version: '0.1.0'
          },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
  if (!response.ok) {
    throw new Error(`MCP ${name} HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  const envelope = parseEnvelope(await response.text(), response.headers.get('content-type'));
  if (envelope.error) throw new Error(`MCP ${name} RPC error: ${JSON.stringify(envelope.error)}`);
  const result = asObject(envelope.result);
  if (result.isError === true) {
    throw new Error(`MCP ${name} tool error: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return asObject(result.structuredContent);
  }
  const content = asArray(result.content);
  const textItem = content.map(asObject).find(item => item.type === 'text' && typeof item.text === 'string');
  if (!textItem) throw new Error(`MCP ${name} returned no structuredContent/text result.`);
  return asObject(JSON.parse(String(textItem.text)));
}

interface RpcEnvelope {
  result?: unknown;
  error?: unknown;
}

function parseEnvelope(text: string, contentType: string | null): RpcEnvelope {
  if (contentType?.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (data) return asObject(JSON.parse(data)) as RpcEnvelope;
    }
    throw new Error('MCP SSE response contained no JSON-RPC envelope.');
  }
  return asObject(JSON.parse(text)) as RpcEnvelope;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object in staging tracer.');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array in staging tracer.');
  return value;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`Expected non-empty string field "${key}".`);
  }
  return field;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendGitHubOutput(key: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const line = `${key}=${value}\n`;
  appendFileSync(path, line, 'utf8');
}
