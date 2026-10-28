import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeVersion, LEGACY_VERSION, verifyRestoreIntent, restoreLegacyWorker } from './database-legacy-restore-344.mjs';

const current = '22222222-2222-4222-8222-222222222222';
const env = Object.freeze({
  GITHUB_ACTOR: 'lirtual', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-token',
  DATABASE_RESTORE_APPROVED: 'true', DATABASE_RESTORE_EXPECTED_VERSION: current
});
const originalBindings = ['DATABASE_CONFIG','MCP_ACCESS_TOKEN','RATE_LIMITER'].map(name =>
  ({ name, type: name === 'RATE_LIMITER' ? 'ratelimit' : 'secret_text' }));
function server({ refusal = false, active = current, asyncAck = false, oldBindings = originalBindings } = {}) {
  const calls = [];
  let posted = 0;
  let afterPostReads = 0;
  return {
    calls,
    fetch: async (url, options) => {
      assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${'b'.repeat(32)}/workers/scripts/database-mcp-worker/`));
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      assert.equal(options.redirect, 'error');
      calls.push({ url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/deployments') && options.method === 'POST') {
        posted++;
        assert.equal(posted, 1, 'never repeat a mutating request');
        assert.deepEqual(JSON.parse(options.body), {
          strategy: 'percentage', versions: [{version_id: LEGACY_VERSION, percentage: 100}],
          annotations: { 'workers/message': 'Spec 344 explicitly approved legacy Worker restore' }
        });
        return { ok: !refusal, json: async () => ({ success: !refusal, result: { id: 'new-deployment' } }) };
      }
      if (url.endsWith('/deployments')) {
        afterPostReads += posted;
        return { ok: true, json: async () => ({ success: true, result: { deployments: [
          { versions: [{version_id: posted && !asyncAck ? LEGACY_VERSION : active, percentage: 100}] }
        ] } }) };
      }
      if (url.includes('/versions?deployable=true')) return { ok: true, json: async () => ({
        success: true, result: { items: [{ id: LEGACY_VERSION }] }
      }) };
      if (url.endsWith('/versions/'+LEGACY_VERSION)) return { ok: true, json: async () => ({
        success: true, result: { id: LEGACY_VERSION, resources: { bindings: oldBindings } }
      }) };
      throw Error('unexpected endpoint');
    },
    get posted() {return posted},
    get afterPostReads() {return afterPostReads}
  };
}

test('recovery requires a new Owner-only protected exact-current-version approval', () => {
  assert.equal(verifyRestoreIntent(env), current);
  for (const change of [
    {GITHUB_ACTOR:'other'}, {GITHUB_REF:'refs/heads/feat/database-spec-344'},
    {GITHUB_SHA:'not-main'}, {CLOUDFLARE_API_TOKEN:undefined},
    {DATABASE_RESTORE_APPROVED:'false'}, {DATABASE_RESTORE_EXPECTED_VERSION:LEGACY_VERSION},
    {DATABASE_RESTORE_EXPECTED_VERSION:''}, {DATABASE_RESTORE_EXPECTED_VERSION:'attacker'}
  ]) assert.throws(() => verifyRestoreIntent({...env,...change}), /recovery blocked/);
  assert.equal(activeVersion({ deployments: [{versions:[{ version_id: current, percentage:100 }]}] }), current);
  for (const versions of [[], [{version_id:current,percentage:90}],
    [{version_id:current,percentage:50},{version_id:LEGACY_VERSION,percentage:50}]])
    assert.throws(() => activeVersion({deployments:[{versions}]}), /recovery blocked/);
});
test('single explicit legacy rollback POST only after read-only ready/current checks and 100% readback', async () => {
  const mock = server();
  assert.deepEqual(await restoreLegacyWorker(env, mock.fetch, async () => {}), {
    restored:true, activeVersion:LEGACY_VERSION, d1Changed:false
  });
  assert.equal(mock.posted, 1);
  const posts = mock.calls.filter(c=>c.method==='POST');
  assert.equal(posts.length, 1);
  assert.equal(mock.calls[0].method, 'GET');
  assert.equal(mock.calls.at(-1).method, 'GET');
  assert.equal(mock.calls.some(c=>c.url.includes('/d1/') || c.url.includes('/hyperdrive/')), false);
  assert.equal(posts[0].url.endsWith('/deployments'), true);
  assert.equal(posts[0].url.includes('force'), false);
});
test('never submits when active version is stale, legacy already active or old bindings missing', async () => {
  for(const options of [
    { active: '33333333-3333-4333-8333-333333333333' },
    { active: LEGACY_VERSION },
    { oldBindings: originalBindings.filter(x=>x.name!=='DATABASE_CONFIG') }
  ]) {
    const mock = server(options);
    await assert.rejects(restoreLegacyWorker(env,mock.fetch,async()=>{}), /recovery blocked|recovery target unavailable/);
    assert.equal(mock.posted,0);
  }
});
test('a refused POST or lost result never automatically retries a Worker mutation', async () => {
  const rejected = server({refusal:true});
  await assert.rejects(restoreLegacyWorker(env,rejected.fetch,async()=>{}), /recovery blocked/);
  assert.equal(rejected.posted,1);
  const delayed = server({asyncAck:true});
  let pauses = 0;
  await assert.rejects(restoreLegacyWorker(env,delayed.fetch,async()=>{pauses++}), /recovery blocked/);
  assert.equal(delayed.posted,1);
  assert.equal(pauses,5);
  assert.ok(delayed.afterPostReads >= 6);
});
test('protected recovery is exclusive with every other release/activation/preparation job', () => {
  const yaml = readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.match(yaml,/database_restore_approved:\n\s+description:.*\n\s+required: false\n\s+type: boolean\n\s+default: false/);
  assert.match(yaml,/database_restore_expected_version:\n\s+description:.*\n\s+required: false\n\s+type: string\n\s+default: ''/);
  const portion = name => {
    const begin=yaml.indexOf('\n  '+name+':\n');
    assert.ok(begin>0,'missing job '+name);
    const rest=yaml.slice(begin+1);
    const next=rest.search(/\n  [a-z][a-z0-9-]*:\n/);
    return yaml.slice(begin,next<0?undefined:begin+1+next);
  };
  for(const job of ['checks','deploy','database-activate','database-direct-preflight','database-prepare']) {
    assert.match(portion(job),/inputs\.database_restore_approved != true/);
  }
  const recovery = portion('database-restore');
  for (const gate of [
    "github.actor == 'lirtual'", "github.ref == 'refs/heads/main'",
    "inputs.worker == 'database-mcp-worker'", 'inputs.database_restore_approved == true',
    "inputs.database_restore_expected_version != ''", 'inputs.deploy_to_production == false',
    'inputs.database_prepare_approved != true', 'inputs.database_direct_preflight_approved != true',
    'inputs.database_activation_approved != true', "inputs.database_activation_id == ''",
    "inputs.database_activation_revision == ''", 'inputs.openlist_portal_registration != true',
    'name: database-mcp-worker', 'group: worker-release-database-mcp-worker',
    'git ls-remote origin refs/heads/main',
    'run: node scripts/database-legacy-restore-344.mjs'
  ]) assert.ok(recovery.includes(gate),'missing recovery protection '+gate);
  assert.doesNotMatch(recovery,/wrangler deploy|wrangler d1|database-prepare-344|activate-database-hyperdrive/);
});
