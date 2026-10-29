import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFreshRegistry } from './database-fresh-readiness-344.mjs';

const freshId = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const env = { GITHUB_ACTOR: 'lirtual', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-ci-token',
  DATABASE_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString('base64'), DATABASE_KEY_ID: 'test_current' };
const ledger = (records = 0, retired = 0) => ({ migrations: 2, total: records, retired, reused: 0 });
function mocked({ rows = [], stats = ledger(rows.length), bindingId = freshId, version = 'c'.repeat(32),
  missingD1 = false } = {}) {
  const paths = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    paths.push({ path, method: options.method });
    if (path.includes('/d1/database/') && !path.includes(freshId)) throw Error('other D1 touched');
    if (options.method === 'POST' && !String(JSON.parse(options.body).sql).trim().startsWith('SELECT'))
      throw Error('non-read query');
    let result;
    if (path.endsWith('/settings')) result = { bindings: missingD1 ? [] : [{ name: 'DB', type: 'd1', id: bindingId }] };
    else if (path.endsWith('/deployments')) result = { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] };
    else if (path.includes(freshId)) result = [{ success: true, results: JSON.parse(options.body).sql.includes('d1_migrations') ? [stats] : rows }];
    else throw Error('unexpected API path');
    return { ok: true, json: async () => ({ success: true, result }) };
  };
  return { fetcher, paths };
}
test('managed D1 permits zero connections and never touches historical D1', async () => {
  const mock = mocked();
  assert.deepEqual(await checkFreshRegistry(env, mock.fetcher), { valid: true, phase: 'managed', records: 0 });
  assert.equal(mock.paths.filter(x => x.method === 'POST').length, 2);
  assert.equal(mock.paths.every(x => !x.path.includes('8853a6ac')), true);
});
test('rejects incomplete schema, incorrect inventory and reused retired IDs', async () => {
  for (const candidate of [
    { rows: [{ id: 'synthetic' }] },
    { stats: { ...ledger(), migrations: 1 } },
    { stats: { ...ledger(), reused: 1 } },
    { stats: { ...ledger(), total: 11 } }
  ]) await assert.rejects(checkFreshRegistry(env, mocked(candidate).fetcher), /preflight (?:rejected|failed)/);
});
test('rejects a missing or wrong D1 binding and missing owner identity', async () => {
  for (const candidate of [{ missingD1: true }, { bindingId: 'wrong' }]) {
    await assert.rejects(checkFreshRegistry(env, mocked(candidate).fetcher), /preflight (?:rejected|failed)/);
  }
  await assert.rejects(checkFreshRegistry({ ...env, GITHUB_ACTOR: 'unapproved' }, mocked().fetcher), /preflight (?:rejected|failed)/);
});

// Regression: activating a reviewed Hyperdrive in production must never block
// an unrelated routine code-only release. No live SQL or D1 writes here.
const mysqlHyperdrive = {
  id: 'aiven_mysql_openlist', dialect: 'mysql', transport: 'hyperdrive',
  status: 'active', revision: 2, key_id: null, ciphertext: null,
  config_id: '135ef2e15db049c68e99b0849f9a3da0',
  binding_name: 'HYPERDRIVE_AIVEN_OPENLIST'
};
const postgresHyperdrive = {
  id: 'aiven_pg_test', dialect: 'postgres', transport: 'hyperdrive',
  status: 'disabled', revision: 1, key_id: null, ciphertext: null,
  config_id: 'b2c7dab22f594bbca255827065e19bce',
  binding_name: 'HYPERDRIVE_AIVEN_POSTGRES'
};
test('fresh release accepts active reviewed OpenList Hyperdrive and disabled legacy PostgreSQL reference', async () => {
  const rows = [mysqlHyperdrive, postgresHyperdrive];
  const mock = mocked({ rows });
  assert.deepEqual(await checkFreshRegistry(env, mock.fetcher), {
    valid: true, phase: 'managed', records: 2
  });
  assert.equal(mock.paths.filter(p => p.method === 'POST').length, 2);
});
test('fresh release rejects activation of retired unbound PostgreSQL Hyperdrive', async () => {
  const mock = mocked({ rows: [{ ...postgresHyperdrive, status: 'active' }] });
  await assert.rejects(checkFreshRegistry(env, mock.fetcher), /preflight (?:rejected|failed)/);
});
test('fresh release rejects active Hyperdrive drift from reviewed manifest', async () => {
  for (const rows of [
    [{ ...mysqlHyperdrive, config_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
    [{ ...mysqlHyperdrive, binding_name: 'HYPERDRIVE_UNREVIEWED' }],
    [{ ...mysqlHyperdrive, dialect: 'postgres' }],
    [{ ...mysqlHyperdrive, ciphertext: 'unexpected' }]
  ]) {
    const mock = mocked({ rows });
    await assert.rejects(checkFreshRegistry(env, mock.fetcher), /preflight (?:rejected|failed)/);
  }
});
