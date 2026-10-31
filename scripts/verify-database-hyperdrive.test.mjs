import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCloudflareHyperdriveConfig, verifyDatabaseHyperdriveCloudReadback, safeReadbackFailureCode, verifyApprovedAccountScope } from './verify-database-hyperdrive.mjs';

const configId = '12345678-1234-1234-1234-123456789abc';
const caId = 'abcd1234-0000-1111-2222-123456789abc';
const manifest = [{
  binding: 'HYPERDRIVE_MYSQL', id: configId, dialect: 'mysql',
  origin_host: 'mysql.example.net', origin_port: 3306,
  origin_database: 'customer', origin_user: 'test-reader', ca_certificate_id: caId
}];
const source = { hyperdrive: [{ binding: manifest[0].binding, id: manifest[0].id }] };
const cloudConfig = {
  id: configId, caching: { disabled: true },
  mtls: { sslmode: 'VERIFY_IDENTITY', ca_certificate_id: caId },
  origin: { scheme: 'mysql', host: 'mysql.example.net', port: 3306, database: 'customer', user: 'test-reader' }
};
const options = {
  source, manifest, accountId: '11111111111111111111111111111111', token: 'fixture-token',
  request: async (_url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    return { ok: true, json: async () => ({ success: true, result: cloudConfig }) };
  }
};

test('empty protected config is an explicitly inactive safe state', async () => {
  assert.deepEqual(await verifyDatabaseHyperdriveCloudReadback({
    source: {}, manifest: [], accountId: undefined, token: undefined,
    request: () => { throw Error('unexpected network access'); }
  }), { verified: 0 });
});
test('independently reads strict certificate and source origin with disabled caching', async () => {
  assert.deepEqual(await verifyDatabaseHyperdriveCloudReadback(options), { verified: 1 });
});
test('does not trust wrong Cloudflare TLS mode, CA, cache, dialect, origin or config ID', () => {
  for (const observed of [
    { ...cloudConfig, caching: { disabled: false } },
    { ...cloudConfig, mtls: { ...cloudConfig.mtls, sslmode: 'REQUIRED' } },
    { ...cloudConfig, mtls: { ...cloudConfig.mtls, sslmode: 'VERIFY_CA' } },
    { ...cloudConfig, mtls: { ...cloudConfig.mtls, ca_certificate_id: 'other-ca' } },
    { ...cloudConfig, origin: { ...cloudConfig.origin, host: 'attacker.example.org' } },
    { ...cloudConfig, origin: { ...cloudConfig.origin, port: 3307 } },
    { ...cloudConfig, origin: { ...cloudConfig.origin, database: 'wrong' } },
    { ...cloudConfig, origin: { ...cloudConfig.origin, user: 'privileged' } },
    { ...cloudConfig, origin: { ...cloudConfig.origin, user: undefined } },
    { ...cloudConfig, origin: { ...cloudConfig.origin, scheme: 'postgres' } },
    { ...cloudConfig, id: 'different-config-id' }
  ]) assert.throws(() => verifyCloudflareHyperdriveConfig(manifest[0], observed), /verification failed/);
});
test('requires an approved host and strict postgres verify-full', () => {
  const postgres = { ...manifest[0], binding: 'HYPERDRIVE_POSTGRES', dialect: 'postgres' };
  assert.equal(verifyCloudflareHyperdriveConfig(postgres, {
    ...cloudConfig, mtls: { ...cloudConfig.mtls, sslmode: 'verify-full' },
    origin: { ...cloudConfig.origin, scheme: 'postgres' }
  }), true);
  assert.throws(() => verifyCloudflareHyperdriveConfig({ ...postgres, origin_user: undefined }, cloudConfig));
  for (const host of ['localhost', '127.0.0.1', 'internal', 'bad..example.com']) {
    assert.throws(() => verifyCloudflareHyperdriveConfig({ ...manifest[0], origin_host: host }, cloudConfig));
  }
});
test('requires Cloudflare access, exact manifest/source matching and successful GET', async () => {
  await assert.rejects(verifyDatabaseHyperdriveCloudReadback({ ...options, token: undefined }), /read-only/);
  await assert.rejects(verifyDatabaseHyperdriveCloudReadback({ ...options, source: { hyperdrive: [] } }), /manifest/);
  await assert.rejects(verifyDatabaseHyperdriveCloudReadback({
    ...options, request: async () => ({ ok: false, json: async () => ({ error: 'secret' }) })
  }), /rejected/);
  await assert.rejects(verifyDatabaseHyperdriveCloudReadback({
    ...options, request: async () => { throw Error('sensitive database password'); }
  }), /unavailable/);
});

test('release diagnostic allows only fixed codes and never prints thrown secret/error text', () => {
  assert.equal(safeReadbackFailureCode(new Error(
    'Database Hyperdrive verification failed: origin identity differs from reviewed source'
  )), 'origin_mismatch');
  assert.equal(safeReadbackFailureCode(new Error(
    'Database Hyperdrive verification failed: Cloudflare configuration read rejected'
  )), 'cloudflare_read_rejected');
  assert.equal(safeReadbackFailureCode(new Error(
    'Database Hyperdrive manifest/source mismatch'
  )), 'manifest_mismatch');
  for (const unexpected of [
    new Error('Database Hyperdrive verification failed: Origin password=sensitive'),
    new Error('Cloudflare secret response details'),
    { message: 'Database Hyperdrive verification failed: origin identity differs from reviewed source' },
    null
  ]) assert.equal(safeReadbackFailureCode(unexpected), 'unknown');
});

test('classifies only bounded HTTP read failures while discarding provider content', async () => {
  for (const [status, expectedCode] of [
    [401, 'cloudflare_read_401_slot_1'],
    [403, 'cloudflare_read_403_slot_1'],
    [404, 'cloudflare_read_404_slot_1'],
    [429, 'cloudflare_read_429_slot_1'],
    [503, 'cloudflare_read_5xx_slot_1'],
    [418, 'cloudflare_read_other_slot_1']
  ]) {
    await assert.rejects(
      verifyDatabaseHyperdriveCloudReadback({
        ...options,
        request: async () => ({
          ok: false, status,
          json: async () => ({ password: 'must-never-be-read-or-logged' })
        })
      }),
      error => {
        assert.equal(safeReadbackFailureCode(error), expectedCode);
        assert.doesNotMatch(error.message, /password|must-never-be-read-or-logged/);
        return true;
      }
    );
  }
});

test('refuses incorrect Cloudflare account without exposing account ID', () => {
  assert.equal(verifyApprovedAccountScope('8bb496011403552e785ea1b834daffdf'), true);
  for (const wrong of ['11111111111111111111111111111111', '', undefined]) {
    assert.throws(() => verifyApprovedAccountScope(wrong), error =>
      safeReadbackFailureCode(error) === 'account_scope_mismatch' &&
      !error.message.includes('8bb496011403552e785ea1b834daffdf'));
  }
});
test('denied Hyperdrive read identifies second manifest slot without querying upstream body', async () => {
  const pg = { ...manifest[0], binding: 'HYPERDRIVE_PG', id: 'eeeeeeee-1234-1234-1234-123456789abc', dialect: 'postgres' };
  const pgConfig = { ...cloudConfig, id: pg.id, mtls: { ...cloudConfig.mtls, sslmode: 'verify-full' }, origin: { ...cloudConfig.origin, scheme: 'postgres' } };
  const source2 = { hyperdrive: [...source.hyperdrive, { binding: pg.binding, id: pg.id }] };
  let count = 0;
  await assert.rejects(verifyDatabaseHyperdriveCloudReadback({
    ...options, source: source2, manifest: [...manifest, pg],
    request: async () => {
      count++;
      if (count === 1) return { ok: true, json: async () => ({ success: true, result: cloudConfig }) };
      return { ok: false, status: 404, json: async () => { throw Error('Must never read upstream error content'); } };
    }
  }), error => safeReadbackFailureCode(error) === 'cloudflare_read_404_slot_2');
  assert.equal(count, 2);
});


test('retired production manifest is empty while future reviewed candidates remain valid',async()=>{
 const {readFileSync}=await import('node:fs');
 const {readConfiguration,verifyDatabaseHyperdriveSource}=await import('./manual-worker-release.mjs');
 const root=new URL('../apps/database-mcp-worker/',import.meta.url);
 const source=readConfiguration('database-mcp-worker',readFileSync(new URL('wrangler.jsonc',root),'utf8'));
 const reviewed=JSON.parse(readFileSync(new URL('hyperdrive-bindings.json',root),'utf8'));
 assert.deepEqual(reviewed,[]);
 assert.deepEqual(source.hyperdrive,[]);
 const candidate={binding:'HYPERDRIVE_TEST_CANDIDATE',id:'22222222-2222-4222-8222-222222222222'};
 assert.equal(verifyDatabaseHyperdriveSource({...source,hyperdrive:[candidate]},[candidate]),true);
 assert.throws(()=>verifyDatabaseHyperdriveSource({...source,hyperdrive:[candidate]},[]),/manifest\/source mismatch/);
});
