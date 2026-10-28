import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptDirect } from './database-prep-344.mjs';
import { checkReadOnlyD1, verifyDirectCutoverPreflight } from './database-direct-preflight-344.mjs';

const config = Object.freeze({
  b2b: 'mysql://test:example@db-b.example.net:3306/example',
  scrape_relay: 'mysql://test:example@db-a.example.net:3306/example'
});
const encryptionKey = Buffer.alloc(32, 17).toString('base64');
const keyId = 'db344-20261028';
async function fixture() {
  const rows = [];
  for (const id of ['b2b', 'scrape_relay']) {
    rows.push({
      id, dialect: 'mysql', transport: 'direct', status: 'disabled',
      revision: 1, key_id: keyId, config_id: null, binding_name: null,
      ciphertext: await encryptDirect(id, config[id], encryptionKey)
    });
  }
  return { rows, originalConfig: JSON.stringify(config), encryptionKey, keyId };
}

test('two matching disabled encrypted records authenticate without exposing secrets', async () => {
  const data = await fixture();
  const result = await verifyDirectCutoverPreflight(data);
  assert.deepEqual(result, { valid: true, ids: ['b2b', 'scrape_relay'], expectedRevision: 1 });
  assert.ok(!JSON.stringify(result).includes('mysql://'));
});

test('release phase requires both verified active revision-2 records', async () => {
  const base = await fixture();
  const released = structuredClone(base);
  for (const row of released.rows) { row.status = 'active'; row.revision = 2; }
  assert.deepEqual(await verifyDirectCutoverPreflight({ ...released, phase: 'release' }),
    { valid: true, ids: ['b2b', 'scrape_relay'], expectedRevision: 2 });
  await assert.rejects(verifyDirectCutoverPreflight({ ...base, phase: 'release' }), /preflight failed/);
  await assert.rejects(verifyDirectCutoverPreflight({ ...released, phase: 'staged' }), /preflight failed/);
  await assert.rejects(verifyDirectCutoverPreflight({ ...released, phase: 'invalid' }), /preflight failed/);
});

test('fail closed on incorrect, reordered, missing, extra or active identities', async () => {
  const base = await fixture();
  for (const mutate of [
    x => { x.rows.reverse(); },
    x => { x.rows.pop(); },
    x => { x.rows.push({ ...x.rows[0], id: 'other' }); },
    x => { x.rows[0].id = 'other'; },
    x => { x.rows[0].status = 'active'; },
    x => { x.rows[0].revision = 2; },
    x => { x.rows[1].transport = 'hyperdrive'; },
    x => { x.rows[1].config_id = 'hd'; },
    x => { x.rows[1].binding_name = 'HYPERDRIVE_B2B'; },
    x => { x.rows[1].key_id = 'wrong-id'; },
    x => { x.rows[0].dialect = 'postgres'; }
  ]) {
    const input = structuredClone(base);
    mutate(input);
    await assert.rejects(verifyDirectCutoverPreflight(input), /preflight failed/);
  }
});

test('fail closed on ciphertext substitution, tampering and key mismatch', async () => {
  const base = await fixture();
  for (const mutate of [
    x => { x.rows[0].ciphertext = x.rows[1].ciphertext; },
    x => { x.rows[0].ciphertext += '.extra'; },
    x => { x.rows[0].ciphertext = 'not-base64'; },
    x => { x.rows[0].ciphertext = x.rows[0].ciphertext.replace(/.$/, 'A'); },
    x => { x.encryptionKey = Buffer.alloc(32, 18).toString('base64'); },
    x => { x.encryptionKey = 'invalid'; },
    x => { x.keyId = 'different'; }
  ]) {
    const input = structuredClone(base);
    mutate(input);
    await assert.rejects(verifyDirectCutoverPreflight(input), /preflight failed/);
  }
});

test('fail closed if approved original URL changes, including implicit TLS changes', async () => {
  const base = await fixture();
  const changed = structuredClone(base);
  changed.originalConfig = JSON.stringify({
    ...config, b2b: 'mysql://test:example@different.example.net:3306/example'
  });
  await assert.rejects(verifyDirectCutoverPreflight(changed), /preflight failed/);
  const tls = structuredClone(base);
  tls.originalConfig = JSON.stringify({
    ...config, b2b: config.b2b + '?ssl=true'
  });
  await assert.rejects(verifyDirectCutoverPreflight(tls));
});

test('production preflight is strictly read-only, guarded and redacts credentials', async () => {
  const base = await fixture();
  const env = {
    GITHUB_ACTOR: 'lirtual', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40), CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'synthetic-test-token',
    DATABASE_CONFIG: base.originalConfig, DATABASE_ENCRYPTION_KEY: encryptionKey,
    DATABASE_KEY_ID: keyId
  };
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    assert.match(url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/a{32}\//);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method, path: new URL(url).pathname, sql: body?.sql });
    if (url.endsWith('/settings')) {
      assert.equal(options.method, 'GET');
      return { ok: true, json: async () => ({
        success: true, result: { bindings: [{ name: 'DATABASE_CONFIG', type: 'secret_text' }] }
      }) };
    }
    assert.equal(options.method, 'POST'); // Cloudflare D1 SELECT transport
    assert.match(body.sql, /^SELECT /);
    assert.doesNotMatch(body.sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
    const rows = body.sql.includes('AS migrations')
      ? [{ migrations: 2, retired: 0, total: 2 }] : base.rows;
    return { ok: true, json: async () => ({ success: true, result: [{ success: true, results: rows }] }) };
  };
  try {
    assert.deepEqual(await checkReadOnlyD1(env), {
      valid: true, records: 2, status: 'disabled', workerChanged: false
    });
    assert.deepEqual(calls.map(x => x.method), ['GET', 'POST', 'POST']);
    // A future release must fail until BOTH records are active and revision 2.
    await assert.rejects(checkReadOnlyD1({ ...env, DATABASE_DIRECT_PREFLIGHT_PHASE: 'release' }),
      /preflight failed/);
    for (const row of base.rows) { row.status = 'active'; row.revision = 2; }
    assert.deepEqual(await checkReadOnlyD1({ ...env, DATABASE_DIRECT_PREFLIGHT_PHASE: 'release' }), {
      valid: true, records: 2, status: 'active', workerChanged: false
    });
    await assert.rejects(checkReadOnlyD1({ ...env, DATABASE_DIRECT_PREFLIGHT_PHASE: 'unknown' }),
      /preflight failed/);
    await assert.rejects(checkReadOnlyD1({ ...env, GITHUB_ACTOR: 'other' }), /preflight failed/);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a deployed new D1 binding prevents Direct preflight', async () => {
  const base = await fixture();
  const env = {
    GITHUB_ACTOR: 'lirtual', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40), CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'synthetic-test-token',
    DATABASE_CONFIG: base.originalConfig, DATABASE_ENCRYPTION_KEY: encryptionKey,
    DATABASE_KEY_ID: keyId
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({
      success: true, result: {
        bindings: [
          { name: 'DATABASE_CONFIG', type: 'secret_text' },
          { name: 'DB', type: 'd1' }
        ]
      }
    })
  });
  try { await assert.rejects(checkReadOnlyD1(env), /preflight failed/); }
  finally { globalThis.fetch = previous; }
});

test('direct preflight manual gate is Owner-only, isolated and never a write route', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const begin = source.indexOf('\n  database-direct-preflight:\n');
  const end = source.indexOf('\n  database-prepare:\n', begin);
  assert.ok(begin >= 0 && end > begin);
  const job = source.slice(begin, end);
  for (const gate of [
    "github.actor == 'lirtual'", "github.ref == 'refs/heads/main'",
    "inputs.worker == 'database-mcp-worker'",
    'inputs.database_direct_preflight_approved == true',
    'inputs.deploy_to_production == false',
    'inputs.database_prepare_approved != true',
    'inputs.database_activation_approved != true',
    "inputs.database_activation_id == ''",
    'name: database-mcp-worker',
    'group: worker-release-database-mcp-worker',
    'git ls-remote origin refs/heads/main',
    'node scripts/database-direct-preflight-344.mjs'
  ]) assert.ok(job.includes(gate), 'Direct preflight gate missing: ' + gate);
  assert.doesNotMatch(job, /wrangler deploy|wrangler d1 migrations|database-prep-344\.mjs import|activate-database-hyperdrive\.mjs/);
  const deploy = source.slice(source.indexOf('\n  deploy:\n'), source.indexOf('\n  database-activate:\n'));
  const activation = source.slice(source.indexOf('\n  database-activate:\n'), begin);
  const preparation = source.slice(end);
  for (const other of [deploy, activation, preparation]) {
    assert.ok(other.includes('inputs.database_direct_preflight_approved != true'));
  }
  const checks = source.slice(source.indexOf('\n  checks:\n'), source.indexOf('\n  deploy:\n'));
  assert.ok(checks.includes('inputs.database_direct_preflight_approved != true'));
});
