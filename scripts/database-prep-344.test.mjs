import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { parseLegacyImport, encryptDirect } from './database-prep-344.mjs';

const fixture = () => JSON.stringify({
  b2b: 'mysql://test:example@db-b.example.net:3306/example',
  scrape_relay: 'mysql://test:example@db-a.example.net:3306/example'
});
test('exact original identities and direct MySQL URLs are required', () => {
  assert.deepEqual(parseLegacyImport(fixture()).map(v => v.id), ['b2b', 'scrape_relay']);
  assert.throws(() => parseLegacyImport(JSON.stringify({ b2b: 'mysql://x:y@db.example.net/a' })));
  assert.throws(() => parseLegacyImport(JSON.stringify({
    b2b: 'mysql://x:y@db.example.net/a',
    scrape_relay: 'mysql://x:y@db.example.net/a',
    unexpected: 'mysql://x:y@db.example.net/a'
  })));
  assert.throws(() => parseLegacyImport(JSON.stringify({
    b2b: { hyperdrive: 'HD', dialect: 'mysql' },
    scrape_relay: 'mysql://x:y@db.example.net/a'
  })));
});
test('do not silently import TLS, PostgreSQL, or URI options', () => {
  for (const unsafe of [
    'mysql://x:y@db.example.net/a?sslmode=disable',
    'mysql://x:y@db.example.net/a?ssl=true',
    'postgres://x:y@db.example.net/a',
    'mysql://x:y@db.example.net/a#extra',
    'mysql://db.example.net/a'
  ]) {
    const obj = JSON.parse(fixture());
    obj.b2b = unsafe;
    assert.throws(() => parseLegacyImport(JSON.stringify(obj)));
  }
});
test('ciphertext is compatible with v1 AES-GCM AAD and carries no URL in clear', async () => {
  const url = 'mysql://test:example@db-b.example.net:3306/example';
  const key = Buffer.alloc(32, 7).toString('base64');
  const sealed = await encryptDirect('b2b', url, key);
  assert.ok(!sealed.includes('mysql') && !sealed.includes('example'));
  const [iv, body] = sealed.split('.');
  assert.equal(Buffer.from(iv, 'base64').length, 12);
  const cryptoKey = await webcrypto.subtle.importKey('raw', Buffer.alloc(32,7), 'AES-GCM', false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt({
    name: 'AES-GCM', iv: Buffer.from(iv, 'base64'),
    additionalData: new TextEncoder().encode('database-mcp:connection:v1:b2b:mysql')
  }, cryptoKey, Buffer.from(body, 'base64'));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), { url });
  await assert.rejects(webcrypto.subtle.decrypt({
    name: 'AES-GCM', iv: Buffer.from(iv, 'base64'),
    additionalData: new TextEncoder().encode('database-mcp:connection:v1:scrape_relay:mysql')
  }, cryptoKey, Buffer.from(body, 'base64')));
});
test('reject malformed encryption key before any D1 network request', async () => {
  await assert.rejects(encryptDirect('b2b', 'mysql://x:y@db.example.net/a', 'invalid'));
});

test('existing release job blocks mixed-action dispatch before credentials are staged', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const publishBlock = yaml.slice(yaml.indexOf('\n  deploy:\n'), yaml.indexOf('\n  database-activate:\n'));
  const activationBlock = yaml.slice(yaml.indexOf('\n  database-activate:\n'), yaml.indexOf('\n  database-prepare:\n'));
  const preparationBlock = yaml.slice(yaml.indexOf('\n  database-prepare:\n'));
  const prepSource = readFileSync(new URL('./database-prep-344.mjs', import.meta.url), 'utf8');
  // The existing DATABASE_CONFIG is the only legacy import input name.
  assert.doesNotMatch(preparationBlock + prepSource, /DATABASE_LEGACY_IMPORT_CONFIG/);
  assert.equal((preparationBlock.match(/DATABASE_CONFIG: \$\{\{ secrets\.DATABASE_CONFIG \}\}/g) || []).length, 2);
  assert.match(prepSource, /parseLegacyImport\(required\('DATABASE_CONFIG'\)\)/);
  assert.match(publishBlock, /DATABASE_PREPARE_APPROVED:[^\n]*inputs\.database_prepare_approved/);
  assert.match(activationBlock, /DATABASE_PREPARE_APPROVED:[^\n]*inputs\.database_prepare_approved/);
  for (const body of [publishBlock, activationBlock]) {
    assert.match(body, /\[\[ "\$DATABASE_PREPARE_APPROVED" != "true" \]\]/);
  }
  for (const required of [
    "github.actor == 'lirtual'", "github.ref == 'refs/heads/main'",
    "inputs.deploy_to_production == false", "inputs.database_prepare_approved == true",
    'environment:', 'group: worker-release-database-mcp-worker',
    'database-prep-344.mjs validate', 'database-prep-344.mjs import'
  ]) assert.ok(preparationBlock.includes(required), 'Database preparation scope drift: ' + required);
  assert.doesNotMatch(preparationBlock, /wrangler deploy|Publish exactly selected Worker|activate-database-hyperdrive\.mjs/);
});
