import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAivenHyperdrive } from './database-aiven-hyperdrive-prepare-344.mjs';

const caId = 'c9a71de0-06b0-4ea2-b2e8-2dfc27fb0d7a';
const cfg = [
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'db344-aiven-mysql-test', dialect: 'mysql',
    host: 'mysql-zeroverse.d.aivencloud.com', database: 'database-mcp-test-mysql', mode: 'VERIFY_IDENTITY' },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'db344-aiven-postgres-test', dialect: 'postgres',
    host: 'postgresql-zeroverse.d.aivencloud.com', database: 'database-mcp-test-postgres', mode: 'verify-full' }
];
const env = { GITHUB_ACTOR: 'lirtual', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
  CLOUDFLARE_ACCOUNT_ID: '8bb496011403552e785ea1b834daffdf',
  CLOUDFLARE_API_TOKEN: 'fixture-token', DATABASE_AIVEN_PROVISION_APPROVED: 'true',
  DATABASE_TEST_MYSQL_PASSWORD: 'masked-mysql', DATABASE_TEST_POSTGRES_PASSWORD: 'masked-pg' };
function mock({ present = [], badCA = false } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ method: init.method, path: new URL(url).pathname });
    assert.equal(init.headers.authorization, 'Bearer fixture-token');
    const base = url.endsWith('/hyperdrive/configs');
    let result;
    if (base && init.method === 'GET') result = present;
    else if (base && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const item = cfg.find(x => x.name === body.name);
      assert.ok(item);
      assert.equal(body.origin.password, item.dialect === 'mysql' ? 'masked-mysql' : 'masked-pg');
      assert.equal(body.caching.disabled, true);
      assert.equal(body.mtls.sslmode, item.mode);
      result = { id: item.id, name: item.name };
    } else {
      const item = cfg.find(x => url.endsWith('/' + x.id));
      assert.ok(item);
      result = { id: item.id, name: item.name, caching: { disabled: true },
        mtls: { sslmode: item.mode, ca_certificate_id: badCA ? 'wrong-ca' : caId },
        origin: { scheme: item.dialect, host: item.host, port: 18691,
          database: item.database, user: 'test' } };
    }
    return { ok: true, json: async () => ({ success: true, result }) };
  };
  return { fetcher, calls };
}
test('requires exact Owner, approved main, credentials before any call', async () => {
  for (const invalid of [{ GITHUB_ACTOR: 'intruder' }, { GITHUB_REF: 'refs/heads/dev' },
    { DATABASE_AIVEN_PROVISION_APPROVED: 'false' }, { DATABASE_TEST_MYSQL_PASSWORD: '' }]) {
    await assert.rejects(prepareAivenHyperdrive({ ...env, ...invalid }, () => { throw Error('network not allowed'); }), /rejected/);
  }
});
test('creates exactly two strict and cache-disabled Aiven configurations, without Worker or D1 changes', async () => {
  const f = mock();
  const result = await prepareAivenHyperdrive(env, f.fetcher);
  assert.equal(result.length, 2);
  assert.equal(result.every(x => x.tls === 'strict' && x.cache === 'disabled'), true);
  assert.deepEqual(f.calls.map(x => x.method), ['GET', 'POST', 'GET', 'POST', 'GET']);
  assert.equal(f.calls.every(x => x.path.includes('/hyperdrive/configs')), true);
});
test('rechecks existing named configs without duplicating POST and rejects incorrect CA', async () => {
  const f = mock({ present: cfg });
  assert.equal((await prepareAivenHyperdrive(env, f.fetcher)).length, 2);
  assert.deepEqual(f.calls.map(x => x.method), ['GET', 'GET', 'GET']);
  const wrong = mock({ present: cfg, badCA: true });
  await assert.rejects(prepareAivenHyperdrive(env, wrong.fetcher), /verification failed/);
  assert.equal(wrong.calls.some(x => x.method === 'POST'), false);
});
