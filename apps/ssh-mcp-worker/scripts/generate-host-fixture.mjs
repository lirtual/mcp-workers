import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const upstreamCrypto = process.argv[2];
if (!upstreamCrypto) {
  throw new Error('Pass the pinned EdgeSSH src/accounts/crypto.ts path as the first argument.');
}

const fixedIv = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
let fixtureNumber = 0;
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    subtle: webcrypto.subtle,
    getRandomValues(bytes) { const iv = Uint8Array.from(fixedIv); iv[11] += fixtureNumber++; bytes.set(iv); return bytes; },
  },
});

const { encryptHost } = await import(pathToFileURL(upstreamCrypto).href);
const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const accountId = '11111111-1111-4111-8111-111111111111';
if (process.argv[3] === '--long-catalog') {
  const rows = [];
  for (let index = 0; index < 200; index += 1) {
    const hostId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`;
    const host = {
      name: '主'.repeat(80), group: '组'.repeat(40), host: `ssh-${String(index + 1).padStart(3, '0')}.fixture.test`,
      port: 2222, username: '用'.repeat(128), authMethod: 'password', password: 'synthetic-password-do-not-use',
      initialCommand: 'synthetic-initial-command-do-not-run', termType: 'xterm-256color', encoding: 'utf-8',
      fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', location: null,
    };
    rows.push({ id: hostId, account_id: accountId, encrypted_payload: await encryptHost(host, key, accountId, hostId), updated_at: 10 });
  }
  process.stdout.write(`${JSON.stringify({ source: 'lirtual/EdgeSSH@7a051e412d2cfa4ee52edec30e6ccefedb4e1c99/src/accounts/crypto.ts', key, accountId, rows }, null, 2)}\n`);
  process.exit(0);
}
const hostId = '22222222-2222-4222-8222-222222222222';
const secondHostId = '33333333-3333-4333-8333-333333333333';
const host = {
  name: 'Synthetic fixture',
  group: 'Tests',
  host: 'fixture.example.test',
  port: 2222,
  username: 'fixture-user',
  authMethod: 'password',
  password: 'synthetic-password-do-not-use',
  initialCommand: 'synthetic-initial-command-do-not-run',
  termType: 'xterm-256color',
  encoding: 'utf-8',
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  location: null,
};
const encryptedPayload = await encryptHost(host, key, accountId, hostId);
const secondEncryptedPayload = await encryptHost(host, key, accountId, secondHostId);
const changedHost = { ...host, name: 'Changed synthetic fixture', fingerprint: 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
const changedEncryptedPayload = await encryptHost(changedHost, key, accountId, hostId);
process.stdout.write(`${JSON.stringify({ source: 'lirtual/EdgeSSH@7a051e412d2cfa4ee52edec30e6ccefedb4e1c99/src/accounts/crypto.ts', key, accountId, hostId, host, encryptedPayload, secondHostId, secondEncryptedPayload, changedHost, changedEncryptedPayload }, null, 2)}\n`);
