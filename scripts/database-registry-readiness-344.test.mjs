import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { verifyRegistryReadiness } from './database-registry-readiness-344.mjs';

const encryptionKey = Buffer.alloc(32, 17).toString('base64');
const keyId = 'test_current';

async function syntheticCipher(id, dialect, url, raw) {
  const bytes = Buffer.from(raw, 'base64');
  const key = await webcrypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);
  const iv = Buffer.alloc(12, 19);
  const sealed = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(`database-mcp:connection:v1:${id}:${dialect}`)
  }, key, new TextEncoder().encode(JSON.stringify({url})));
  return iv.toString('base64') + '.' + Buffer.from(sealed).toString('base64');
}

test('post-cutover D1 registry allows independent lifecycle with 0–10 entries and authenticates every Direct ciphertext', async () => {
  const credentials = { DATABASE_ENCRYPTION_KEY: encryptionKey, DATABASE_KEY_ID: keyId };
  const old = await Promise.all(['b2b', 'scrape_relay'].map(async id => ({
    id, dialect: 'mysql', transport: 'direct', status: 'active', revision: 2,
    key_id: keyId, config_id: null, binding_name: null,
    ciphertext: await syntheticCipher(id, 'mysql', 'mysql://tester:fixture@db.example.net/demo', encryptionKey)
  })));
  const row = (id, dialect, status, key = encryptionKey, key_id = keyId) => ({
    id, dialect, transport: 'direct', status, revision: 3, key_id,
    ciphertext: null, config_id: null, binding_name: null
  });
  const extra = row('added_pg', 'postgres', 'disabled');
  extra.ciphertext = await syntheticCipher('added_pg', 'postgres', 'postgres://synthetic:secret@pg.example.org:5432/db', encryptionKey);
  const retired = structuredClone(old).slice(1);
  assert.deepEqual(await verifyRegistryReadiness([], credentials),
    { valid: true, records: 0, direct: 0, hyperdrive: 0 });
  assert.deepEqual(await verifyRegistryReadiness([extra, ...retired], credentials),
    { valid: true, records: 2, direct: 2, hyperdrive: 0 });
  const previousKey = Buffer.alloc(32, 13).toString('base64');
  const previous = row('rotating', 'mysql', 'active', previousKey, 'earlier_key');
  previous.ciphertext = await syntheticCipher(previous.id, 'mysql', 'mysql://synthetic:secret@another.example.net/db', previousKey);
  const keys = { DATABASE_KEY_ID: keyId,
    DATABASE_ENCRYPTION_KEY: encryptionKey,
    DATABASE_PREVIOUS_KEY_ID: 'earlier_key',
    DATABASE_ENCRYPTION_PREVIOUS_KEY: previousKey };
  assert.deepEqual(await verifyRegistryReadiness([extra, previous], keys),
    { valid: true, records: 2, direct: 2, hyperdrive: 0 });
  await assert.rejects(verifyRegistryReadiness([extra, previous], {
    ...keys, DATABASE_ENCRYPTION_PREVIOUS_KEY: undefined
  }), /preflight failed/);
  const hyperdrive = { id: 'pg_hyperdrive', dialect: 'postgres', transport: 'hyperdrive',
    status: 'disabled', revision: 1, key_id: null, ciphertext: null,
    config_id: '11111111-1111-4111-8111-111111111111', binding_name: 'HYPERDRIVE_PG' };
  assert.deepEqual(await verifyRegistryReadiness([extra, hyperdrive], keys),
    { valid: true, records: 2, direct: 1, hyperdrive: 1 });
  const activeHyperdrive = { ...hyperdrive, status: 'active', revision: 2 };
  const approvedBinding = { binding: hyperdrive.binding_name, id: hyperdrive.config_id,
    dialect: hyperdrive.dialect, origin_database: 'approved_db' };
  assert.deepEqual(await verifyRegistryReadiness([extra, activeHyperdrive], keys, [approvedBinding]),
    { valid: true, records: 2, direct: 1, hyperdrive: 1 });
  // Disabled references may be staged before a binding release; active ones
  // must be represented in the reviewed manifest used by the running Worker.
  await assert.rejects(verifyRegistryReadiness([activeHyperdrive], keys), /preflight failed/);
  for (const incorrect of [
    { ...approvedBinding, id: '22222222-2222-4222-8222-222222222222' },
    { ...approvedBinding, binding: 'HYPERDRIVE_WRONG' },
    { ...approvedBinding, dialect: 'mysql' }
  ]) await assert.rejects(verifyRegistryReadiness([activeHyperdrive], keys, [incorrect]),
    /preflight failed/);
  await assert.rejects(verifyRegistryReadiness([activeHyperdrive], keys,
    [approvedBinding, approvedBinding]), /preflight failed/);
  const longestLegalId = 'a' + 'b'.repeat(63);
  const maxId = row(longestLegalId, 'mysql', 'active');
  maxId.ciphertext = await syntheticCipher(maxId.id, maxId.dialect,
    'mysql://synthetic:secret@db.example.net:3306/db', encryptionKey);
  assert.deepEqual(await verifyRegistryReadiness([maxId], credentials),
    { valid: true, records: 1, direct: 1, hyperdrive: 0 });
  await assert.rejects(verifyRegistryReadiness([{ ...maxId, id: longestLegalId + 'c' }],
    credentials), /preflight failed/);
  for (const makeBad of [
    () => [{ ...extra, ciphertext: extra.ciphertext + '.extra' }],
    () => [{ ...extra, dialect: 'mysql' }],
    () => [{ ...extra, status: 'unknown' }],
    () => [{ ...extra, revision: 0 }],
    () => [{ ...extra, key_id: 'wrong' }],
    () => [extra, { ...extra }],
    () => [{ ...hyperdrive, ciphertext: 'never_store_this' }],
    () => [{ ...hyperdrive, binding_name: 'BAD' }],
    () => Array.from({length: 11}, (_, i) => ({...extra, id: 'extra_' + i}))
  ]) await assert.rejects(verifyRegistryReadiness(makeBad(), keys), /preflight failed/);
});

test('post-cutover Direct preflight rejects driver-incompatible stored URL without origin I/O', async () => {
  const keys = { DATABASE_ENCRYPTION_KEY: encryptionKey, DATABASE_KEY_ID: keyId };
  const connection = {
    id: 'sample', dialect: 'mysql', transport: 'direct', status: 'active', revision: 2,
    key_id: keyId, ciphertext: '', config_id: null, binding_name: null
  };
  const connectionWith = async (url, dialect = 'mysql') => ({ ...connection, dialect,
    ciphertext: await syntheticCipher(connection.id, dialect, url, encryptionKey) });
  assert.deepEqual(await verifyRegistryReadiness([
    await connectionWith('mysql://synthetic:secret@db.example.net/allowed')
  ], keys), { valid: true, records: 1, direct: 1, hyperdrive: 0 });
  assert.deepEqual(await verifyRegistryReadiness([
    await connectionWith('postgresql://synthetic:secret@db.example.net/allowed', 'postgres')
  ], keys), { valid: true, records: 1, direct: 1, hyperdrive: 0 });
  for (const [url, dialect] of [
    ['mysql://synthetic:secret@db.example.net/allowed', 'postgres'],
    ['postgres://synthetic:secret@db.example.net/allowed', 'mysql'],
    ['mysql://synthetic:secret@db.example.net/allowed?ssl=true', 'mysql'],
    ['postgres://synthetic:secret@db.example.net/allowed?sslmode=disable', 'postgres'],
    ['mysql://synthetic:secret@db.example.net/allowed#fragment', 'mysql'],
    ['postgresql://synthetic:secret@db.example.net', 'postgres'],
    ['mysql://db.example.net/allowed', 'mysql'],
    ['https://synthetic:secret@db.example.net/allowed', 'mysql']
  ]) {
    await assert.rejects(verifyRegistryReadiness([await connectionWith(url, dialect)], keys),
      /preflight failed/);
  }
});
