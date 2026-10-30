import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/types.js';
import { PublicError } from '../../src/errors.js';
import { openConnectionConfig } from '../../src/registry/crypto.js';
import { createRegistryConnection } from '../../src/registry/store.js';
const { fakeHealth } = vi.hoisted(() => ({ fakeHealth: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ healthCheck: fakeHealth }));
import { handleSetup } from '../../src/setup/handler.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../migrations/0001_connections.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0002_transport_and_retired_ids.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0003_hyperdrive_operations.sql', import.meta.url), 'utf8'));
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
  it('Owner retires a disabled Hyperdrive logical ID and retains upstream cleanup pointers', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    const { jwt, certificates } = await auth();
    const page = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const html = await page.text();
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] ?? '';
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const post = (action: string, values: Record<string, string>) => handleSetup(new Request(pageUrl + '/' + action, {
      method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin: 'https://db-owner.example.net',
        cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...values })
    }), env, certificates);
    const old = { id: 'mistyped_pg', dialect: 'mysql', transport: 'hyperdrive',
      config_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', binding_name: 'HYPERDRIVE_PG' };
    expect((await post('add', old)).status).toBe(422);
    await createRegistryConnection(env.DB!, {id:old.id,dialect:'mysql',transport:'hyperdrive',configId:old.config_id,bindingName:old.binding_name});
    expect(sqlite.prepare('SELECT status,revision FROM database_connections WHERE id=?').get(old.id))
      .toMatchObject({ status: 'disabled', revision: 1 });
    const listing = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const listText = await listing.text();
    expect(listText).toContain('name="dialect"');
    expect(listText).toContain('name="dialect"');
    expect(listText).toContain('Its immutable ID is never reusable');
    const wrongConfirm = await post('delete', { id: old.id, revision: '1', confirm_id: 'wrong' });
    expect(wrongConfirm.status).toBe(422);
    expect(sqlite.prepare('SELECT id FROM database_connections WHERE id=?').get(old.id)).toBeDefined();
    const dropped = await post('delete', { id: old.id, revision: '1', confirm_id: old.id });
    expect(dropped.status).toBe(200);
    expect(sqlite.prepare('SELECT id FROM database_connections WHERE id=?').get(old.id)).toBeUndefined();
    expect(sqlite.prepare('SELECT id FROM retired_connection_ids WHERE id=?').get(old.id))
      .toEqual({ id: old.id });
    const afterDelete=await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,certificates);
    const retiredPage=await afterDelete.text();
    expect(retiredPage).toContain('Cloudflare cleanup unverified');
    expect(retiredPage).toContain(old.id);
    expect(retiredPage).not.toContain(old.config_id);
    expect(retiredPage).not.toContain(old.binding_name);
    // Config and Binding can be referenced by a NEW logical ID, never by the retired ID.
    expect((await post('add', old)).status).toBe(422); // Manual cloud reference registration is no longer exposed.
    await createRegistryConnection(env.DB!, {id:'correct_pg',dialect:'postgres',transport:'hyperdrive',configId:old.config_id,bindingName:old.binding_name});
    expect(sqlite.prepare('SELECT dialect,status,revision FROM database_connections WHERE id=?').get('correct_pg'))
      .toMatchObject({ dialect: 'postgres', status: 'disabled', revision: 1 });
    // A previous activation is not a reason to retain a logically disabled ID
    // once no unresolved in-flight work exists. Upstream config/CA stay untouched.
    sqlite.prepare("UPDATE database_connections SET status='disabled',revision=3 WHERE id='correct_pg'").run();
    sqlite.prepare("UPDATE database_connections SET in_flight_count=1 WHERE id='correct_pg'").run();
    const blockedPage = await handleSetup(new Request(pageUrl, {headers:{'cf-access-jwt-assertion':jwt}}),env,certificates);
    expect(await blockedPage.text()).toContain('Blocked: 1 unresolved execution(s)');
    expect((await post('delete', {id:'correct_pg',revision:'3',confirm_id:'correct_pg'})).status).toBe(503);
    sqlite.prepare("UPDATE database_connections SET in_flight_count=0 WHERE id='correct_pg'").run();
    expect((await post('delete', { id: 'correct_pg', revision: '3', confirm_id: 'correct_pg' })).status).toBe(200);
    expect(sqlite.prepare('SELECT id FROM database_connections WHERE id=?').get('correct_pg'))
      .toBeUndefined();
    expect(sqlite.prepare('SELECT id,upstream_config_id,upstream_binding_name FROM retired_connection_ids WHERE id=?').get('correct_pg'))
      .toMatchObject({id:'correct_pg', upstream_config_id:old.config_id, upstream_binding_name:old.binding_name});
    expect((await post('delete', {id:'correct_pg',revision:'3',confirm_id:'correct_pg'})).status).toBe(404);
  });
  it('preserves active configuration after a failed edit, and requires disable to delete', async () => {
    const { sqlite, env } = fixture(); instances.push(sqlite);
    const { jwt, certificates } = await auth();
    vi.stubGlobal('fetch', async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] }));
    fakeHealth.mockResolvedValue({ latencyMs: 2 });
    const page = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    expect(page.status).toBe(200);
    const markup = await page.text();
    expect(markup).toContain('name="ca_pem"');
    expect(markup).toContain('Hyperdrive strictly verifies certificates');
    const csrf = markup.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] ?? '';
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
    const disabledPage=await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,certificates);
    const enableForm=(await disabledPage.text()).split('action="/setup/enable"')[1]?.split('</form>')[0]??'';
    expect(enableForm).toContain('name="revision"');
    expect(enableForm).not.toContain('name="plaintext_ack"');
    const disabledEdit = await post('edit', { id: 'main', revision: '3', credential_mode: 'replace',
      plaintext_ack: '1', allow_disabled: '1', url: 'mysql://reader:pass@new.example.net/catalog' });
    expect(disabledEdit.status).toBe(422);
    expect(await disabledEdit.text()).toContain('Diagnostic: target_immutable');
    expect(sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main'))
      .toMatchObject({ status: 'disabled', revision: 3, ciphertext });
    // A disabled placeholder with unreachable credentials can be repaired without
    // making it active. An active connection must never accept failed edits.
    fakeHealth.mockRejectedValueOnce(new PublicError('CONNECTION_UNAVAILABLE', 'Unreachable fixture'));
    expect((await post('edit', { id: 'main', revision: '3', credential_mode: 'replace',
      url: 'mysql://reader:replacement@db.example.net/catalog', allow_disabled: '1' })).status).toBe(200);
    row = sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main') as { status: string; revision: number; ciphertext: string };
    expect(row.status).toBe('disabled');
    expect(row.revision).toBe(4);
    expect((await openConnectionConfig(env, 'main', 'mysql', {keyId: 'key-one', ciphertext: row.ciphertext})).ca).toBeUndefined();
    // The plaintext risk was explicitly accepted once at Add; subsequent CRUD
    // does not demand another checkbox for the same immutable transport.
    expect((await post('enable', { id: 'main', revision: '4' })).status).toBe(200);
    expect(fakeHealth.mock.lastCall?.[0]).not.toHaveProperty('ca');
    expect((await post('disable', { id: 'main', revision: '5' })).status).toBe(200);
    expect((await post('edit', { id: 'main', revision: '6', credential_mode: 'keep' })).status).toBe(200);
    row = sqlite.prepare('SELECT status,revision,ciphertext FROM database_connections WHERE id=?').get('main') as typeof row;
    expect(row.revision).toBe(7);
    expect((await openConnectionConfig(env, 'main', 'mysql', {keyId: 'key-one', ciphertext: row.ciphertext})).ca).toBeUndefined();

    expect((await post('delete', { id: 'main', revision: '7', confirm_id: 'other' })).status).toBe(422);
    expect((await post('delete', { id: 'main', revision: '7', confirm_id: 'main' })).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM database_connections').get()).toMatchObject({ n: 0 });
    // Existing Cloudflare Hyperdrive references can be staged as disabled only.
    // Actual SQL activation still requires the reviewed protected workflow.
    const checkedBeforeCloud = fakeHealth.mock.calls.length;
    await createRegistryConnection(env.DB!, {id:'cloud_ref',dialect:'mysql',transport:'hyperdrive',
      configId:'11111111-2222-3333-4444-555555555555',bindingName:'HYPERDRIVE_TEST'});
    expect(fakeHealth.mock.calls.length).toBe(checkedBeforeCloud);
    expect(sqlite.prepare("SELECT dialect,status,revision FROM database_connections WHERE id='cloud_ref'").get())
      .toMatchObject({dialect:'mysql',status:'disabled',revision:1});
    expect((await post('enable', { id: 'cloud_ref', revision: '1' })).status).toBe(503);
    expect((await post('hyperdrive-action', { id: 'cloud_ref', revision: '1',
      hyperdrive_action: 'enable' })).status).toBe(503); // Owner dispatch secret not configured.
    expect((await post('hyperdrive-action', { id: 'cloud_ref', revision: '1',
      hyperdrive_action: 'retire', confirm_id: 'wrong' })).status).toBe(422);
    const unsafeEdit = await post('edit', { id: 'cloud_ref', revision: '1', credential_mode: 'keep' });
    expect(unsafeEdit.status).toBe(503);
    expect(await unsafeEdit.text()).toContain('hyperdrive_isolation_unknown');
    expect(fakeHealth.mock.calls.length).toBe(checkedBeforeCloud);
    // PostgreSQL Direct shares the same guarded, explicitly plaintext Owner flow as MySQL.
    const healthBeforeUnsupportedMode = fakeHealth.mock.calls.length;
    expect((await post('add', { id: 'pg_direct', dialect: 'postgres', transport: 'direct',
      plaintext_ack: '1', url: 'postgres://reader:pass@db.example.net/catalog' })).status).toBe(200);
    expect(sqlite.prepare("SELECT status,dialect,transport FROM database_connections WHERE id='pg_direct'").get())
      .toMatchObject({status:'active', dialect:'postgres',transport:'direct'});
    expect(fakeHealth.mock.calls.length).toBe(healthBeforeUnsupportedMode + 1);
    // The unified Fields input is equivalent to URL submission.
    expect((await post('add', { id: 'pg_fields', dialect: 'postgres', transport: 'direct',
      input_mode: 'fields', host: 'db.example.net', database: 'catalog', username: 'reader',
      password: 'pass', plaintext_ack: '1' })).status).toBe(200);
    expect(sqlite.prepare("SELECT status,dialect FROM database_connections WHERE id='pg_fields'").get())
      .toMatchObject({ status:'active', dialect:'postgres' });
    expect((await post('edit', {id:'pg_fields',revision:'2',credential_mode:'replace',input_mode:'fields',
      host:'db.example.net',database:'catalog',username:'new_reader',password:'new_pass',plaintext_ack:'1'})).status).toBe(200);

    // PostgreSQL Hyperdrive reference registration is disabled by default
    // and cannot bypass protected activation.
    await createRegistryConnection(env.DB!, {id:'pg_proxy',dialect:'postgres',transport:'hyperdrive',
      configId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',bindingName:'HYPERDRIVE_PG'});
    expect(sqlite.prepare("SELECT status,transport,dialect FROM database_connections WHERE id='pg_proxy'").get())
      .toMatchObject({ status: 'disabled', transport: 'hyperdrive', dialect: 'postgres' });
    const initialPage = await handleSetup(new Request(pageUrl, { headers: { 'cf-access-jwt-assertion': jwt } }), env, certificates);
    const initialPageHtml = await initialPage.text();
    expect(initialPageHtml).toContain('Add connection');
    expect(initialPageHtml).toContain('name="input_mode"');
    expect(initialPageHtml).not.toContain('name="config_id"');
    expect(initialPageHtml).not.toContain('Preview new Hyperdrive');

    expect(initialPageHtml).toContain('<option value="postgres">');
    expect(initialPageHtml).toContain('<select name="dialect">');
    expect(initialPageHtml).toContain('<option value="postgres">');
    expect(initialPageHtml).toContain('name="transport" value="direct"');
    expect(initialPageHtml).toContain('name="transport" value="hyperdrive"');
    expect(initialPageHtml).toContain('Hyperdrive operations require protected Binding/TLS/CA verification');
    expect(initialPageHtml).toContain('action="/setup/hyperdrive-action"');
    expect(initialPageHtml).toContain('<button type="submit">Enable</button>');
    expect(initialPageHtml).toContain('Advanced resource cleanup');
    expect(initialPageHtml).not.toContain('name="ciphertext"');
    expect(initialPageHtml).not.toContain('reader:pass');
    vi.unstubAllGlobals();
  });
  it('retired multi-stage Preview/Prepare endpoints no longer accept requests',async()=>{
    const {sqlite,env}=fixture();instances.push(sqlite);
    const {jwt,certificates}=await auth();
    const page=await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,certificates);
    const html=await page.text();
    const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]??'';
    const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
    for(const path of ['hyperdrive-preview','hyperdrive-prepare']) {
      const result=await handleSetup(new Request(pageUrl+'/'+path,{
        method:'POST',headers:{'cf-access-jwt-assertion':jwt,origin:'https://db-owner.example.net',
          cookie,'content-type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({csrf,id:'synthetic',origin_password:'do-not-send'})
      }),env,certificates);
      expect(result.status).toBe(404);
    }
    expect(sqlite.prepare('SELECT COUNT(*) n FROM hyperdrive_operations').get()).toEqual({n:0});
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
    expect(html).toContain('<select name="dialect">');
    expect(html).toContain('<option value="postgres">');
    expect(html).toContain('<option value="mysql">');
    expect(html).toContain('<option value="postgres">');
    expect(html).toContain('name="transport" value="direct"');
    expect(html).toContain('name="transport" value="hyperdrive"');
    expect(html).not.toContain('placeholder="b2b"');
    expect(html).toContain('<select name="dialect">');
    expect(html).not.toContain('<select name="transport">');
    expect(html).not.toContain('<details><summary>Advanced options</summary>');
    expect(html).toContain('<details class="maintenance"><summary>Maintenance</summary>');
    expect(html).toContain('type="checkbox" name="plaintext_ack" value="1"');
    expect(html).toContain('Save connection');
    expect(html).not.toContain('Owner-only. Passwords and origin URLs');
    expect(html).not.toContain('protected atomic activation');
    expect(html).not.toContain('Final apply from this page is blocked until');
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
          return_run_details: true,
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

it('Owner final apply enforces CSRF, typed ID, explicit confirmation and one dispatch with unknown receipt', async () => {
  const { sqlite, env } = fixture(); instances.push(sqlite);
  env.DATABASE_GITHUB_ACTIONS_TOKEN = 'synthetic-owner-token-at-least-20';
  const operationId = '12345678-1234-1234-1234-123456789abc';
  sqlite.prepare(`INSERT INTO hyperdrive_operations(operation_id,logical_id,action,expected_revision,phase,
    expected_source_sha,head_sha,config_id,binding_name,pr_number,created_at,updated_at,expires_at)
    VALUES (?,'new_owner','create',0,'awaiting_confirmation',?,?,?,'HYPERDRIVE_NEW_OWNER_12345678',3,1,1,?)`)
    .run(operationId,'a'.repeat(40),'b'.repeat(40),'c'.repeat(32),Date.now()+600000);
  const { jwt, certificates } = await auth();
  let dispatches = 0;
  const upstream: typeof fetch = async (url, init) => {
    if (String(url).includes('certs')) return certificates();
    dispatches++;
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body))).toEqual({ref:'main',return_run_details:true,inputs:{
      worker:'database-mcp-worker',deploy_to_production:'false',database_hyperdrive_apply_id:operationId
    }});
    // Claim is visible before any external request.
    expect(sqlite.prepare('SELECT phase,error_class FROM hyperdrive_operations').get())
      .toMatchObject({phase:'running',error_class:'github_apply_dispatch_inflight'});
    return new Response(null,{status:204});
  };
  const page = await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,upstream);
  const html = await page.text();
  expect(html).toContain('action="/setup/hyperdrive-apply"');
  const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)![1]!;
  const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
  const post = (values: Record<string,string>, ownerEnv = env) => handleSetup(new Request(pageUrl+'/hyperdrive-apply',{
    method:'POST',headers:{'cf-access-jwt-assertion':jwt,origin:'https://db-owner.example.net',cookie,
      'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf,operation_id:operationId,confirm_id:'new_owner',confirm_apply:'1',...values})
  }),ownerEnv,upstream);
  expect((await post({csrf:'wrong'})).status).toBe(403);
  expect((await post({confirm_id:'other'})).status).toBe(409);
  expect((await post({confirm_apply:''})).status).toBe(422);
  expect((await post({}, {...env,OWNER_EMAIL:'someone-else@example.net'})).status).toBe(401);
  expect(dispatches).toBe(0);
  expect((await post({})).status).toBe(200);
  expect(dispatches).toBe(1);
  expect(sqlite.prepare('SELECT phase,apply_run_id FROM hyperdrive_operations').get())
    .toMatchObject({phase:'unknown',apply_run_id:null});
  expect((await post({})).status).toBe(409);
  expect(dispatches).toBe(1);
  const after = await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,upstream);
  expect(await after.text()).not.toContain('action="/setup/hyperdrive-apply"');
});

it('Owner sees read-only staged unbinding status from /setup with CSRF and disabled revision gates', async () => {
  const {sqlite,env}=fixture();instances.push(sqlite);
  sqlite.prepare(`INSERT INTO database_connections
    (id,dialect,transport,status,config_id,binding_name,revision,created_at,updated_at)
    VALUES ('safe_id','mysql','hyperdrive','disabled',
      '11111111-2222-3333-4444-555555555555','HYPERDRIVE_SAFETY',4,1,1)`).run();
  // This status-only POST must not run the generic lazy operation-expiry UPDATE.
  sqlite.prepare(`INSERT INTO hyperdrive_operations
    (operation_id,logical_id,action,expected_revision,phase,created_at,updated_at,expires_at)
    VALUES ('77777777-7777-4777-8777-777777777777','expired_candidate','create',0,'pending',1,1,1)`).run();
  env.DATABASE_GITHUB_ACTIONS_TOKEN='t'.repeat(40);
  const {jwt,certificates}=await auth();
  let githubCalls=0;let branch='';let tampered=false;
  const requestFetch:typeof fetch=async (url,options)=>{
    if(String(url).includes('api.github.com')){
      githubCalls++;
      expect(options?.method).toBe('GET');
      if(String(url).includes('/pulls?')){
        branch=String(url).match(/head=lirtual%3A([^&]+)/)?.[1] ?? '';
        return Response.json([{number:88}]);
      }
      if(String(url).endsWith('/pulls/88'))return Response.json({
        number:88,state:'open',draft:true,changed_files:2,
        head:{ref:tampered?'unrelated-branch':branch,repo:{full_name:'lirtual/mcp-workers'}},
        base:{ref:'main',repo:{full_name:'lirtual/mcp-workers'}}
      });
      if(String(url).endsWith('/pulls/88/files?per_page=100'))return Response.json([
        {filename:'apps/database-mcp-worker/wrangler.jsonc',status:'modified'},
        {filename:'apps/database-mcp-worker/hyperdrive-bindings.json',status:'modified'}]);
      throw Error('unexpected read');
    }
    return certificates();
  };
  const page=await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,requestFetch);
  expect(page.status).toBe(200);
  const html=await page.text();
  expect(html).toContain('action="/setup/hyperdrive-unbind-status"');
  const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1] ?? '';
  const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
  const post=(values:Record<string,string>)=>handleSetup(new Request(pageUrl+'/hyperdrive-unbind-status',{
    method:'POST',headers:{'cf-access-jwt-assertion':jwt,origin:'https://db-owner.example.net',
      cookie,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf,id:'safe_id',revision:'4',...values})
  }),env,requestFetch);
  expect((await post({csrf:'invalid'})).status).toBe(403);
  expect((await post({revision:'5'})).status).toBe(422);
  expect(githubCalls).toBe(0);
  const response=await post({});
  expect(response.status).toBe(200);
  const result=await response.text();
  expect(result).toContain('Open PR #88');
  expect(result).toContain('Unbinding Draft PR is open');
  expect(result).toContain('does not approve merge, start a release');
  expect(githubCalls).toBe(3);
  tampered=true;
  const bad=await post({});
  expect(bad.status).toBe(503);
  expect(await bad.text()).not.toContain('Open PR #88');
  expect(githubCalls).toBe(5);
  expect(sqlite.prepare('SELECT revision,status FROM database_connections WHERE id=?').get('safe_id'))
    .toMatchObject({revision:4,status:'disabled'});
  expect(sqlite.prepare('SELECT phase,updated_at FROM hyperdrive_operations WHERE logical_id=?').get('expired_candidate'))
    .toMatchObject({phase:'pending',updated_at:1});
});

it('Owner rotation readiness is read-only in D1 and rejects stale, invalid or missing authority',async()=>{
 const {sqlite,env}=fixture();instances.push(sqlite);
 sqlite.prepare(`INSERT INTO database_connections
   (id,dialect,transport,status,config_id,binding_name,revision,created_at,updated_at)
   VALUES ('pending_hd','mysql','hyperdrive','disabled',
     '11111111222233334444555555555555','HYPERDRIVE_TEST',4,1,1)`).run();
 const {jwt,certificates}=await auth();
 const dispatched:unknown[]=[];
 const requestFetch:typeof fetch=async(input,init)=>{
  if(String(input).includes('api.github.com')){
   dispatched.push(JSON.parse(String(init?.body)));
   return Response.json({workflow_run_id:475});
  }
  return certificates();
 };
 const open=()=>handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,requestFetch);
 const page=await open();expect(page.status).toBe(200);
 const html=await page.text();
 expect(html).not.toContain('action="/setup/hyperdrive-rotation-check"');
 const rotationForm=html.split('action="/setup/hyperdrive-rotation-check"')[1]?.split('</form>')[0]??'';
 expect(rotationForm).not.toContain('name="origin_password"');
 const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]??'';
 const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
 const post=(values:Record<string,string>)=>handleSetup(new Request(pageUrl+'/hyperdrive-rotation-check',{
  method:'POST',headers:{'cf-access-jwt-assertion':jwt,origin:'https://db-owner.example.net',
   cookie,'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({csrf,id:'pending_hd',revision:'4',rotation_mode:'credentials',...values})
 }),env,requestFetch);
 expect((await post({csrf:'invalid'})).status).toBe(403);
 expect((await post({revision:'5'})).status).toBe(422);
 expect((await post({rotation_mode:'apply'})).status).toBe(422);
 expect(dispatched).toHaveLength(0);
 env.DATABASE_GITHUB_ACTIONS_TOKEN='t'.repeat(40);
 const answer=await post({});expect(answer.status).toBe(200);
 expect(await answer.text()).toContain('Workflow Run ID: 475');
 expect(dispatched).toHaveLength(1);
 expect(dispatched[0]).toMatchObject({inputs:{database_hyperdrive_rotation_mode:'credentials',
  database_hyperdrive_id:'pending_hd',database_hyperdrive_revision:'4',deploy_to_production:'false'}});
 expect(sqlite.prepare("SELECT status,revision,updated_at FROM database_connections WHERE id='pending_hd'").get())
  .toEqual({status:'disabled',revision:4,updated_at:1});
 expect(sqlite.prepare('SELECT COUNT(*) AS n FROM hyperdrive_operations').get()).toEqual({n:0});
});


it('Owner credential-rotation confirmation never includes plaintext in GitHub dispatch or response',async()=>{
 const {sqlite,env}=fixture();instances.push(sqlite);
 sqlite.prepare(`INSERT INTO database_connections
  (id,dialect,transport,status,revision,config_id,binding_name,target_metadata,created_at,updated_at)
  VALUES ('rotatable','mysql','hyperdrive','disabled',4,?,?,?,1,1)`)
  .run('a'.repeat(32),'HYPERDRIVE_UNBOUND','{"dialect":"mysql"}');
 env.DATABASE_GITHUB_ACTIONS_TOKEN='t'.repeat(40);
 const {jwt,certificates}=await auth();
 const sends:unknown[]=[];
 const requestFetch:typeof fetch=async(input,init)=>{
  if(String(input).includes('api.github.com')){
   sends.push(JSON.parse(String(init?.body)));return Response.json({workflow_run_id:476});
  }
  return certificates();
 };
 const page=await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,requestFetch);
 const html=await page.text();
 expect(html).toContain('action="/setup/hyperdrive-credentials"');
 const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]??'';
 const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
 const post=(changes:Record<string,string>)=>handleSetup(new Request(pageUrl+'/hyperdrive-credentials',{
  method:'POST',headers:{'cf-access-jwt-assertion':jwt,origin:'https://db-owner.example.net',
   cookie,'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({csrf,id:'rotatable',revision:'4',confirm_id:'rotatable',
   confirm_credentials:'1',new_password:'synthetic-secret-value',...changes})
 }),env,requestFetch);
 expect((await post({confirm_credentials:'0'})).status).toBe(422);
 expect((await post({confirm_id:'other'})).status).toBe(422);
 expect((await post({revision:'5'})).status).toBe(409);
 expect(sends).toHaveLength(0);
 const reply=await post({});expect(reply.status).toBe(200);
 expect(await reply.text()).not.toContain('synthetic-secret-value');
 expect(sends).toHaveLength(1);
 expect(JSON.stringify(sends)).not.toContain('synthetic-secret-value');
 expect(sends[0]).toMatchObject({inputs:{database_hyperdrive_rotation_mode:'credentials_apply',
  deploy_to_production:'false'}});
 const persisted=sqlite.prepare('SELECT action,phase,ciphertext,prepare_run_id FROM hyperdrive_operations').get() as Record<string,unknown>;
 expect(persisted).toMatchObject({action:'rotate_credentials',phase:'running',prepare_run_id:476});
 expect(JSON.stringify(persisted)).not.toContain('synthetic-secret-value');
 expect((await post({})).status).toBe(409);
});


it('prepares a replacement from active or disabled Hyperdrive without mutating ongoing source executions',async()=>{
 const {sqlite,env}=fixture();instances.push(sqlite);
 const prior={binding:'HYPERDRIVE_ORIGINAL',id:'a'.repeat(32),dialect:'postgres',
  origin_host:'pg.example.net',origin_port:5432,origin_database:'app',origin_user:'oldreader',
  ca_certificate_id:'old-ca-1234567890'};
 sqlite.prepare(`INSERT INTO database_connections
  (id,dialect,transport,status,config_id,binding_name,revision,target_metadata,created_at,updated_at)
  VALUES ('old_conn','postgres','hyperdrive','disabled',?,?,2,?,1,1)`)
  .run(prior.id,prior.binding,JSON.stringify(prior));
 env.DATABASE_GITHUB_ACTIONS_TOKEN='t'.repeat(40);
 const {jwt,certificates}=await auth();const dispatches:string[]=[];
 const requestFetch:typeof fetch=async(input,options)=>{
  const url=String(input);
  if(url.endsWith('/actions/permissions/workflow'))return Response.json({can_approve_pull_request_reviews:false});
  if(url.endsWith('/branches/main/protection'))return Response.json({required_status_checks:{strict:true,contexts:['Required checks gate']}});
  if(url.endsWith('/actions/workflows/release.yml/dispatches')){
   dispatches.push(String(options?.body));return Response.json({workflow_run_id:476});
  }
  return certificates();
 };
 const page=await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,requestFetch);
 const html=await page.text();expect(html).toContain('name="replacement_for"');
 const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]??'';
 const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
 const base={csrf,id:'new_conn',transport:'hyperdrive',dialect:'postgres',input_mode:'fields',
  host:'pg.example.net',database:'app',username:'newreader+tenant@project',
  password:'synthetic-secret',replacement_for:'old_conn'};
 const save=(override:Record<string,string>={})=>handleSetup(new Request(pageUrl+'/add',{
  method:'POST',headers:{'cf-access-jwt-assertion':jwt,origin:'https://db-owner.example.net',
   cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...base,...override})
 }),env,requestFetch);
 for(const invalid of [{host:'different.example.net'},{database:'other'},
   {replacement_for:'nonexistent'},{id:'old_conn'},
   {ca_certificate_id:'manual-override-forbidden'}])expect((await save(invalid)).status).toBe(422);
 // Staging a separate candidate does not patch the active source, nor
 // interrupt a source read already holding a durable SQL admission claim.
 sqlite.prepare("UPDATE database_connections SET status='active',in_flight_count=1 WHERE id='old_conn'").run();
 const activePreparation=await save({id:'active_replacement'});
 expect(activePreparation.status).toBe(200);
 expect(sqlite.prepare("SELECT status,in_flight_count,config_id,revision FROM database_connections WHERE id='old_conn'").get())
  .toMatchObject({status:'active',in_flight_count:1,revision:2,config_id:prior.id});
 expect(dispatches).toHaveLength(1);
 sqlite.prepare("UPDATE database_connections SET status='disabled' WHERE id='old_conn'").run();
 // Immutable metadata cannot be corrupted after creation; use a distinct
 // malformed historical source to test fail-closed provenance validation.
 sqlite.prepare("INSERT INTO database_connections (id,dialect,transport,status,config_id,binding_name,revision,target_metadata,created_at,updated_at) VALUES ('malformed_source','postgres','hyperdrive','disabled',?,?,2,'{}',1,1)")
  .run('b'.repeat(32),'HYPERDRIVE_BAD_SOURCE');
 expect((await save({replacement_for:'malformed_source'})).status).toBe(422);
 expect(dispatches).toHaveLength(1);
 const accepted=await save();expect(accepted.status).toBe(200);
 expect(await accepted.text()).not.toContain(base.password);
 expect(dispatches).toHaveLength(2);
 expect(dispatches.every(x=>!x.includes(base.password))).toBe(true);
 expect(sqlite.prepare("SELECT status,revision,config_id,in_flight_count FROM database_connections WHERE id='old_conn'").get())
  .toMatchObject({status:'disabled',revision:2,config_id:prior.id,in_flight_count:1});
 const row=sqlite.prepare("SELECT operation_id,phase,key_id FROM hyperdrive_operations WHERE logical_id='new_conn'").get() as {
  operation_id:string;phase:string;key_id:string
 };
 expect(row).toMatchObject({phase:'running',key_id:'key-one'});
 const {readHyperdrivePreparation}=await import('../../src/setup/hyperdrive-operations.js');
 const candidate=await readHyperdrivePreparation(env.DB!,env,row.operation_id);
 expect(candidate).toMatchObject({user:'newreader+tenant@project',caCertificateId:prior.ca_certificate_id});
 const pem='-----BEGIN CERTIFICATE-----\n'+btoa('isolated-new-ca-fixture')+'\n-----END CERTIFICATE-----';
 expect((await save({id:'with_new_ca',ca_pem:pem})).status).toBe(200);
 const second=sqlite.prepare("SELECT operation_id FROM hyperdrive_operations WHERE logical_id='with_new_ca'").get() as {operation_id:string};
 expect(await readHyperdrivePreparation(env.DB!,env,second.operation_id)).toMatchObject({
  user:'newreader+tenant@project',caPem:pem
 });
 expect(dispatches).toHaveLength(3);
 expect(JSON.stringify(dispatches)).not.toContain(base.password);
});

it('unified Save reuses strict CA replacement provenance without altering its active source', async () => {
 const {sqlite,env}=fixture();instances.push(sqlite);
 const prior={binding:'HYPERDRIVE_PRIOR',id:'a'.repeat(32),dialect:'postgres',
  origin_host:'pg.example.net',origin_port:5432,origin_database:'app',origin_user:'reader',
  ca_certificate_id:'old-ca-1234567890'};
 sqlite.prepare(`INSERT INTO database_connections
  (id,dialect,transport,status,config_id,binding_name,revision,target_metadata,created_at,updated_at)
  VALUES ('original','postgres','hyperdrive','active',?,?,2,?,1,1)`)
  .run(prior.id,prior.binding,JSON.stringify(prior));
 env.DATABASE_GITHUB_ACTIONS_TOKEN='t'.repeat(40);
 const {jwt,certificates}=await auth();
 const dispatches:string[]=[];
 const requestFetch:typeof fetch=async(input,options)=>{
  const url=String(input);
  if(url.endsWith('/actions/permissions/workflow'))return Response.json({can_approve_pull_request_reviews:false});
  if(url.endsWith('/branches/main/protection'))return Response.json({required_status_checks:{strict:true,contexts:['Required checks gate']}});
  if(url.endsWith('/actions/workflows/release.yml/dispatches')){
   dispatches.push(String(options?.body));return Response.json({workflow_run_id:476});
  }
  return certificates();
 };
 const page=await handleSetup(new Request(pageUrl,{headers:{'cf-access-jwt-assertion':jwt}}),env,requestFetch);
 const html=await page.text();expect(html).toContain('Prepare a Hyperdrive replacement (new ID)');
 const csrf=html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1]??'';
 const cookie=page.headers.get('set-cookie')!.split(';')[0]!;
 const input={csrf,id:'replacement',transport:'hyperdrive',dialect:'postgres',input_mode:'fields',
  host:'pg.example.net',database:'app',username:'reader',password:'synthetic-secret',
  ca_replaces:'original',ca_pem:'-----BEGIN CERTIFICATE-----\n'+btoa('new-ca-fixture')+'\n-----END CERTIFICATE-----'};
 const save=(override:Record<string,string>={})=>handleSetup(new Request(pageUrl+'/add',{
  method:'POST',headers:{'cf-access-jwt-assertion':jwt,origin:'https://db-owner.example.net',
   cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...input,...override})
 }),env,requestFetch);
 for(const invalid of [{host:'different.example.net'},{database:'other'},
   {ca_replaces:'missing'},{id:'original'}, {ca_pem:''}]) {
  expect((await save(invalid)).status).toBe(422);
 }
 expect(dispatches).toHaveLength(0);
 const accepted=await save();expect(accepted.status).toBe(200);
 expect(await accepted.text()).not.toContain(input.password);
 expect(dispatches).toHaveLength(1);
 expect(dispatches[0]).not.toContain(input.password);
 expect(sqlite.prepare("SELECT status,revision,config_id FROM database_connections WHERE id='original'").get())
  .toMatchObject({status:'active',revision:2,config_id:prior.id});
 expect(sqlite.prepare("SELECT phase,key_id FROM hyperdrive_operations WHERE logical_id='replacement'").get())
  .toMatchObject({phase:'running',key_id:'key-one'});
});
