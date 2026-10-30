import { describe, expect, it } from 'vitest';
import { validateCsrf, csrfCookie, verifyAccess } from '../../src/setup/access.js';
import { setupPage } from '../../src/setup/page.js';
import { handleSetup } from '../../src/setup/handler.js';
import type { Env } from '../../src/types.js';

const base = { DATABASE_SETUP_HOST: 'db-owner.example.org', ACCESS_TEAM_DOMAIN: 'testing.cloudflareaccess.com',
  ACCESS_AUD: 'test-aud', OWNER_EMAIL: 'owner@example.org' } as Env;
const url = 'https://db-owner.example.org/setup';

describe('Database Owner setup authorization', () => {
  it('denies wrong hosts and missing JWT before any D1 operations', async () => {
    for (const address of ['https://db-worker.workers.dev/setup', 'https://db-owner.pages.dev/setup', 'http://db-owner.example.org/setup']) {
      await expect(verifyAccess(new Request(address), base)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    }
    await expect(verifyAccess(new Request(url), base)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const response = await handleSetup(new Request(url), base);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('requires correct POST origin and cookie-bound CSRF token', () => {
    const token = 'a'.repeat(43);
    expect(csrfCookie(token)).toContain('Secure; HttpOnly; SameSite=Strict');
    expect(() => validateCsrf(new Request(url, { method: 'POST',
      headers: { origin: 'https://db-owner.example.org', cookie: 'database_setup_csrf=' + token } }), base, token)).not.toThrow();
    expect(() => validateCsrf(new Request(url, { method: 'POST',
      headers: { origin: 'null', cookie: 'database_setup_csrf=' + token } }), base, token)).toThrow();
  });
  it('renders metadata only and escapes untrusted connection identifiers', () => {
    const response = setupPage([{ id: 'test<svg onload=1>', dialect: 'mysql', transport: 'direct', status: 'disabled',
      revision: 1, created_at: 1, updated_at: 2 }], 'a'.repeat(43));
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    return response.text().then(body => {
      expect(body).not.toContain('<svg');
      expect(body).toContain('&lt;svg');
    });
  });
  it('offers a safe new-ID replacement for an active Hyperdrive connection without requiring downtime', async () => {
    const response = setupPage([{ id: 'primary_pg', dialect: 'postgres', transport: 'hyperdrive', status: 'active',
      revision: 3, created_at: 1, updated_at: 2 }], 'a'.repeat(43));
    const body = await response.text();
    expect(body).toContain('Prepare replacement while active');
    expect(body).toContain('href="#add-connection"');
    expect(body).toContain('Existing Hyperdrive Connection ID (active or disabled)');
    expect(body).not.toContain('Existing disabled Connection ID');
    expect(body).not.toContain('Disable this connection before editing credentials or retiring its logical ID.');
  });
});

describe('Cloudflare-native Owner identity', () => {
  const env = { ...base,
    DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
    SETUP_RATE_LIMITER: { limit: async () => ({ success: true }) }
  } as unknown as Env;
  const verified = (aud: string, email?: string): CloudflareAccessContext =>
    ({ aud, getIdentity: async () => ({ email, user_uuid: 'owner-uuid' }) }) as CloudflareAccessContext;
  it('uses the runtime-attested exact audience and Owner without fetching certs or trusting unverified headers', async () => {
    const noNetwork = async (): Promise<Response> => { throw new Error('certificate fetch must not be needed'); };
    const result = await handleSetup(new Request(url), env, noNetwork, verified('test-aud', 'OWNER@example.org'));
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('No database connections configured');
    // Assert the actual entrypoint forwards ctx.access to the Owner handler.
    const worker = (await import('../../src/index.js')).default;
    const direct = await worker.fetch(new Request(url), env, { access: verified('test-aud', 'owner@example.org') } as ExecutionContext);
    expect(direct.status).toBe(200);
    for (const identity of [verified('different-app', 'owner@example.org'),
      verified('test-aud', 'intruder@example.org'), verified('test-aud')]) {
      const denied = await handleSetup(new Request(url), env, noNetwork, identity);
      expect(denied.status).toBe(401);
    }
    const wrongHost = await handleSetup(new Request('https://other.example.org/setup'), env,
      noNetwork, verified('test-aud', 'owner@example.org'));
    expect(wrongHost.status).toBe(403);
    // A fake request header cannot synthesize runtime-verified ctx.access.
    const fake = await handleSetup(new Request(url, { headers: { 'cf-access-jwt-assertion': 'forged' } }), env, noNetwork);
    expect(fake.status).toBe(401);
    const badNative = await handleSetup(new Request(url), env, noNetwork, {
      aud: 'test-aud', getIdentity: async () => { throw new Error('private identity error'); }
    });
    const html = await badNative.text();
    expect(badNative.status).toBe(503);
    expect(html).toContain('Diagnostic: auth_identity');
    expect(html).not.toContain('private identity error');
  });
});

describe('Cloudflare Access signed JWT enforcement', () => {
  it('verifies RS256 signature, issuer, audience, expiration and exact Owner identity', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const mock = async () => Response.json({ keys: [{ ...jwk, kid: 'testing', alg: 'RS256' }] });
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    async function token(email: string, audience: string, expires: number) {
      const signed = b64({ alg: 'RS256', kid: 'testing' }) + '.' + b64({
        iss: 'https://testing.cloudflareaccess.com', aud: audience,
        email, sub: 'owner-sub', exp: expires
      });
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signed));
      return signed + '.' + Buffer.from(signature).toString('base64url');
    }
    const now = Math.floor(Date.now() / 1000);
    const valid = await token('owner@example.org', 'test-aud', now + 120);
    const req = (jwt: string) => new Request(url, { headers: { 'cf-access-jwt-assertion': jwt } });
    await expect(verifyAccess(req(valid), base, mock)).resolves.toMatchObject({ email: 'owner@example.org' });
    const validEnv = { ...base, DB: {
      prepare: () => ({ all: async () => ({ results: [] }) })
    }, SETUP_RATE_LIMITER: { limit: async () => ({ success: true }) } } as unknown as Env;
    const page = await handleSetup(req(valid), validEnv, mock);
    expect(page.status).toBe(200);
    const missingDbEnv = { ...validEnv };
    delete missingDbEnv.DB;
    const missingBinding = await handleSetup(req(valid), missingDbEnv, mock);
    expect(missingBinding.status).toBe(503);
    expect(await missingBinding.text()).toContain('Diagnostic: runtime_bindings');
    const unavailableCerts = await handleSetup(req(valid), validEnv, async () => {
      throw new Error('never expose secret credentials or URL');
    });
    expect(unavailableCerts.status).toBe(503);
    const certHtml = await unavailableCerts.text();
    expect(certHtml).toContain('Diagnostic: auth_certs_fetch');
    expect(certHtml).not.toContain('never expose');
    const badStatus = await handleSetup(req(valid), validEnv, async () => new Response('redacted', { status: 302 }));
    expect(await badStatus.text()).toContain('Diagnostic: auth_certs_http');
    const invalidDocument = await handleSetup(req(valid), validEnv, async () => new Response('not-json'));
    expect(await invalidDocument.text()).toContain('Diagnostic: auth_certs_json');
    const unavailableRegistry = await handleSetup(req(valid), { ...validEnv,
      DB: { prepare: () => ({ all: async () => { throw new Error('private SQL'); } }) }
    } as unknown as Env, mock);
    expect(unavailableRegistry.status).toBe(503);
    const registryHtml = await unavailableRegistry.text();
    expect(registryHtml).toContain('Diagnostic: registry_read');
    expect(registryHtml).not.toContain('private SQL');
    const html = await page.text();
    expect(html).toContain('No database connections configured');
    const csrf = html.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
    const cookie = page.headers.get('set-cookie')?.split(';')[0];
    expect(csrf).toBeTruthy();
    expect(cookie).toBe('database_setup_csrf=' + csrf);
    const unsafe = await handleSetup(new Request(url + '/add', { method: 'POST',
      headers: { 'cf-access-jwt-assertion': valid, origin: 'null', cookie: cookie!,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: csrf!, id: 'foo' }) }), validEnv, mock);
    expect(unsafe.status).toBe(403);
    const oversized = await handleSetup(new Request(url + '/add', { method: 'POST',
      headers: { 'cf-access-jwt-assertion': valid, origin: url, cookie: cookie!,
        'content-type': 'application/x-www-form-urlencoded', 'content-length': '40001' },
      body: 'csrf=' + csrf }), validEnv, mock);
    expect(oversized.status).toBe(413);

    // Content-Length may be absent (chunked requests) or smaller than the real
    // stream. The 40 KB cap must reject before attempting to parse the form.
    for (const payload of ['padding=' + 'x'.repeat(40_000),
      'padding=' + '界'.repeat(14_000)]) {
      const request = new Request(url + '/add', { method: 'POST',
        headers: { 'cf-access-jwt-assertion': valid,
          origin: 'https://db-owner.example.org', cookie: cookie!,
          'content-type': 'application/x-www-form-urlencoded' },
        body: payload });
      expect(request.headers.has('content-length')).toBe(false);
      const response = await handleSetup(request, validEnv, mock);
      expect(response.status).toBe(413);
    }

    for (const invalid of [
      await token('another@example.org', 'test-aud', now + 120),
      await token('owner@example.org', 'wrong-audience', now + 120),
      await token('owner@example.org', 'test-aud', now - 120),
      valid.slice(0, -6) + 'broken'
    ]) await expect(verifyAccess(req(invalid), base, mock)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
