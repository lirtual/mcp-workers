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
    const checkRejected = async (values: Record<string, string>, diagnostic: string) => {
      const response = await post('add', { id: 'invalid', dialect: 'mysql', transport: 'direct', ...values });
      expect(response.status).toBe(422);
      const html = await response.text();
      expect(html).toContain('Diagnostic: ' + diagnostic);
      expect(html).not.toContain('reader:pass');
      expect(html).not.toContain('supersecret');
    };
    await checkRejected({ url: original }, 'plaintext_ack_required');
    await checkRejected({ plaintext_ack: '1' }, 'url_missing');
    await checkRejected({ plaintext_ack: '1', url: 'mysql://reader:supersecret@db.example.net/catalog?sslmode=disable' }, 'url_options');
    await checkRejected({ plaintext_ack: '1', url: 'mysql://reader:supersecret@localhost/catalog' }, 'hostname_invalid');
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
    // No network probes or D1 mutations for a changed target, even when its health would pass.
    const checkedBeforeTargetChanges = fakeHealth.mock.calls.length;
    for (const otherTarget of [
      'mysql://reader:pass@different.example.net/catalog',
      'mysql://reader:pass@db.example.net:3307/catalog',
      'mysql://reader:pass@db.example.net/other_catalog',
      'postgres://reader:pass@db.example.net/catalog'
    ]) {
      const rejected = await post('edit', { id: 'main', revision: '2', credential_mode: 'replace',
        plaintext_ack: '1', url: otherTarget });
      expect(rejected.status).toBe(422);
      expect(await rejected.text()).toContain('Diagnostic: target_immutable');
    }
    expect(fakeHealth.mock.calls.length).toBe(checkedBeforeTargetChanges);
    expect(sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main'))
      .toMatchObject({ status: 'active', revision: 2, ciphertext });
    fakeHealth.mockRejectedValueOnce(new PublicError('CONNECTION_UNAVAILABLE', 'Unavailable'));
    expect((await post('edit', { id: 'main', revision: '2', credential_mode: 'replace', plaintext_ack: '1',
      url: 'mysql://reader:changed@db.example.net/catalog' })).status).toBe(422);
    row = sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main') as { status: string; revision: number; ciphertext: string };
    expect(row).toMatchObject({ status: 'active', revision: 2, ciphertext });
    expect((await post('delete', { id: 'main', revision: '2', confirm_id: 'main' })).status).toBe(422);
    expect((await post('disable', { id: 'main', revision: '2' })).status).toBe(200);
    const disabledEdit = await post('edit', { id: 'main', revision: '3', credential_mode: 'replace',
      plaintext_ack: '1', allow_disabled: '1', url: 'mysql://reader:pass@new.example.net/catalog' });
    expect(disabledEdit.status).toBe(422);
    expect(await disabledEdit.text()).toContain('Diagnostic: target_immutable');
    expect(sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main'))
      .toMatchObject({ status: 'disabled', revision: 3, ciphertext });
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
    // Hyperdrive references never trigger origin connection attempts and are disabled.
    const checkedBeforeCloud = fakeHealth.mock.calls.length;
    expect((await post('add', { id: 'cloud_ref', dialect: 'mysql', transport: 'hyperdrive',
      config_id: '11111111-2222-3333-4444-555555555555', binding_name: 'HYPERDRIVE_TEST' })).status).toBe(200);
    expect(fakeHealth.mock.calls.length).toBe(checkedBeforeCloud);
    expect(sqlite.prepare("SELECT status,transport,revision FROM database_connections WHERE id='cloud_ref'").get())
      .toMatchObject({ status: 'disabled', transport: 'hyperdrive', revision: 1 });
    expect((await post('enable', { id: 'cloud_ref', revision: '1' })).status).toBe(503);
    expect((await post('hyperdrive-action', { id: 'cloud_ref', revision: '1',
      hyperdrive_action: 'enable' })).status).toBe(503); // Owner dispatch secret not configured.
    expect((await post('hyperdrive-action', { id: 'cloud_ref', revision: '1',
      hyperdrive_action: 'retire', confirm_id: 'wrong' })).status).toBe(422);
    expect((await post('edit', { id: 'cloud_ref', revision: '1', credential_mode: 'keep' })).status).toBe(422);
    expect(fakeHealth.mock.calls.length).toBe(checkedBeforeCloud);
    // PostgreSQL Direct uses the same explicit plaintext acceptance and real health gate.
    expect((await post('add', { id: 'pg_direct', dialect: 'postgres', transport: 'direct',
      plaintext_ack: '1', url: 'postgres://reader:pass@db.example.net/catalog' })).status).toBe(200);
    expect(sqlite.prepare("SELECT status,transport,dialect FROM database_connections WHERE id='pg_direct'").get())
      .toMatchObject({ status: 'active', transport: 'direct', dialect: 'postgres' });
    expect((await post('disable', { id: 'pg_direct', revision: '2' })).status).toBe(200);
    const initialPage = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const initialPageHtml = await initialPage.text();
    expect(initialPageHtml).toContain('<option value="postgres">');
    expect(initialPageHtml).toContain('name="transport" value="direct"');
    expect(initialPageHtml).toContain('name="transport" value="hyperdrive"');
    expect(initialPageHtml).toContain('Hyperdrive actions run in protected GitHub Actions');
    expect(initialPageHtml).toContain('action="/setup/hyperdrive-action"');
    expect(initialPageHtml).toContain('Request enable');
    expect(initialPageHtml).toContain('Request retirement');
    expect(initialPageHtml).not.toContain('name="ciphertext"');
    expect(initialPageHtml).not.toContain('reader:pass');
    vi.unstubAllGlobals();
  });
  it('requires explicit rollback and retained-key confirmation before Owner key rotation', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    const { jwt, certificates } = await auth();
    vi.stubGlobal('fetch', async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] }));
    fakeHealth.mockResolvedValue({ latencyMs: 2 });
    const page = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const html = await page.text();
    expect(html).toContain('name="rotation_ack" value="verified" required');
    expect(html).toContain('This page cannot verify those external requirements.');
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] ?? '';
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const post = (action: string, values: Record<string, string>) => handleSetup(new Request(pageUrl + '/' + action, {
      method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin: 'https://db-owner.example.net', cookie,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...values })
    }), env, certificates);
    const url = 'mysql://reader:pass@db.example.net/catalog';
    expect((await post('add', { id: 'main', dialect: 'mysql', transport: 'direct', plaintext_ack: '1', url })).status).toBe(200);
    const before = sqlite.prepare('SELECT revision,key_id,ciphertext FROM database_connections WHERE id=?').get('main') as {
      revision: number; key_id: string; ciphertext: string
    };
    env.DATABASE_ENCRYPTION_PREVIOUS_KEY = env.DATABASE_ENCRYPTION_KEY!;
    env.DATABASE_PREVIOUS_KEY_ID = env.DATABASE_KEY_ID!;
    env.DATABASE_ENCRYPTION_KEY = btoa('r'.repeat(32));
    env.DATABASE_KEY_ID = 'key-two';
    const missing = await post('rotate', {});
    expect(missing.status).toBe(422);
    expect(await missing.text()).not.toContain(url);
    expect(await post('rotate', { rotation_ack: 'false' }).then(response => response.status)).toBe(422);
    expect(sqlite.prepare('SELECT revision,key_id,ciphertext FROM database_connections WHERE id=?').get('main'))
      .toMatchObject(before);
    const rotated = await post('rotate', { rotation_ack: 'verified' });
    expect(rotated.status).toBe(200);
    const after = sqlite.prepare('SELECT revision,key_id,ciphertext FROM database_connections WHERE id=?').get('main') as typeof before;
    expect(after).toMatchObject({ revision: before.revision + 1, key_id: 'key-two' });
    expect(after.ciphertext).not.toEqual(before.ciphertext);
    expect((await openConnectionConfig(env, 'main', 'mysql', { keyId: after.key_id, ciphertext: after.ciphertext })).url)
      .toBe(url);
  });
  it('accepts a public literal MySQL IP in the Owner create form without storing plaintext or weakening private-IP denial', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    const { jwt, certificates } = await auth();
    fakeHealth.mockResolvedValue({ latencyMs: 2 });
    const page = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const csrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] ?? '';
    const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
    const post = (id: string, url: string) => handleSetup(new Request(pageUrl + '/add', {
      method: 'POST', headers: { 'cf-access-jwt-assertion': jwt,
        origin: 'https://db-owner.example.net', cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, id, dialect: 'mysql', transport: 'direct',
        plaintext_ack: '1', url })
    }), env, certificates);
    const privateResponse = await post('private', 'mysql://reader:secret@192.168.1.1:3306/app');
    expect(privateResponse.status).toBe(422);
    expect(await privateResponse.text()).toContain('Diagnostic: endpoint_nonpublic');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM database_connections').get()).toMatchObject({ n: 0 });

    const publicUrl = 'mysql://reader:secret@93.184.216.34:3306/app';
    const created = await post('public_ip', publicUrl);
    expect(created.status).toBe(200);
    expect(await created.text()).not.toContain(publicUrl);
    expect(sqlite.prepare('SELECT id, status, ciphertext FROM database_connections').get())
      .toMatchObject({ id: 'public_ip', status: 'active' });
    const saved = sqlite.prepare('SELECT ciphertext, key_id FROM database_connections WHERE id=?')
      .get('public_ip') as { ciphertext: string; key_id: string };
    expect(saved.ciphertext).not.toContain('secret');
    expect((await openConnectionConfig(env, 'public_ip', 'mysql',
      { ciphertext: saved.ciphertext, keyId: saved.key_id })).url).toBe(publicUrl);
  });
  it('shows the Owner add form when starting from an empty fresh directory', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    const { jwt, certificates } = await auth();
    const page = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('No database connections configured');
    expect(html).toContain('action="/setup/add"');
    expect(html).toContain('action="/setup/rotate"');
    expect(html).toContain('action="/setup/github-actions-check"');
    expect(html).toContain('<option value="mysql">');
    expect(html).toContain('<option value="postgres">');
    expect(html).toContain('<option value="mysql">');
    expect(html).toContain('<option value="postgres">');
    expect(html).toContain('name="transport" value="direct"');
    expect(html).toContain('name="transport" value="hyperdrive"');
    expect(html).not.toContain('placeholder="b2b"');
    expect(html).toContain('<select name="dialect">');
    expect(html).not.toContain('<select name="transport">');
    expect(html).toContain('<details><summary>Advanced options</summary>');
    expect(html).toContain('<details class="maintenance"><summary>Maintenance</summary>');
    expect(html).toContain('type="checkbox" name="plaintext_ack" value="1" required');
    expect(html).toContain('Save disabled if connection test fails');
    expect(html).not.toContain('Owner-only. Passwords and origin URLs');
    expect(html).not.toContain('protected atomic activation');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM database_connections').get()).toMatchObject({ n: 0 });
  });


  it('Owner no-deploy GitHub Actions check requires Access and CSRF and never changes D1', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    env.DATABASE_GITHUB_ACTIONS_TOKEN = 'github_pat_synthetic_very_long_test_token';
    const { jwt, certificates } = await auth();
    let dispatched = 0;
    let githubStatus = 204;
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).startsWith('https://api.github.com/')) {
        dispatched++;
        expect(JSON.parse(String(init?.body))).toEqual({
          ref: 'main',
          inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false' }
        });
        if (githubStatus === 200) return Response.json({ workflow_run_id: 40850012345 }, { status: 200 });
        if (githubStatus === 204) return new Response(null, { status: 204 });
        return new Response('secret value must never appear', { status: githubStatus });
      }
      return certificates();
    };
    const page = await handleSetup(new Request(pageUrl, {
      headers: { 'cf-access-jwt-assertion': jwt }
    }), env, mockFetch as typeof fetch);
    expect(page.status).toBe(200);
    const csrf = (await page.text()).match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] ?? '';
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const submission = (origin: string, token: string) =>
      handleSetup(new Request(pageUrl + '/github-actions-check', {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': jwt, origin, cookie,
          'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: token })
      }), env, mockFetch as typeof fetch);
    expect((await submission('https://attacker.example.net', csrf)).status).toBe(403);
    expect((await submission('https://db-owner.example.net', 'bad')).status).toBe(403);
    expect(dispatched).toBe(0);
    const result = await submission('https://db-owner.example.net', csrf);
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('verification-only, no-deploy');
    expect(dispatched).toBe(1);
    githubStatus = 200;
    const newReceipt = await submission('https://db-owner.example.net', csrf);
    expect(newReceipt.status).toBe(200);
    expect(await newReceipt.text()).toContain('Workflow Run ID: 40850012345');
    githubStatus = 403;
    const rejected = await submission('https://db-owner.example.net', csrf);
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).toContain('Diagnostic: github_forbidden');
    expect(dispatched).toBe(3);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM database_connections').get()).toMatchObject({ n: 0 });
  });

});
