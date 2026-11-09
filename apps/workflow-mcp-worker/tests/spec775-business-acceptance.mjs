// One-shot Spec #775 business acceptance. Never print tokens, drafts, or download payloads.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const phase = process.env.SPEC775_PHASE;
assert.ok(phase === 'discover' || phase === 'accept', 'phase');
const token = process.env.MCP_ACCESS_TOKEN;
assert.ok(token, 'token missing');
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'spec775-business-acceptance', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL('https://workflow.lirtual.dpdns.org/mcp'), {
  requestInit: { headers: { authorization: 'Bearer ' + token } },
});
const OPENLIST = '0015e2e9-431d-4465-9adf-03191cb382f9';
const OLD_PLAN = '88071284-b7f3-4553-afe4-1ed3fc47972e';
const SESSIONS = [
  ['ubuntu', '4c3b0ab3-e41e-442a-8a73-2364889a8058', 'ubuntu_session'],
  ['windows', '00b1e052-f383-4d26-bef2-db49a97c72b9', 'windows_session'],
  ['code-server', '98f6ded3-796e-45cd-9ea4-dcc7e28fcaac', 'code_server_session'],
  ['chrome', '7a65cec7-f543-4df6-953d-3ffd3ec6d140', 'chrome_session'],
  ['openlist', OPENLIST, 'openlist_session'],
];
const DOWNLOAD = 'd98035d5-61fc-4da6-a573-80f4ba7a7e9c';
const KEY = 'spec775-accept-20261109';

function sql(statement) {
  const output = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute',
    'workflow-mcp-db', '--remote', '--json', '--command', statement], {
    cwd, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed[0]?.success, true, 'd1');
  assert.equal(parsed[0].meta.changes, 0, 'read must not write');
  return parsed[0].results ?? [];
}
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.[0]?.text ?? '';
  const value = text ? JSON.parse(text) : {};
  if (response.isError) throw new Error(name + ' ' + (value.error ?? 'error'));
  return value;
}
function schemaKeys(schema) {
  const props = schema && typeof schema === 'object' ? schema.properties : undefined;
  return props && typeof props === 'object' ? Object.keys(props).sort() : [];
}
async function waitRun(runId) {
  let last = '';
  for (let i = 0; i < 100; i++) {
    const state = await call('workflow_status', { run_id: runId });
    const steps = (state.steps ?? []).map(item => item.step_id + '=' + item.status).join(',');
    const line = state.status + ' ' + steps;
    if (line !== last) {
      console.log('RUN', runId, line);
      last = line;
    }
    if (['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  throw new Error('run_timeout ' + runId);
}

const openlist = {
  version: 1,
  name: 'openlist',
  inputs: { duration_minutes: 300 },
  steps: [
    {
      id: 'openlist_session',
      uses: 'action.run',
      with: {
        action_id: 'github.openlist',
        input: {
          duration_minutes: { ref: 'inputs.duration_minutes' },
          duration_mode: 'explicit',
        },
      },
    },
    {
      id: 'notify',
      needs: ['openlist_session'],
      uses: 'action.run',
      with: {
        action_id: 'bark.send_notification',
        input: {
          session_step_id: 'openlist_session',
          notification: {
            title: 'OpenList 临时会话已就绪',
            body: '点击此通知打开 OpenList，链接将在会话到期后失效。',
            ttl: 600,
            group: 'OpenList',
          },
        },
      },
    },
  ],
};

await client.connect(transport);
try {
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  console.log('TOOLS', names.join(','));
  assert.equal(names.includes('workflow_approval'), false);
  for (const name of ['workflow_pause', 'workflow_resume', 'workflow_cancel', 'workflow_publish', 'workflow_run', 'workflow_action_list'])
    assert.equal(names.includes(name), true, name);
  const catalog = await call('workflow_action_list', {});
  const actions = catalog.actions ?? [];
  console.log('ACTIONS', actions.map(action => action.action_id + '[' + schemaKeys(action.input_schema).join('|') + ']').join(','));
  for (const id of ['github.openlist', 'github.ubuntu', 'github.windows', 'github.code-server', 'github.chrome', 'github.download', 'bark.send_notification'])
    assert.equal(actions.some(action => action.action_id === id), true, id);
  if (phase === 'discover') {
    console.log('DISCOVER_OK');
    process.exit(0);
  }
  const before = await call('workflow_get', { workflow_id: OPENLIST });
  assert.equal(before.state, 'paused');
  assert.equal(before.published_version_id, OLD_PLAN);
  if (before.draft_revision === 24) {
    const validated = await call('workflow_validate', { definition: JSON.stringify(openlist) });
    if (validated.valid !== true) {
      console.log('ISSUES', (validated.issues ?? []).map(issue => issue.code + '@' + issue.path).join(','));
      throw new Error('openlist_definition_invalid');
    }
    const updated = await call('workflow_update', {
      workflow_id: OPENLIST, expected_revision: 24, definition: JSON.stringify(openlist),
    });
    assert.equal(updated.draft_revision, 25);
  }
  assert.equal(before.draft_revision === 24 || before.draft_revision === 25, true);
  const stored = await call('workflow_validate', { workflow_id: OPENLIST, revision: 25 });
  if (stored.valid !== true) {
    console.log('ISSUES', (stored.issues ?? []).map(issue => issue.code + '@' + issue.path).join(','));
    throw new Error('openlist_stored_definition_invalid');
  }
  let published;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20_000));
    try {
      published = await call('workflow_publish', { workflow_id: OPENLIST, expected_revision: 25 });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'publish_failed';
      console.log('PUBLISH_RETRY', attempt, message);
      if (attempt === 4 || !message.includes('invalid_definition')) throw error;
    }
  }
  assert.notEqual(published.published_version_id, OLD_PLAN);
  assert.equal(published.state, 'paused');
  const kept = sql(`SELECT count(*) AS n FROM workflow_versions WHERE id='${OLD_PLAN}' AND workflow_id='${OPENLIST}'`);
  assert.equal(kept[0].n, 1, 'old plan missing');
  console.log('OPENLIST_PUBLISHED', published.published_version_id);
  const resumed = await call('workflow_resume', { workflow_id: OPENLIST });
  assert.equal(resumed.state, 'active');
  for (const [name, id] of SESSIONS) {
    const started = await call('workflow_run', {
      workflow_id: id, inputs: { duration_minutes: 1 }, idempotency_key: KEY + '-' + name,
    });
    console.log('STARTED', name, started.run_id, started.published_version_id);
    const done = await waitRun(started.run_id);
    console.log('DONE', name, done.status);
    if (done.status !== 'succeeded') throw new Error(name + ' ' + done.status);
  }
  const prior = sql(`SELECT inputs FROM runs WHERE id='fb90ac23-f0ea-4ac9-b114-dc57877bfc0a' AND outcome='succeeded'`);
  const inputs = JSON.parse(prior[0].inputs);
  assert.equal(Array.isArray(inputs.download_batches) && inputs.download_batches.length, 1);
  const download = await call('workflow_run', {
    workflow_id: DOWNLOAD, inputs, idempotency_key: KEY + '-download',
  });
  console.log('STARTED', 'download', download.run_id, download.published_version_id);
  const downloadDone = await waitRun(download.run_id);
  console.log('DONE', 'download', downloadDone.status);
  if (downloadDone.status !== 'succeeded') throw new Error('download ' + downloadDone.status);
  console.log('ACCEPT_OK');
} finally {
  await client.close().catch(() => {});
}
