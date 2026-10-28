import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types.js';
import { PublicError } from '../../src/errors.js';
import { openConnectionConfig } from '../../src/registry/crypto.js';
const { fakeHealth } = vi.hoisted(() => ({ fakeHealth: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ healthCheck: fakeHealth }));
import { handleSetup } from '../../src/setup/handler.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../migrations/0001_connections.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0002_transport_and_retired_ids.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, args: unknown[] = []) => {
    const stmt = sqlite.prepare(sql);
    return {
      bind(...a: unknown[]) { return prepare(sql, a); },
      async all<T>() { return { results: stmt.all(...args as []) as T[] }; },
      async first<T>() { return (stmt.get(...args as []) as T) ?? null; },
      async run() { const result = stmt.run(...args as []); return { meta: { changes: result.changes } }; }
    };
  };
  const env = {
    DB: { prepare }, DATABASE_ENCRYPTION_KEY: btoa('q'.repeat(32)), DATABASE_KEY_ID: 'key-one',
    DATABASE_SETUP_HOST: 'db-owner.example.net', ACCESS_TEAM_DOMAIN: 'testing.cloudflareaccess.com',
    ACCESS_AUD: 'test-aud', OWNER_EMAIL: 'owner@example.net',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    SETUP_RATE_LIMITER: { async limit() { return { success: true }; } }
  } as unknown as Env;
  return { sqlite, env };
}
const instances: DatabaseSync[] = [];
afterEach(() => { instances.splice(0).forEach(db => db.close()); fakeHealth.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const pageUrl = 'https://db-owner.example.net/setup';

async function auth() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const message = encode({ alg: 'RS256', kid: 'ci-owner' }) + '.' + encode({
    iss: 'https://testing.cloudflareaccess.com', aud: 'test-aud', sub: 'owner-id',
    email: 'owner@example.net', exp: Math.floor(Date.now() / 1000) + 60
  });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(message));
  const jwt = message + '.' + Buffer.from(signature).toString('base64url');
  const certificates = async () => Response.json({ keys: [{ ...jwk, kid: 'ci-owner', alg: 'RS256' }] });
  return { jwt, certificates };
}

describe('Owner HTML → D1 real-SQL lifecycle', () => {
  it('preserves active configuration after a failed edit, and requires disable to delete', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    const { jwt, certificates } = await auth();
    vi.stubGlobal('fetch', async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] }));
    fakeHealth.mockResolvedValue({ latencyMs: 2 });
    const page = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    expect(page.status).toBe(200);
    const csrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] ?? '';
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const post = async (action: string, values: Record<string, string>) => handleSetup(new Request(pageUrl + '/' + action, {
      method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin: 'https://db-owner.example.net', cookie,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...values })
    }), env, certificates);
    const original = 'mysql://reader:pass@db.example.net/catalog';
    expect((await post('add', { id: 'bad', dialect: 'mysql', transport: 'direct', plaintext_ack: '1', url: original, ca: 'not a certificate' })).status).toBe(422);
    expect((await post('add', { id: 'main', dialect: 'mysql', transport: 'direct', plaintext_ack: '1', url: original })).status).toBe(200);
    const listing = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const listingHtml = await listing.text();
    expect(listingHtml).not.toContain(original);
    let row = sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main') as { status: string; revision: number; ciphertext: string };
    expect(row).toMatchObject({ status: 'active', revision: 2 });
    const ciphertext = row.ciphertext;
    expect(fakeHealth.mock.lastCall?.[0]).not.toHaveProperty('ca');
    expect((await openConnectionConfig(env, 'main', 'mysql', {keyId: 'key-one', ciphertext})).ca).toBeUndefined();
    fakeHealth.mockRejectedValueOnce(new PublicError('CONNECTION_UNAVAILABLE', 'Unavailable'));
    expect((await post('edit', { id: 'main', revision: '2', credential_mode: 'replace', plaintext_ack: '1',
      url: 'mysql://reader:changed@db.example.net/catalog' })).status).toBe(422);
    row = sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main') as { status: string; revision: number; ciphertext: string };
    expect(row).toMatchObject({ status: 'active', revision: 2, ciphertext });
    expect((await post('delete', { id: 'main', revision: '2', confirm_id: 'main' })).status).toBe(422);
    expect((await post('disable', { id: 'main', revision: '2' })).status).toBe(200);
    // A disabled placeholder with unreachable credentials can be repaired without
    // making it active. An active connection must never accept failed edits.
    fakeHealth.mockRejectedValueOnce(new PublicError('CONNECTION_UNAVAILABLE', 'Unreachable fixture'));
    expect((await post('edit', { id: 'main', revision: '3', credential_mode: 'replace', plaintext_ack: '1',
      url: 'mysql://reader:replacement@db.example.net/catalog', allow_disabled: '1' })).status).toBe(200);
    row = sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main') as { status: string; revision: number; ciphertext: string };
    expect(row.status).toBe('disabled');
    expect(row.revision).toBe(4);
    expect((await openConnectionConfig(env, 'main', 'mysql', {keyId: 'key-one', ciphertext: row.ciphertext})).ca).toBeUndefined();
    expect((await post('enable', { id: 'main', revision: '4' })).status).toBe(422);
    expect((await post('enable', { id: 'main', revision: '4', plaintext_ack: '1' })).status).toBe(200);
    expect(fakeHealth.mock.lastCall?.[0]).not.toHaveProperty('ca');
    expect((await post('disable', { id: 'main', revision: '5' })).status).toBe(200);
    expect((await post('edit', { id: 'main', revision: '6', credential_mode: 'keep' })).status).toBe(200);
    row = sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main') as typeof row;
    expect(row.revision).toBe(7);
    expect((await openConnectionConfig(env, 'main', 'mysql', {keyId: 'key-one', ciphertext: row.ciphertext})).ca).toBeUndefined();

    expect((await post('delete', { id: 'main', revision: '7', confirm_id: 'other' })).status).toBe(422);
    expect((await post('delete', { id: 'main', revision: '7', confirm_id: 'main' })).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM database_connections').get()).toMatchObject({ n: 0 });
    expect((await post('add', { id: 'cloud_ref', dialect: 'mysql', transport: 'hyperdrive',
      config_id: '11111111-2222-3333-4444-555555555555', binding_name: 'HYPERDRIVE_TEST' })).status).toBe(503);
    expect((await post('add', { id: 'pg_direct', dialect: 'postgres', transport: 'direct',
      plaintext_ack: '1', url: 'postgres://reader:pass@db.example.net/catalog' })).status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM database_connections').get()).toMatchObject({ n: 0 });
    // Already-present deferred records cannot be enabled or edited by forged
    // Owner POSTs; rejection happens before any credential or origin access.
    sqlite.prepare(`INSERT INTO database_connections
      (id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at)
      VALUES ('deferred_pg','postgres','direct','disabled','opaque','key-one',1,1,1)`).run();
    const checkedBefore = fakeHealth.mock.calls.length;
    expect((await post('enable', { id: 'deferred_pg', revision: '1', plaintext_ack: '1' })).status).toBe(503);
    expect((await post('edit', { id: 'deferred_pg', revision: '1', credential_mode: 'keep' })).status).toBe(503);
    expect(fakeHealth.mock.calls.length).toBe(checkedBefore);
    expect(sqlite.prepare("SELECT status,revision FROM database_connections WHERE id='deferred_pg'").get())
      .toMatchObject({ status: 'disabled', revision: 1 });
    const initialPage = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const initialPageHtml = await initialPage.text();
    expect(initialPageHtml).toContain('MySQL Direct plaintext only');
    expect(initialPageHtml).not.toContain('<option value="postgres">');
    expect(initialPageHtml).not.toContain('<option value="hyperdrive">');
    expect(initialPageHtml).not.toContain('action="/setup/enable"');
    expect(initialPageHtml).not.toContain('action="/setup/edit"');
    vi.unstubAllGlobals();
  });
  it('freezes the two staged original identities and the initial catalog until protected atomic cutover', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    const { jwt, certificates } = await auth();
    const original = 'mysql://reader:fixture@db.example.net/catalog';
    for (const id of ['b2b', 'scrape_relay']) {
      const { sealConnectionConfig } = await import('../../src/registry/crypto.js');
      const sealed = await sealConnectionConfig(env, id, 'mysql', { url: original });
      sqlite.prepare(`INSERT INTO database_connections
        (id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at)
        VALUES (?,'mysql','direct','disabled',?,'key-one',1,1,1)`).run(id, sealed.ciphertext);
    }
    const page = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('protected atomic activation');
    for (const endpoint of ['/setup/add', '/setup/edit', '/setup/enable', '/setup/delete', '/setup/disable', '/setup/rotate']) {
      expect(html).not.toContain(`action="${endpoint}"`);
    }
    // Staged records hide all mutating forms; forged-POST negatives still
    // require a syntactically valid cookie-bound CSRF token.
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = cookie.slice('database_setup_csrf='.length);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const post = async (action: string, values: Record<string, string>) => handleSetup(new Request(pageUrl + '/' + action, {
      method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin: 'https://db-owner.example.net', cookie,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...values })
    }), env, certificates);
    const before = sqlite.prepare('SELECT id,status,revision,ciphertext,key_id FROM database_connections ORDER BY id').all();
    const mockCount = fakeHealth.mock.calls.length;
    for (const id of ['b2b', 'scrape_relay']) {
      for (const [action, values] of [
        ['enable', { revision: '1', plaintext_ack: '1' }],
        ['disable', { revision: '1' }],
        ['edit', { revision: '1', credential_mode: 'keep' }],
        ['delete', { revision: '1', confirm_id: id }]
      ] as const) {
        const response = await post(action, { id, ...values });
        expect(response.status, `staged ${id} ${action}`).toBe(503);
      }
    }
    expect((await post('add', { id: 'third', dialect: 'mysql', transport: 'direct',
      plaintext_ack: '1', url: original })).status).toBe(503);
    expect((await post('rotate', {})).status).toBe(503);
    expect(sqlite.prepare('SELECT id,status,revision,ciphertext,key_id FROM database_connections ORDER BY id').all()).toEqual(before);
    expect(fakeHealth.mock.calls.length).toBe(mockCount);
    // A partial/mixed state is NOT a completed migration: even its active
    // half must remain frozen, including forged valid-CSRF management POSTs.
    sqlite.prepare("UPDATE database_connections SET status='active',revision=2 WHERE id='b2b'").run();
    const partialSnapshot = sqlite.prepare('SELECT id,status,revision,ciphertext,key_id FROM database_connections ORDER BY id').all();
    const partialPage = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const partialHtml = await partialPage.text();
    for (const endpoint of ['/setup/add','/setup/edit','/setup/enable','/setup/delete','/setup/disable','/setup/rotate']) {
      expect(partialHtml).not.toContain(`action="${endpoint}"`);
    }
    expect((await post('disable', { id: 'b2b', revision: '2' })).status).toBe(503);
    expect((await post('edit', { id: 'b2b', revision: '2', credential_mode: 'keep' })).status).toBe(503);
    expect((await post('add', { id: 'extra', dialect: 'mysql', transport: 'direct',
      plaintext_ack: '1', url: original })).status).toBe(503);
    expect((await post('rotate', {})).status).toBe(503);
    expect(sqlite.prepare('SELECT id,status,revision,ciphertext,key_id FROM database_connections ORDER BY id').all())
      .toEqual(partialSnapshot);
    expect(fakeHealth.mock.calls.length).toBe(mockCount);
    // Only a separately controlled transition of BOTH originals to active/2
    // unfreezes normal Owner management. Offline test fixture only.
    sqlite.prepare("UPDATE database_connections SET status='active',revision=2 WHERE id='scrape_relay'").run();
    const after = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const afterHtml = await after.text();
    expect(afterHtml).toContain('action="/setup/add"');
    expect(afterHtml).toContain('action="/setup/rotate"');
    expect(afterHtml).toContain('action="/setup/disable"');
  });

});
