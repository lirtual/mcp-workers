import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { verifyRaindropOutput } from './raindrop-verification.js';

const baseUrl = required('WORKFLOW_MCP_URL').replace(/\/+$/, '');
const accessToken = required('WORKFLOW_MCP_ACCESS_TOKEN');
const evidencePath = process.env.WORKFLOW_MCP_RAINDROP_EVIDENCE_PATH || 'workflow-mcp-raindrop-evidence.json';
const timeoutMs = 3 * 60 * 1000;
const pollMs = 3000;
const workflowId = 'raindrop-daily-snapshot';

const list = await callTool('workflow_list', {});
const entry = asArray(list.workflows)
  .map(asObject)
  .find(item => item.id === workflowId);
if (!entry) throw new Error('Deployed registry does not contain Raindrop snapshot.');
const digest = nonempty(entry, 'definitionDigest');
const triggerTypes = asArray(entry.triggerTypes);
if (!triggerTypes.includes('manual') || !triggerTypes.includes('schedule')) {
  throw new Error('Deployed Raindrop workflow does not expose manual and schedule triggers.');
}
const details = await callTool('workflow_get', { workflow: workflowId });
if (asObject(details.workflow).definitionDigest !== digest) {
  throw new Error('Raindrop registry digest differs between workflow_list and workflow_get.');
}

const admission = await callTool('workflow_run', {
  workflow: workflowId,
  input: {},
  idempotencyKey: 'raindrop-manual-' + (process.env.GITHUB_RUN_ID || randomUUID())
});
const runId = nonempty(admission, 'runId');
if (admission.definitionDigest !== digest) {
  throw new Error('Raindrop admitted a definition differing from the deployed registry. Run ID: ' + runId);
}

const deadline = Date.now() + timeoutMs;
let status: Record<string, unknown> | undefined;
while (Date.now() < deadline) {
  status = await callTool('workflow_status', { runId });
  if (['succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate'].includes(String(status.state))) break;
  await new Promise(resolve => setTimeout(resolve, pollMs));
}
if (!status || status.state !== 'succeeded') {
  throw new Error('Raindrop manual Run did not succeed: ' + runId +
    ' state=' + String(status?.state ?? 'poll_timeout') +
    ' errorCode=' + String(status?.errorCode ?? 'none'));
}
if (status.workflowId !== workflowId || status.definitionDigest !== digest) {
  throw new Error('Raindrop Run status provenance is inconsistent: ' + runId);
}

const result = await callTool('workflow_result', { runId });
if (result.ready !== true || result.state !== 'succeeded') {
  throw new Error('Raindrop workflow_result is not terminal success: ' + runId);
}
const validated = verifyRaindropOutput(result.outputs);
const logs = await callTool('workflow_logs', { runId, cursor: 0, limit: 100 });
const lifecycleEvents = asArray(logs.events).map(item => asObject(item).eventType);

const evidence = {
  verifiedAt: new Date().toISOString(),
  deploymentCommit: process.env.GITHUB_SHA || null,
  workflowId,
  runId,
  state: status.state,
  definitionDigest: digest,
  engineVersion: status.engineVersion ?? null,
  cfWorkflowVersionId: status.cfWorkflowVersionId ?? null,
  startedAt: status.startedAt ?? null,
  endedAt: status.endedAt ?? null,
  ...validated,
  lifecycleEvents
};
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
const outputPath = process.env.GITHUB_OUTPUT;
if (outputPath) {
  appendFileSync(outputPath, 'raindrop_run_id=' + runId + '\n', 'utf8');
}
console.log(JSON.stringify(evidence, null, 2));

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const response = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: requestId, method: 'tools/call',
      params: {
        name, arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'raindrop-manual-verifier', version: '0.1.0' },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
  if (!response.ok) throw new Error('MCP ' + name + ' returned HTTP ' + response.status);
  const text = await response.text();
  const envelope = parseEnvelope(text, response.headers.get('content-type'));
  if (envelope.error) throw new Error('MCP ' + name + ' returned an RPC error.');
  const reply = asObject(envelope.result);
  if (reply.isError === true) {
    const body = asObject(reply.structuredContent || {});
    const code = asObject(body.error || {}).code;
    throw new Error('MCP ' + name + ' failed: ' + String(code || 'tool_error'));
  }
  if (reply.structuredContent) return asObject(reply.structuredContent);
  const textItem = asArray(reply.content).map(asObject)
    .find(item => item.type === 'text' && typeof item.text === 'string');
  if (!textItem) throw new Error('MCP ' + name + ' returned no result.');
  return asObject(JSON.parse(String(textItem.text)));
}

function parseEnvelope(text: string, contentType: string | null): Record<string, unknown> {
  if (!contentType?.includes('text/event-stream')) return asObject(JSON.parse(text));
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (data) return asObject(JSON.parse(data));
  }
  throw new Error('MCP SSE response contained no JSON-RPC result.');
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object in Raindrop verifier.');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array in Raindrop verifier.');
  return value;
}

function nonempty(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field) throw new Error('Missing ' + key + ' in Raindrop verifier.');
  return field;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required for Raindrop manual verification.');
  return value;
}
