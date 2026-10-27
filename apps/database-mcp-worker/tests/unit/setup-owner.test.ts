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
    const response = setupPage([{ id: 'test<svg onload=1>', dialect: 'mysql', status: 'disabled',
      revision: 1, created_at: 1, updated_at: 2 }], 'a'.repeat(43));
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    return response.text().then(body => {
      expect(body).not.toContain('<svg');
      expect(body).toContain('&lt;svg');
    });
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
        'content-type': 'application/x-www-form-urlencoded', 'content-length': '25000' },
      body: 'csrf=' + csrf }), validEnv, mock);
    expect(oversized.status).toBe(413);

    for (const invalid of [
      await token('another@example.org', 'test-aud', now + 120),
      await token('owner@example.org', 'wrong-audience', now + 120),
      await token('owner@example.org', 'test-aud', now - 120),
      valid.slice(0, -6) + 'broken'
    ]) await expect(verifyAccess(req(invalid), base, mock)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
