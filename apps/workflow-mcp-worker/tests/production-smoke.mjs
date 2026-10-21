// Deliberately narrow production acceptance: one temporary S1 echo workflow, no deployment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const token = process.env.MCP_ACCESS_TOKEN;
assert.ok(token, 'MCP_ACCESS_TOKEN must be present in GitHub Environment');
assert.ok(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID,
  'Cloudflare read/cleanup credentials must be present in GitHub Environment');

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://workflow.lirtual.dpdns.org';
const client = new Client({ name: 'workflow-s1-production-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
  requestInit: { headers: { authorization: 'Bearer ' + token } },
});
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = randomUUID();
const echo = 'workflow-s1-production-smoke-' + label;
let workflowId;
let runId;
let failure;

function sql(statement) {
  // stdout contains JSON only; do not log credentials, SQL args or Wrangler internals.
  const output = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute',
    'workflow-mcp-worker', '--remote', '--json', '--command', statement], {
    cwd, encoding: 'utf8', timeout: 45_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output);
  assert.ok(Array.isArray(parsed) && parsed[0]?.success, 'Remote D1 statement failed');
  return parsed[0].results ?? [];
}
function quotedId(id) {
  assert.match(id, uuid, 'invalid generated Workflow ID');
  return "'" + id + "'";
}
function workflowRows() {
  const id = quotedId(workflowId);
  return sql(`SELECT outcome FROM runs WHERE workflow_id = ${id}`);
}
function cleanup() {
  if (!workflowId) return;
  const id = quotedId(workflowId);
  const runs = workflowRows();
  if (runs.some(r => !terminal.has(r.outcome))) {
    throw Error('Refusing to delete temporary records: nonterminal Run still exists');
  }
  // Foreign-key order; scoped by the server-returned random Workflow UUID.
  sql(`DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ${id})`);
  sql(`DELETE FROM runs WHERE workflow_id = ${id}`);
  sql(`DELETE FROM workflow_versions WHERE workflow_id = ${id}`);
  sql(`DELETE FROM workflows WHERE id = ${id}`);
  const rows = sql(`SELECT
    (SELECT count(*) FROM workflows WHERE id = ${id}) AS workflows,
    (SELECT count(*) FROM workflow_versions WHERE workflow_id = ${id}) AS versions,
    (SELECT count(*) FROM runs WHERE workflow_id = ${id}) AS runs,
    (SELECT count(*) FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ${id})) AS steps`);
  assert.ok(rows.length === 1 && Object.values(rows[0]).every(n => n === 0),
    'Temporary D1 rows were not fully removed');
  console.log('CLEANUP_OK: temporary Workflow, versions, Runs and Steps are absent from D1');
}
async function tool(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(response.content?.[0]?.text, name + ' returned no text');
  const value = JSON.parse(response.content[0].text);
  assert.notEqual(response.isError, true, name + ' returned MCP error: ' + JSON.stringify(value));
  return value;
}
async function runSmoke() {
  // Fail closed if another production Run is unfinished or ambiguous.
  const outstanding = sql(`SELECT count(*) AS n FROM runs
    WHERE outcome NOT IN ('succeeded','failed','cancelled')`);
  assert.equal(outstanding[0]?.n, 0, 'Production has nonterminal Runs: smoke aborted before writes');

  await client.connect(transport);
  const listed = await client.listTools();
  for (const name of ['workflow_create', 'workflow_validate', 'workflow_publish',
    'workflow_run', 'workflow_status', 'workflow_result']) {
    assert.ok(listed.tools.some(t => t.name === name), 'Missing S1 tool ' + name);
  }
  assert.ok(!listed.tools.some(t => /s2|webhook|github/i.test(t.name)),
    'Unexpected S2/S3 tool exposed');

  const definition = {
    version: 1, name: echo,
    steps: [
      { id: 'read', uses: 's1.readonly_mcp',
        with: { tool: 'echo', arguments: { value: { ref: 'inputs.subject' } } } },
      { id: 'report', uses: 'result.emit',
        needs: ['read'], with: { data: { ref: 'steps.read.output' } } },
    ],
  };
  const draft = await tool('workflow_create', { definition: JSON.stringify(definition) });
  workflowId = draft.workflow_id;
  assert.match(workflowId, uuid);
  assert.equal(draft.state, 'draft');
  assert.equal(draft.draft_revision, 1);
  assert.equal((await tool('workflow_validate', { workflow_id: workflowId, revision: 1 })).valid, true);
  const published = await tool('workflow_publish', { workflow_id: workflowId, expected_revision: 1 });
  assert.ok(published.published_version_id);
  const inputs = { subject: echo };
  const key = 'prod-smoke-' + label;
  const started = await tool('workflow_run', {
    workflow_id: workflowId, inputs, idempotency_key: key,
  });
  runId = started.run_id;
  assert.match(runId, uuid);
  assert.equal(started.published_version_id, published.published_version_id);
  const replay = await tool('workflow_run', {
    workflow_id: workflowId, inputs, idempotency_key: key,
  });
  assert.equal(replay.run_id, runId, 'Idempotency must reuse the Run');

  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    status = await tool('workflow_status', { run_id: runId });
    if (terminal.has(status.status) || status.status === 'indeterminate') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(status?.status, 'succeeded', 'Native Workflow did not successfully finish');
  assert.equal(status.steps.length, 2);
  assert.ok(status.steps.every(s => s.status === 'succeeded'));
  const result = await tool('workflow_result', { run_id: runId });
  assert.equal(result.result?.content?.[0]?.text, echo);
  console.log('SMOKE_OK: authenticated Draft → Validate → Publish → Run → Result; idempotency and echo verified');
  console.log('Verified Workflow ID:', workflowId);
  console.log('Verified Run ID:', runId);
}
try {
  await runSmoke();
} catch (e) {
  failure = e;
  console.error('SMOKE_FAILED:', String(e?.message ?? e).replaceAll(token, '[redacted]'));
} finally {
  try { await client.close(); } catch { /* No successful state assumed from close */ }
  try { cleanup(); } catch (e) {
    failure ??= e;
    console.error('CLEANUP_FAILED:', String(e?.message ?? e).replaceAll(token, '[redacted]'));
    if (workflowId) console.error('Manual follow-up Workflow ID:', workflowId);
  }
}
if (failure) process.exitCode = 1;
