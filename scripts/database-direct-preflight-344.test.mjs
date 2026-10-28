import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptDirect } from './database-prep-344.mjs';
import { webcrypto } from 'node:crypto';
import { checkReadOnlyD1, verifyDirectCutoverPreflight, verifyRegistryReadiness } from './database-direct-preflight-344.mjs';

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
    if (url.endsWith('/deployments')) {
      assert.equal(options.method, 'GET');
      return { ok: true, json: async () => ({ success: true, result: { deployments: [
        { versions: [{ version_id: 'eb3f4823-124b-4d76-abdc-42f85097bb5a', percentage: 100 }] }
      ] } }) };
    }
    assert.equal(options.method, 'POST'); // Cloudflare D1 SELECT transport
    assert.match(body.sql, /^SELECT /);
    assert.doesNotMatch(body.sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
    const rows = body.sql.includes('AS migrations')
      ? [{ migrations: 2, retired: 0, total: 2, reused: 0 }] : base.rows;
    return { ok: true, json: async () => ({ success: true, result: [{ success: true, results: rows }] }) };
  };
  try {
    assert.deepEqual(await checkReadOnlyD1(env), {
      valid: true, records: 2, status: 'disabled', workerChanged: false
    });
    assert.deepEqual(calls.map(x => x.method), ['GET', 'GET', 'POST', 'POST']);
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

test('Database publication rechecks active Direct ciphertext and URL inventory before deployment', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const name = 'Verify first cutover Direct identity or post-cutover registry decryption (read-only)';
  const start = source.indexOf(name);
  const publish = source.indexOf('Publish exactly selected Worker');
  assert.ok(start > 0 && start < publish, 'Direct prepublication guard must execute before deployment');
  const end = source.indexOf('\n      # Read-only Hyperdrive API check', start);
  assert.ok(end > start);
  const stage = source.slice(start, end);
  for (const required of [
    "if: inputs.worker == 'database-mcp-worker'",
    'DATABASE_DIRECT_PREFLIGHT_PHASE: release',
    'DATABASE_CONFIG: ${{ secrets.DATABASE_CONFIG }}',
    'DATABASE_ENCRYPTION_KEY: ${{ secrets.DATABASE_ENCRYPTION_KEY }}',
    'DATABASE_KEY_ID: ${{ vars.DATABASE_KEY_ID }}',
    'node scripts/database-direct-preflight-344.mjs'
  ]) assert.ok(stage.includes(required), 'Database publish encryption guard missing: ' + required);
  assert.doesNotMatch(stage, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b|wrangler deploy/);
});

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
  const original = await fixture();
  const credentials = { DATABASE_ENCRYPTION_KEY: encryptionKey, DATABASE_KEY_ID: keyId };
  const old = original.rows.map(r => ({ ...r, status: 'active', revision: 2 }));
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
  const keys = { ...original, DATABASE_KEY_ID: keyId,
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

test('post-cutover read-only release gate permits retired IDs but rejects identity and binding drift', async () => {
  const base = await fixture();
  const state = { rows: [], retired: 2, version: '22222222-2222-4222-8222-222222222222', bindings: [
    { name: 'DB', type: 'd1', id: '8853a6ac-beaa-45aa-bdb2-0867e6f3df6d' },
    { name: 'MCP_ACCESS_TOKEN', type: 'secret_text' }
  ] };
  const env = {
    GITHUB_ACTOR: 'lirtual', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40),
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-test-token',
    DATABASE_ENCRYPTION_KEY: encryptionKey, DATABASE_KEY_ID: keyId,
    DATABASE_DIRECT_PREFLIGHT_PHASE: 'release'
  };
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const sql = options.body ? JSON.parse(options.body).sql : null;
    calls.push({ method: options.method, sql });
    assert.match(url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/a{32}\//);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
    if (url.endsWith('/settings')) {
      assert.equal(options.method, 'GET');
      return { ok: true, json: async () => ({ success: true, result: { bindings: state.bindings } }) };
    }
    if (url.endsWith('/deployments')) {
      assert.equal(options.method, 'GET');
      return { ok: true, json: async () => ({ success: true, result: { deployments: [
        { versions: [{ version_id: state.version, percentage: 100 }] }
      ] } }) };
    }
    assert.equal(options.method, 'POST'); // Cloudflare D1 SELECT over HTTP
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
    const results = sql.includes('AS migrations')
      ? [{ migrations: 2, retired: state.retired, total: state.rows.length, reused: state.reused ?? 0 }]
      : state.rows;
    return { ok: true, json: async () => ({ success: true,
      result: [{ success: true, results }] }) };
  };
  try {
    assert.deepEqual(await checkReadOnlyD1(env),
      { valid: true, records: 0, direct: 0, hyperdrive: 0, status: 'registry', workerChanged: true });
    const more = { ...base.rows[0], status: 'disabled', revision: 4 };
    state.rows = [more];
    assert.deepEqual(await checkReadOnlyD1(env),
      { valid: true, records: 1, direct: 1, hyperdrive: 0, status: 'registry', workerChanged: true });
    // A disabled, authentic future-mode record may remain pending. An
    // ACTIVE deferred mode must fail the release, even if otherwise valid.
    const pg = { ...more, id: 'new_pg', dialect: 'postgres', status: 'disabled', revision: 1,
      ciphertext: await syntheticCipher('new_pg', 'postgres',
        'postgres://synthetic:example@pg.example.net:5432/db', encryptionKey) };
    state.rows = [pg];
    assert.deepEqual(await checkReadOnlyD1(env),
      { valid: true, records: 1, direct: 1, hyperdrive: 0, status: 'registry', workerChanged: true });
    state.rows = [{ ...pg, status: 'active', revision: 2 }];
    await assert.rejects(checkReadOnlyD1(env), /preflight failed/);
    // Existing ordinary MySQL Direct connections remain available.
    state.rows = [{ ...more, status: 'active', revision: 5 }];
    assert.deepEqual(await checkReadOnlyD1(env),
      { valid: true, records: 1, direct: 1, hyperdrive: 0, status: 'registry', workerChanged: true });
    assert.equal(calls.every(c => c.method === 'GET' || c.method === 'POST'), true);
    await assert.rejects(checkReadOnlyD1({ ...env, DATABASE_DIRECT_PREFLIGHT_PHASE: 'staged' }),
      /preflight failed/);
    state.version = 'eb3f4823-124b-4d76-abdc-42f85097bb5a';
    await assert.rejects(checkReadOnlyD1(env), /preflight failed/);
    state.version = '22222222-2222-4222-8222-222222222222';
    state.reused = 1;
    await assert.rejects(checkReadOnlyD1(env), /preflight failed/);
    state.reused = 0;
    state.bindings[0].id = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(checkReadOnlyD1(env), /preflight failed/);
    state.bindings[0].id = '8853a6ac-beaa-45aa-bdb2-0867e6f3df6d';
    state.bindings[0].type = 'plain_text';
    await assert.rejects(checkReadOnlyD1(env), /preflight failed/);
    state.bindings[0].type = 'd1';
    state.bindings.push({ name: 'DB', type: 'd1', id: state.bindings[0].id });
    await assert.rejects(checkReadOnlyD1(env), /preflight failed/);
  } finally { globalThis.fetch = previous; }
});
