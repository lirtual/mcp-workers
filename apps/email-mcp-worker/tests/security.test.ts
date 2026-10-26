import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/crypto.ts';
import { verifyAccess, validateCsrf, csrfCookie } from '../src/access.ts';
import { SETUP_CSP, handleSetup } from '../src/setup.ts';
const env = {
  MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
  ACCESS_AUD: 'trusted-app-audience',
  OWNER_EMAIL: 'owner@example.com',
} as any;

test('AES-GCM is non-deterministic and binds account identity', async () => {
  const a = await encrypt(env, 'account:a:imap_smtp', { access_token: 'secret' });
  const b = await encrypt(env, 'account:a:imap_smtp', { access_token: 'secret' });
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.deepEqual(await decrypt(env, 'account:a:imap_smtp', a.ciphertext, a.keyId), { access_token: 'secret' });
  await assert.rejects(() => decrypt(env, 'account:b:imap_smtp', a.ciphertext, a.keyId));
  const corrupt = a.ciphertext.slice(0, -2) + 'AB';
  await assert.rejects(() => decrypt(env, 'account:a:imap_smtp', corrupt, a.keyId));
});
test('setup is forbidden on alternate host and rejects missing Access assertion', async () => {
  await assert.rejects(() => verifyAccess(new Request('https://email-mcp-worker.aiyaya.workers.dev/setup'), env), /not_found/);
  await assert.rejects(() => verifyAccess(new Request('https://email.lirtual.dpdns.org/setup'), env), /unauthorized/);
});
test('CSRF cookie survives app-password setup without relaxing origin or token binding', () => {
  const cookie = csrfCookie('a'.repeat(43));
  assert.match(cookie, /Max-Age=3600/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure; HttpOnly/);
});
test('CSRF rejects opaque/null Origin even with browser same-origin metadata', () => {
  const token = 'a'.repeat(43);
  const sameOriginForm = {
    'origin': 'null', 'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    'cookie': 'email_setup_csrf=' + token,
  };
  assert.throws(() => validateCsrf(new Request('https://email.lirtual.dpdns.org/setup/imap/add', {
    method: 'POST', headers: sameOriginForm,
  }), token), /csrf_rejected/);
});
test('CSRF rejects missing cookie, invalid origin and reused token mismatch', () => {
  const token = 'a'.repeat(43);
  assert.throws(() => validateCsrf(new Request('https://email.lirtual.dpdns.org/setup/remove', {
    method: 'POST', headers: { origin: 'https://malicious.example' },
  }), token), /csrf_rejected/);
  assert.throws(() => validateCsrf(new Request('https://email.lirtual.dpdns.org/setup/remove', {
    method: 'POST', headers: { origin: 'https://email.lirtual.dpdns.org', cookie: 'email_setup_csrf=b' },
  }), token), /csrf_rejected/);
  assert.doesNotThrow(() => validateCsrf(new Request('https://email.lirtual.dpdns.org/setup/remove', {
    method: 'POST', headers: { origin: 'https://email.lirtual.dpdns.org', cookie: 'email_setup_csrf=' + token },
  }), token));
});

test('Access JWT requires a trusted RS256 signature, correct audience and owner identity', async () => {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const url = 'https://email.lirtual.dpdns.org/setup';
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  async function sign(aud: string, email: string) {
    const header = encode({ alg: 'RS256', kid: 'test-key' });
    const payload = encode({
      iss: 'https://test.cloudflareaccess.com', aud, sub: 'owner-access-user',
      email, exp: Math.floor(Date.now() / 1000) + 120,
    });
    const data = header + '.' + payload;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, Buffer.from(data));
    return data + '.' + Buffer.from(signature).toString('base64url');
  }
  let certFetches = 0;
  const mockFetch = async () => {
    certFetches++;
    return Response.json({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256' }] });
  };
  const createRequest = (jwt: string) => new Request(url, {
    headers: { 'cf-access-jwt-assertion': jwt },
  });
  const validJwt = await sign('trusted-app-audience', 'owner@example.com');
  assert.deepEqual(await verifyAccess(createRequest(validJwt), env, mockFetch as any), {
    sub: 'owner-access-user', email: 'owner@example.com',
  });
  await assert.rejects(() => verifyAccess(createRequest(validJwt.slice(0, -3) + 'AAA'), env, mockFetch as any));
  const wrongAudience = await sign('wrong-audience', 'owner@example.com');
  await assert.rejects(() => verifyAccess(createRequest(wrongAudience), env, mockFetch as any), /unauthorized/);
  const wrongOwner = await sign('trusted-app-audience', 'other@example.com');
  await assert.rejects(() => verifyAccess(createRequest(wrongOwner), env, mockFetch as any), /unauthorized/);
  // The retired OAuth entry point must fail even for an authorized owner.
  const retired = await handleSetup(new Request(
    'https://email.lirtual.dpdns.org/setup/oauth/start',
    { method: 'POST', headers: { 'cf-access-jwt-assertion': validJwt } },
  ), env, mockFetch as any);
  assert.equal(retired.status, 404);

  // A valid Access assertion is not enough to submit IMAP credentials:
  // same-origin CSRF still needs a cookie-bound token.
  const invalidCsrf = await handleSetup(new Request(
    'https://email.lirtual.dpdns.org/setup/imap/add', {
      method: 'POST',
      headers: { 'cf-access-jwt-assertion': validJwt,
        origin: 'https://email.lirtual.dpdns.org',
        'content-type': 'application/x-www-form-urlencoded' },
      body: 'csrf=untrusted',
    },
  ), env, mockFetch as any);
  assert.equal(invalidCsrf.status, 400);
  assert.match(await invalidCsrf.text(), /csrf_rejected/);
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  const page = await handleSetup(createRequest(validJwt), { ...env, DB: db }, mockFetch as any);
  assert.equal(page.status, 200);
  // no-referrer turns some same-origin HTML form POSTs into Origin: null.
  // same-origin limits Referer exposure to this exact origin, preserving strict CSRF Origin checks.
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const html = await page.text();
  assert.match(html, /name="viewport"/);
  assert.match(html, /form\{display:grid/);
  const formToken = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const formCookie = page.headers.get('set-cookie')?.split(';')[0];
  assert.ok(formToken && formCookie);
  assert.equal(formCookie, 'email_setup_csrf=' + formToken);
  const paired = await handleSetup(new Request(url + '/imap/add', {
    method: 'POST', headers: { 'cf-access-jwt-assertion': validJwt,
      origin: 'https://email.lirtual.dpdns.org', cookie: formCookie,
      'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: formToken, address: 'invalid' }),
  }), { ...env, DB: db }, mockFetch as any);
  assert.equal(paired.status, 400);
  assert.match(await paired.text(), /invalid_mail_identity/);
  assert.ok(certFetches >= 1);
});

test('encryption key rotation preserves explicit key identity only with the previous secret', async () => {
  const original = await encrypt(env, 'account:unchanged:imap_smtp', { token: 'rotation' });
  const rotatedEnv = {
    ...env,
    MAIL_KEY_ID: '2',
    MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
    MAIL_ENCRYPTION_PREVIOUS_KEY: env.MAIL_ENCRYPTION_KEY,
    MAIL_PREVIOUS_KEY_ID: original.keyId,
  };
  assert.deepEqual(await decrypt(rotatedEnv, 'account:unchanged:imap_smtp', original.ciphertext, original.keyId), {
    token: 'rotation',
  });
  await assert.rejects(() => decrypt({ ...rotatedEnv, MAIL_ENCRYPTION_PREVIOUS_KEY: undefined },
    'account:unchanged:imap_smtp', original.ciphertext, original.keyId), /encryption_key_unavailable/);
});

test('setup CSP permits only same-origin form posts, no OAuth destinations', () => {
  const action = SETUP_CSP.match(/(?:^|; )form-action ([^;]+);/)?.[1];
  assert.equal(action, "'self'");
  assert.match(SETUP_CSP, /default-src 'none'/);
  assert.match(SETUP_CSP, /base-uri 'none'/);
  assert.match(SETUP_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(SETUP_CSP, /google|microsoft|live\.com|https:\*/i);
});
