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

test('standalone D1 preparation never publishes a Worker or changes legacy runtime', async () => {
  const { readFileSync } = await import('node:fs');
  const yaml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const release = yaml.slice(yaml.indexOf('\n  deploy:\n'), yaml.indexOf('\n  database-prepare:\n'));
  const prepare = yaml.slice(yaml.indexOf('\n  database-prepare:\n'));
  const prepSource = readFileSync(new URL('./database-prep-344.mjs', import.meta.url), 'utf8');
  const runtimeConf = JSON.parse(readFileSync(new URL('../apps/database-mcp-worker/wrangler.jsonc', import.meta.url), 'utf8'));

  // The existing production Worker continues to use the original Secret and
  // receives no premature D1 binding from this preparation-only branch.
  assert.deepEqual(runtimeConf.secrets.required, ['MCP_ACCESS_TOKEN', 'DATABASE_CONFIG']);
  assert.equal(runtimeConf.d1_databases, undefined);
  assert.equal((prepare.match(/DATABASE_CONFIG: \$\{\{ secrets\.DATABASE_CONFIG \}\}/g) || []).length, 2);
  assert.match(prepSource, /parseLegacyImport\(required\('DATABASE_CONFIG'\)\)/);
  for (const marker of [
    "github.actor == 'lirtual'", "github.ref == 'refs/heads/main'",
    "inputs.worker == 'database-mcp-worker'", "inputs.database_prepare_approved == true",
    'inputs.deploy_to_production == false', 'group: worker-release-database-mcp-worker',
    'name: database-mcp-worker', 'database-prep-344.mjs validate',
    'database-prep-344.mjs config', 'database-prep-344.mjs import',
    'wrangler d1 migrations apply database-mcp-db --remote --config .db344-prep.generated.json'
  ]) assert.ok(prepare.includes(marker), 'Missing D1 preparation safety gate: ' + marker);
  assert.match(release, /DATABASE_PREPARE_APPROVED: \$\{\{ inputs\.database_prepare_approved \}\}/);
  assert.match(release, /\[\[ "\$DATABASE_PREPARE_APPROVED" != "true" \]\]/);
  assert.doesNotMatch(prepare, /wrangler deploy|Publish exactly selected Worker|activate-database-hyperdrive\.mjs|DATABASE_LEGACY_IMPORT_CONFIG/);
  assert.doesNotMatch(prepSource, /DATABASE_LEGACY_IMPORT_CONFIG/);
});
