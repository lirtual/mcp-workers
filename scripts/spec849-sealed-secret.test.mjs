import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OLD_ENVIRONMENTS, openSecret, sealSecret } from './spec849-sealed-secret.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const nonce = '0123456789abcdef0123456789abcdef';
const secretName = 'SSH_ENCRYPTION_KEY';
const options = { publicKeyPem: publicKey, secretName, phase: 'old', nonce };
const verifyOptions = { privateKey, secretName, phase: 'old', nonce };

test('Spec 849 six Secret names map to exactly five old Environments', () => {
  assert.equal(Object.keys(OLD_ENVIRONMENTS).length, 6);
  assert.equal(new Set(Object.values(OLD_ENVIRONMENTS)).size, 5);
});

test('fake payloads preserve exact UTF-8 bytes, whitespace, CRLF, and trailing newlines', () => {
  const examples = [
    'FAKE-SPEC849-123',
    'FAKE-FIRST\nFAKE-SECOND\n',
    'FAKE-WINDOWS\r\nFAKE-WINDOWS-END\r\n',
    '  FAKE  \t  ',
    'FAKE-UTF8-测试-🌟\n',
    'line1\n\nline3\n\n',
    'FAKE-QUOTES-\\"$#{}!<>',
  ];
  for (const value of examples) {
    const original = Buffer.from(value, 'utf8');
    const sealed = sealSecret({ ...options, value: original });
    assert.deepEqual(openSecret(sealed, verifyOptions), original);
    assert.notEqual(sealed.ciphertext, original.toString('base64'));
  }
});

test('same fake payload uses randomized ciphertext', () => {
  const value = Buffer.from('FAKE-VALUE', 'utf8');
  const left = sealSecret({ ...options, value });
  const right = sealSecret({ ...options, value });
  assert.notEqual(left.ciphertext, right.ciphertext);
  assert.deepEqual(openSecret(left, verifyOptions), openSecret(right, verifyOptions));
});

test('rejects modified secret ciphertext or metadata without revealing data', () => {
  const sealed = sealSecret({ ...options, value: Buffer.from('FAKE-KEY') });
  assert.throws(() => openSecret({ ...sealed, phase: 'repository' }, verifyOptions),
    /metadata mismatch/);
  assert.throws(() => openSecret({ ...sealed, nonce: 'f'.repeat(32) }, verifyOptions),
    /metadata mismatch/);
  const altered = { ...sealed, ciphertext: Buffer.from('different').toString('base64') };
  assert.throws(() => openSecret(altered, verifyOptions));
  assert.throws(() => openSecret({ ...sealed, tag: '!!!!' }, verifyOptions),
    /encoding/);
});

test('rejects missing inputs, invalid recipient, and oversize fake values', () => {
  assert.throws(() => sealSecret({ ...options, value: Buffer.alloc(0) }), /1-49152/);
  assert.throws(() => sealSecret({ ...options, value: Buffer.alloc(49153) }), /1-49152/);
  assert.throws(() => sealSecret({ ...options, value: Buffer.from('FAKE'), secretName: 'OTHER' }),
    /Unknown Secret/);
  assert.throws(() => sealSecret({ ...options, value: Buffer.from('FAKE'), publicKeyPem: 'INVALID' }));
  assert.throws(() => sealSecret({ ...options, value: Buffer.from('FAKE'), nonce: 'incorrect' }),
    /Invalid nonce/);
});

test('workflow source job is environment-bound; repository verifier is not', () => {
  const text = readFileSync('.github/workflows/spec849-sealed-secret.yml', 'utf8');
  assert.match(text, /github\.actor == 'lirtual'/);
  assert.match(text, /github\.ref == 'refs\/heads\/main'/);
  assert.match(text, /environment:\n\s+name: \$\{\{ needs\.preflight\.outputs\.old_environment \}\}/);
  const repoJob = text.split('\n  repository:\n')[1];
  assert.ok(repoJob, 'Repository-only job exists');
  assert.doesNotMatch(repoJob, /^\s+environment:\s*$/m);
  assert.match(repoJob, /SPEC849_SECRET_VALUE: \$\{\{ secrets\[inputs\.secret_name\] \}\}/);
  assert.match(text, /retention-days: 1/g);
  assert.equal((text.match(/retention-days: 1/g) ?? []).length, 2);
  assert.doesNotMatch(text, /(?:push:|pull_request:)/);
});

test('one-time local handoff has mandatory apply/verify modes and original source checks', () => {
  const text = readFileSync('scripts/spec849-migrate-local.mjs', 'utf8');
  assert.match(text, /mode === 'apply'/);
  assert.match(text, /if \(targetExists\(secretName\)\)/);
  assert.match(text, /requireExactMain\(expectedMain\)/);
  assert.match(text, /timingSafeEqual\(source, repository\)/);
  assert.doesNotMatch(text, /console\.log\(source|console\.log\(repository|JSON\.stringify\(source/);
});
