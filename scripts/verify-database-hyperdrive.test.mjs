import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCloudflareHyperdriveConfig, verifyDatabaseHyperdriveCloudReadback } from './verify-database-hyperdrive.mjs';

const configId = '12345678-1234-1234-1234-123456789abc';
const caId = 'abcd1234-0000-1111-2222-123456789abc';
const manifest = [{
  binding: 'HYPERDRIVE_MYSQL', id: configId, dialect: 'mysql',
  origin_host: 'mysql.example.net', origin_port: 3306,
  origin_database: 'customer', ca_certificate_id: caId
}];
const source = { hyperdrive: [{ binding: manifest[0].binding, id: manifest[0].id }] };
const cloudConfig = {
  id: configId, caching: { disabled: true },
  mtls: { sslmode: 'VERIFY_IDENTITY', ca_certificate_id: caId },
  origin: { scheme: 'mysql', host: 'mysql.example.net', port: 3306, database: 'customer' }
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
