import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyOpenListUpstream } from './openlist-upstream-integrity.mjs';

const VERSION = 'a4b63f6e-3ae6-4bca-9fef-441a89cb1e7d';
const KV_ID = '298dbc9310f948c796522911d0405379';
const env = { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_API_TOKEN: 'synthetic-token' };
const good = () => ({
  deployment: { success: true, result: { deployments: [{
    versions: [{ version_id: VERSION, percentage: 100 }],
  }] } },
  version: { success: true, result: { id: VERSION, resources: { bindings: [
    { name: 'KV', type: 'kv_namespace', namespace_id: KV_ID },
    { name: 'DB_DRIVER', type: 'plain_text', text: 'auto' },
  ] } } },
  publicSettings: { code: 200, message: 'success', data: { title: 'OpenList' } },
});

function mock(results, visited = []) {
  return async req => {
    assert.equal(req.method, 'GET');
    assert.equal(req.redirect, 'manual');
    const url = new URL(req.url);
    visited.push(req.url);
    const isPublic = url.hostname === 'openlist.lirtual.dpdns.org';
    if (isPublic) assert.equal(req.headers.has('authorization'), false);
    else assert.equal(req.headers.get('authorization'), 'Bearer synthetic-token');
    const value = isPublic ? results.publicSettings :
      url.pathname.endsWith('/deployments') ? results.deployment : results.version;
    return new Response(JSON.stringify(value), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
}

test('checks active 100% deployment KV identity, driver and live storage using only GET', async () => {
  const visited = [];
  assert.equal(await verifyOpenListUpstream(env, mock(good(), visited)), VERSION);
  assert.equal(visited.length, 3);
  assert.match(visited[0], /\/deployments\?per_page=1$/);
  assert.match(visited[1], /\/api\/public\/settings$/);
  assert.match(visited[2], /\/versions\/a4b63f6e-/);
});

test('rejects missing/swapped/duplicate KV and unexpected database driver', async () => {
  for (const mutate of [
    x => x.version.result.resources.bindings.shift(),
    x => x.version.result.resources.bindings[0].namespace_id = 'different',
    x => x.version.result.resources.bindings.push({ ...x.version.result.resources.bindings[0] }),
    x => x.version.result.resources.bindings[1].text = 'memory',
    x => x.version.result.resources.bindings.splice(1, 1),
  ]) {
    const value = good();
    mutate(value);
    await assert.rejects(verifyOpenListUpstream(env, mock(value)),
      /openlist_upstream_(kv_binding_drift|db_driver_drift)/);
  }
});

test('rejects non-100% deployment, wrong versions and Cloudflare errors', async () => {
  for (const mutate of [
    x => x.deployment.result.deployments[0].versions[0].percentage = 75,
    x => x.deployment.result.deployments[0].versions.push({ version_id: VERSION, percentage: 0 }),
    x => x.deployment.result.deployments = [],
    x => x.deployment.success = false,
    x => x.version.result.id = 'incorrect',
    x => x.version.success = false,
  ]) {
    const value = good();
    mutate(value);
    await assert.rejects(verifyOpenListUpstream(env, mock(value)),
      /openlist_upstream_(deployment_unavailable|active_version_ambiguous|version_unavailable)/);
  }
});

test('refuses NO_STORAGE, missing public data and stale success-like HTTP responses', async () => {
  for (const result of [
    { code: 503, message: 'STORAGE_CONFIG_ERROR / NO_STORAGE' },
    { code: 200, message: 'success' },
    { code: 500, message: 'error', data: {} },
  ]) {
    await assert.rejects(verifyOpenListUpstream(env,
      mock({ ...good(), publicSettings: result })), /openlist_upstream_storage_unavailable/);
  }
  await assert.rejects(verifyOpenListUpstream(env, async () =>
    new Response('error', { status: 503, headers: { 'content-type': 'text/plain' } })),
  /openlist_upstream_http_status/);
  await assert.rejects(verifyOpenListUpstream(env, async () =>
    new Response('redirect', { status: 302, headers: { location: 'https://invalid.example/' } })),
  /openlist_upstream_http_status/);
});

test('rejects invalid credentials and bounded/malformed JSON without leaking response content', async () => {
  for (const bad of [{ ...env, CLOUDFLARE_API_TOKEN: '' },
    { ...env, CLOUDFLARE_ACCOUNT_ID: '../wrong' }]) {
    await assert.rejects(verifyOpenListUpstream(bad, () => {
      throw new Error('should not call');
    }), /openlist_upstream_missing_credentials/);
  }
  for (const response of [
    new Response('secret contents', { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(131073), { headers: { 'content-type': 'application/json' } }),
    new Response('html', { headers: { 'content-type': 'text/html' } }),
  ]) {
    await assert.rejects(verifyOpenListUpstream(env, async () => response.clone()),
      error => /^openlist_upstream_[a-z_]+$/.test(error.message) &&
        !error.message.includes('secret'));
  }
});

test('scheduled-only upstream health reuses existing read probe and cannot dispatch writes', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/openlist-acceptance.yml', import.meta.url), 'utf8');
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /  schedule:\\n    - cron: '17 \\* \\* \\* \\*'/);
  const start = workflow.indexOf('  upstream-integrity:');
  const end = workflow.indexOf('  driver-e2e:', start);
  assert.ok(start > 0 && end > start);
  const scheduledJob = workflow.slice(start, end);
  assert.match(scheduledJob, /github.event_name == 'schedule'/);
  assert.match(scheduledJob, /github.ref == 'refs\\/heads\\/main'/);
  assert.match(scheduledJob, /node scripts\\/openlist-upstream-integrity\\.mjs/);
  assert.match(scheduledJob, /node scripts\\/openlist-production-read-smoke\\.mjs/);
  assert.doesNotMatch(scheduledJob, /(OPENLIST_API_TOKEN|confirm_disposable_write|wrangler deploy|register-openlist-portal)/);
  assert.match(release, /if: inputs.worker == 'openlist-mcp-worker'[\\s\\S]*?run: node scripts\\/openlist-upstream-integrity\\.mjs/);
});
