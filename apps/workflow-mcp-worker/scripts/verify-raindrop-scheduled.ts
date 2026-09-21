import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { verifyRaindropOutput } from './raindrop-verification.js';
import {
  SNAPSHOT_SCHEDULE_KEY,
  SNAPSHOT_WORKFLOW_ID,
  parseExpectedNineAmUtc,
  verifyCompletedDeploy,
  verifyScheduledD1,
  type ScheduledDbRow,
  type SchedulerDbState
} from './scheduled-verification.js';

const baseUrl = required('WORKFLOW_MCP_URL').replace(/\/+$/, '');
const mcpToken = required('WORKFLOW_MCP_ACCESS_TOKEN');
const cloudflareToken = required('CLOUDFLARE_API_TOKEN');
const githubToken = required('GITHUB_TOKEN');
const expectedIso = required('WORKFLOW_MCP_EXPECTED_UTC');
const deployRunId = Number(required('WORKFLOW_MCP_DEPLOY_RUN_ID'));
const path = process.env.WORKFLOW_MCP_SCHEDULED_EVIDENCE_PATH ||
  'workflow-mcp-scheduled-evidence.json';
const expectedMs = parseExpectedNineAmUtc(expectedIso, Date.now());
if (!Number.isSafeInteger(deployRunId) || deployRunId < 1) {
  throw new Error('WORKFLOW_MCP_DEPLOY_RUN_ID must be a positive GitHub Actions run ID.');
}

const githubResponse = await fetch(
  'https://api.github.com/repos/lirtual/mcp-workers/actions/runs/' + deployRunId,
  { headers: {
    Authorization: 'Bearer ' + githubToken,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  } }
);
if (!githubResponse.ok) throw new Error('Cannot verify GitHub deployment: HTTP ' + githubResponse.status);
const deploy = verifyCompletedDeploy(asObject(await githubResponse.json()), expectedMs, deployRunId);

const d1Path = 'https://api.cloudflare.com/client/v4/accounts/' +
  '8bb496011403552e785ea1b834daffdf/d1/database/' +
  '238891f8-4007-4436-890d-819d54e3e01b/query';
const state = await d1Read<SchedulerDbState>(
  'SELECT schedule_key,last_evaluated_at,last_admitted_scheduled_time ' +
  'FROM scheduler_state WHERE schedule_key = ? LIMIT 2',
  [SNAPSHOT_SCHEDULE_KEY]
);
const rows = await d1Read<ScheduledDbRow>(
  'SELECT wr.run_id,wr.workflow_id,wr.state,wr.definition_digest,wr.engine_version,' +
  'wr.created_at,wr.started_at,wr.ended_at,ra.source_type,ra.source_key,' +
  "json_extract(wr.trigger_json, '$.type') AS trigger_type," +
  "json_extract(wr.trigger_json, '$.scheduledTime') AS scheduled_time " +
  'FROM run_admissions ra JOIN workflow_runs wr ON wr.run_id = ra.run_id ' +
  'WHERE ra.workflow_id = ? AND ra.source_type = ? AND ra.source_key = ? LIMIT 2',
  [SNAPSHOT_WORKFLOW_ID, 'schedule', String(expectedMs)]
);
const dbRun = verifyScheduledD1(state, rows, expectedMs);
const listed = await callTool('workflow_list', {});
const entry = asArray(listed.workflows).map(asObject)
  .find(item => item.id === SNAPSHOT_WORKFLOW_ID);
if (!entry || entry.definitionDigest !== dbRun.definition_digest) {
  throw new Error('Deployed registry digest does not match scheduled D1 Run.');
}
const details = await callTool('workflow_get', { workflow: SNAPSHOT_WORKFLOW_ID });
if (asObject(details.workflow).definitionDigest !== dbRun.definition_digest) {
  throw new Error('workflow_get digest does not match the scheduled D1 Run.');
}

const status = await callTool('workflow_status', { runId: dbRun.run_id });
if (status.runId !== dbRun.run_id || status.workflowId !== SNAPSHOT_WORKFLOW_ID ||
    status.definitionDigest !== dbRun.definition_digest || status.state !== dbRun.state ||
    status.engineVersion !== dbRun.engine_version) {
  throw new Error('MCP workflow_status disagrees with scheduled D1 Run.');
}
const logs = await callTool('workflow_logs', { runId: dbRun.run_id, cursor: 0, limit: 100 });
const events = asArray(logs.events).map(item => asObject(item).eventType);
if (!events.includes('run.admitted')) throw new Error('Scheduled lifecycle is missing run.admitted.');

const result = await callTool('workflow_result', { runId: dbRun.run_id });
if (result.runId !== dbRun.run_id || result.state !== status.state ||
    result.ready !== ['succeeded','failed','cancelled','timed_out','indeterminate'].includes(String(status.state))) {
  throw new Error('MCP workflow_result disagrees with D1 status or readiness.');
}
const success = status.state === 'succeeded' && result.ready === true;
const records = success ? verifyRaindropOutput(result.outputs) : null;
if (success && !events.includes('run.succeeded')) {
  throw new Error('Scheduled lifecycle is missing run.succeeded.');
}
const evidence = {
  verifiedAt: new Date().toISOString(),
  expectedUtcOccurrence: new Date(expectedMs).toISOString(),
  timezone: 'Asia/Shanghai',
  deployRunId,
  deployCommitSha: deploy.commitSha,
  deployCompletedAt: deploy.completedAt,
  scheduleKey: SNAPSHOT_SCHEDULE_KEY,
  schedulerLastEvaluatedAt: new Date(state[0]!.last_evaluated_at).toISOString(),
  runId: dbRun.run_id,
  triggerType: dbRun.trigger_type,
  state: status.state,
  definitionDigest: dbRun.definition_digest,
  engineVersion: dbRun.engine_version,
  startedAt: status.startedAt ?? null,
  endedAt: status.endedAt ?? null,
  ...(records ?? { errorCode: status.errorCode ?? 'unknown_failure' }),
  lifecycleEvents: events
};
await writeFile(path, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence, null, 2));
if (!success) {
  throw new Error('Real scheduled Run did not succeed; sanitized terminal evidence was saved.');
}

async function d1Read<T>(sql: string, params: string[]): Promise<T[]> {
  const response = await fetch(d1Path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + cloudflareToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, params })
  });
  if (!response.ok) throw new Error('Read-only D1 query failed: HTTP ' + response.status);
  const payload = asObject(await response.json());
  if (payload.success !== true) throw new Error('Cloudflare D1 read-only query failed.');
  const result = asArray(payload.result);
  if (result.length !== 1 || asObject(result[0]).success !== true) {
    throw new Error('Cloudflare D1 returned an unexpected query result.');
  }
  return asArray(asObject(result[0]).results) as T[];
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = randomUUID();
  const response = await fetch(baseUrl + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + mcpToken,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: {
        name, arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'raindrop-scheduled-verifier', version: '0.1.0'
          },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
  if (!response.ok) throw new Error('MCP ' + name + ' returned HTTP ' + response.status);
  const body = await response.text();
  const envelope = parseEnvelope(body, response.headers.get('content-type'), id);
  if (envelope.error) throw new Error('MCP ' + name + ' returned JSON-RPC error.');
  const reply = asObject(envelope.result);
  if (reply.isError === true) throw new Error('MCP ' + name + ' returned a tool error.');
  if (reply.structuredContent) return asObject(reply.structuredContent);
  const textPart = asArray(reply.content).map(asObject)
    .find(item => item.type === 'text' && typeof item.text === 'string');
  if (!textPart) throw new Error('MCP ' + name + ' returned no structured response.');
  return asObject(JSON.parse(String(textPart.text)));
}

function parseEnvelope(raw: string, contentType: string | null, id: string): Record<string, unknown> {
  if (contentType?.includes('text/event-stream')) {
    for (const event of raw.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const reply = asObject(JSON.parse(data));
      if (reply.id === id) return reply;
    }
    throw new Error('MCP SSE contained no matching JSON-RPC reply.');
  }
  const reply = asObject(JSON.parse(raw));
  if (reply.id !== id) throw new Error('MCP returned mismatched request ID.');
  return reply;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected structured response object.');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected structured response array.');
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required for scheduled verification.');
  return value;
}
