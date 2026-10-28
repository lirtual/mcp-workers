import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLegacyRestoreReadiness, verifyLegacyRestoreTarget } from './database-legacy-restore-preflight-344.mjs';
import { readFileSync } from 'node:fs';

const id = 'eb3f4823-124b-4d76-abdc-42f85097bb5a';
const defaultBindings = [
  { name: 'DATABASE_CONFIG', type: 'secret_text' },
  { name: 'MCP_ACCESS_TOKEN', type: 'secret_text' },
  { name: 'RATE_LIMITER', type: 'ratelimit' }
];
function fixture() {
  return {
    deployments: [{ versions: [{ version_id: id, percentage: 100 }] }],
    versions: [{ id }],
    oldVersion: { id, resources: { bindings: structuredClone(defaultBindings) } }
  };
}
test('legacy Worker version eligible, full original bindings, and current 100% are verified read-only', () => {
  assert.deepEqual(verifyLegacyRestoreTarget(fixture()), {
    ready: true, legacyVersionId: id, activeLegacy: true
  });
  const later = fixture();
  later.deployments[0].versions[0].version_id = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(verifyLegacyRestoreTarget(later).activeLegacy, false);
});
test('fail closed for evicted version, deleted Secret, D1 binding and malformed active deployment', () => {
  for (const mutate of [
    x => { x.deployments = []; },
    x => { x.versions = []; },
    x => { x.oldVersion.id = 'wrong'; },
    x => { x.oldVersion.resources.bindings.splice(0, 1); },
    x => { x.oldVersion.resources.bindings[1].type = 'plain_text'; },
    x => { x.oldVersion.resources.bindings.push({ name: 'DB', type: 'd1' }); },
    x => { x.oldVersion.resources.bindings.push({ name: 'DATABASE_CONFIG', type: 'secret_text' }); },
    x => { x.deployments[0].versions = [{ version_id: id, percentage: 90 }]; },
    x => { x.deployments[0].versions[0].percentage = -1; }
  ]) {
    const data = fixture();
    mutate(data);
    assert.throws(() => verifyLegacyRestoreTarget(data), /recovery target unavailable/);
  }
});
test('API inspection uses exactly three GETs; no version deployment or secret output', async () => {
  const input = fixture();
  const env = {
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'lirtual',
    GITHUB_SHA: 'a'.repeat(40),
    CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'synthetic-test-token'
  };
  const calls = [];
  const get = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
    assert.equal(options.method, undefined);
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    calls.push(url);
    const result = url.endsWith('/deployments')
      ? { deployments: input.deployments }
      : url.includes('?deployable=true&per_page=100')
        ? { items: input.versions } : input.oldVersion;
    return { ok: true, json: async () => ({ success: true, result }) };
  };
  const result = await checkLegacyRestoreReadiness(env, get);
  assert.equal(result.ready, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(x => x.startsWith('https://api.cloudflare.com/client/v4/accounts/')));
  await assert.rejects(checkLegacyRestoreReadiness({ ...env, GITHUB_ACTOR: 'other' }, get));
  assert.equal(calls.length, 3);
});
test('current release workflow runs recovery attestation before first Database publication', () => {
  const source = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const check = source.indexOf('Verify original Database Worker recovery version before publication');
  const publish = source.indexOf('Publish exactly selected Worker');
  assert.ok(check > 0 && publish > check);
  const fragment = source.slice(check, publish);
  for (const text of [
    "if: inputs.worker == 'database-mcp-worker'",
    'CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
    'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'node scripts/database-legacy-restore-preflight-344.mjs'
  ]) assert.ok(fragment.includes(text), 'Missing protected recovery check: ' + text);
  assert.doesNotMatch(fragment, /run:.*(?:wrangler (?:deploy|rollback)|POST.*deployments)/i);
});
