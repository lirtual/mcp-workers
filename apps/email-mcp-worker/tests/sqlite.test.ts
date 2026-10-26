import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { encrypt, decrypt } from '../src/crypto.ts';
import { rotateCredentials } from '../src/rotation.ts';
import { fencedSend, listAccounts } from '../src/tools.ts';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_accounts.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...args: any[]) {
          return {
            async run() {
              const result = statement.run(...args);
              return { meta: { changes: result.changes } };
            },
            async first() { return statement.get(...args) ?? null; },
            async all() { return { results: statement.all(...args) }; },
          };
        },
      };
    },
  };
  return { sqlite, env: { DB, MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64') } as any };
}

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secrets = { imap_host: 'imap.example.test', imap_port: 993, smtp_host: 'smtp.example.test',
  smtp_port: 465, username: 'alice', password: 'never-log-this' };

async function addAccount(sqlite: DatabaseSync, env: any, id = accountId) {
  const sealed = await encrypt(env, 'account:' + id + ':imap_smtp', secrets);
  sqlite.prepare('INSERT INTO mail_accounts(account_id,provider,address,status,credential_ciphertext,credential_key_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, 'imap_smtp', 'alice@example.test', 'active', sealed.ciphertext, sealed.keyId, 1, 1);
  return sealed;
}

test('actual SQL migration accepts only IMAP/SMTP accounts, stores no OAuth session or plaintext', async () => {
  const { sqlite, env } = fixture();
  const sealed = await addAccount(sqlite, env);
  const row = sqlite.prepare('SELECT * FROM mail_accounts').get() as any;
  assert.equal(row.provider, 'imap_smtp');
  assert.doesNotMatch(row.credential_ciphertext, /never-log-this/);
  assert.deepEqual(await decrypt(env, 'account:' + accountId + ':imap_smtp', sealed.ciphertext, sealed.keyId), secrets);
  assert.equal((await listAccounts(env)).length, 1);
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='oauth_sessions'").get(), undefined);
  assert.throws(() => sqlite.prepare('INSERT INTO mail_accounts(account_id,provider,address,status,credential_ciphertext,credential_key_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'gmail', 'owner@gmail.com', 'active', 'fake', '1', 1, 1), /CHECK constraint/);
  assert.throws(() => sqlite.prepare('INSERT INTO mail_accounts(account_id,provider,address,status,credential_ciphertext,credential_key_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'graph', 'owner@outlook.com', 'active', 'fake', '1', 1, 1), /CHECK constraint/);
  sqlite.close();
});

test('IMAP account reconnect preserves stable ID only for same address', async () => {
  const { sqlite, env } = fixture();
  await addAccount(sqlite, env);
  const rotated = await encrypt(env, 'account:' + accountId + ':imap_smtp', { ...secrets, password: 'new-secret' });
  const update = sqlite.prepare('UPDATE mail_accounts SET credential_ciphertext=?,credential_key_id=?,updated_at=? WHERE account_id=? AND provider=? AND lower(address)=? AND status!=?');
  assert.equal(update.run(rotated.ciphertext, rotated.keyId, 2, accountId, 'imap_smtp', 'wrong@example.test', 'disabled').changes, 0);
  assert.equal(update.run(rotated.ciphertext, rotated.keyId, 2, accountId, 'imap_smtp', 'alice@example.test', 'disabled').changes, 1);
  assert.equal((sqlite.prepare('SELECT count(*) AS total FROM mail_accounts').get() as any).total, 1);
  sqlite.close();
});

test('owner-triggered key rotation is bounded, encrypted and independently readable', async () => {
  const { sqlite, env } = fixture();
  await addAccount(sqlite, env);
  const next = { ...env, MAIL_KEY_ID: '2',
    MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    MAIL_ENCRYPTION_PREVIOUS_KEY: env.MAIL_ENCRYPTION_KEY, MAIL_PREVIOUS_KEY_ID: '1' };
  const result = await rotateCredentials(next);
  assert.deepEqual(result, { rotated: 1, pending: 0 });
  const row = sqlite.prepare('SELECT * FROM mail_accounts').get() as any;
  assert.deepEqual(await decrypt(next, 'account:' + accountId + ':imap_smtp', row.credential_ciphertext, row.credential_key_id), secrets);
  assert.deepEqual(await rotateCredentials(next), { rotated: 0, pending: 0 });
  sqlite.close();
});

test('SQL-backed send fence preserves uncertain outcome and prevents dispatch replay', async () => {
  const { sqlite, env } = fixture();
  await addAccount(sqlite, env);
  const account = sqlite.prepare('SELECT * FROM mail_accounts').get() as any;
  let calls = 0;
  const action = async () => { calls++; throw new Error('unknown transport outcome'); };
  const first = await fencedSend(env, account, 'request_1234567', { op: 'send', to: ['b@example.test'] }, action);
  assert.equal(first.status, 'indeterminate');
  const replay = await fencedSend(env, account, 'request_1234567', { op: 'send', to: ['b@example.test'] }, action);
  assert.equal(replay.status, 'indeterminate');
  assert.equal(replay.duplicate, true);
  assert.equal(calls, 1);
  sqlite.close();
});
