import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/crypto.ts';
import { verifyAccess, validateCsrf } from '../src/access.ts';
const env = {
  MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com',
  ACCESS_AUD: 'trusted-app-audience',
  OWNER_EMAIL: 'owner@example.com',
} as any;

test('AES-GCM is non-deterministic and binds account identity', async () => {
  const a = await encrypt(env, 'account:a:gmail', { access_token: 'secret' });
  const b = await encrypt(env, 'account:a:gmail', { access_token: 'secret' });
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.deepEqual(await decrypt(env, 'account:a:gmail', a.ciphertext, a.keyId), { access_token: 'secret' });
  await assert.rejects(() => decrypt(env, 'account:b:gmail', a.ciphertext, a.keyId));
  const corrupt = a.ciphertext.slice(0, -2) + 'AB';
  await assert.rejects(() => decrypt(env, 'account:a:gmail', corrupt, a.keyId));
});
test('setup is forbidden on alternate host and rejects missing Access assertion', async () => {
  await assert.rejects(() => verifyAccess(new Request('https://email-mcp-worker.aiyaya.workers.dev/setup'), env), /not_found/);
  await assert.rejects(() => verifyAccess(new Request('https://email.lirtual.dpdns.org/setup'), env), /unauthorized/);
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
