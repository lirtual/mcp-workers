import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFreshRegistry } from './database-fresh-readiness-344.mjs';

const oldVersion = 'eb3f4823-124b-4d76-abdc-42f85097bb5a';
const freshId = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const env = { GITHUB_ACTOR: 'lirtual', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_API_TOKEN: 'fake-ci-token',
  DATABASE_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString('base64'), DATABASE_KEY_ID: 'key-demo' };
const ledger = (records = 0, retired = 0) => ({ migrations: 2, total: records, retired, reused: 0 });
function mocked({ version = oldVersion, rows = [], stats = ledger(rows.length), bindingId = freshId } = {}) {
  const paths = [];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    paths.push({ path, method: options.method });
    if (path.includes('/d1/database/') && !path.includes(freshId)) throw Error('historical D1 touched');
    if (options.method === 'POST' && !String(JSON.parse(options.body).sql).trim().startsWith('SELECT'))
      throw Error('non-read query');
    const active = version === oldVersion;
    let result;
    if (path.endsWith('/settings')) result = { bindings: active
      ? [{ name: 'DATABASE_CONFIG', type: 'secret_text' }]
      : [{ name: 'DB', type: 'd1', id: bindingId }] };
    else if (path.endsWith('/deployments')) result = { deployments: [{ versions: [{ version_id: version, percentage: 100 }] }] };
    else if (path.includes(freshId)) result = [{ success: true, results: JSON.parse(options.body).sql.includes('d1_migrations') ? [stats] : rows }];
    else throw Error('unexpected API path');
    return { ok: true, json: async () => ({ success: true, result }) };
  };
  return { fetcher, paths };
}
test('first new-registry release allows schema-complete zero rows and never queries historical D1', async () => {
  const mock = mocked();
  assert.deepEqual(await checkFreshRegistry(env, mock.fetcher), { valid: true, phase: 'fresh', records: 0 });
  assert.equal(mock.paths.filter(x => x.method === 'POST').length, 2);
  assert.equal(mock.paths.every(x => !x.path.includes('8853a6ac')), true);
});
test('first publication rejects added rows, incomplete migrations and unexpected retired IDs', async () => {
  for (const candidate of [
    { rows: [{ id: 'sample_a' }] },
    { stats: { ...ledger(), migrations: 1 } },
    { stats: { ...ledger(), retired: 1 } }
  ]) await assert.rejects(checkFreshRegistry(env, mocked(candidate).fetcher), /preflight rejected/);
});
test('subsequent release may use an empty Owner-managed catalog without demanding historical IDs', async () => {
  const mock = mocked({ version: 'c'.repeat(8)+'-'+'d'.repeat(4)+'-4'+'e'.repeat(3)+'-8'+'f'.repeat(3)+'-'+'0'.repeat(12) });
  assert.deepEqual(await checkFreshRegistry(env, mock.fetcher), { valid: true, phase: 'managed', records: 0 });
});
test('rejects a wrong production D1 binding and missing GitHub identity', async () => {
  await assert.rejects(checkFreshRegistry(env, mocked({ version: 'new', bindingId: 'wrong' }).fetcher), /preflight rejected/);
  await assert.rejects(checkFreshRegistry({ ...env, GITHUB_ACTOR: 'unapproved' }, mocked().fetcher), /preflight rejected/);
});
