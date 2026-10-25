import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beginOAuth, completeOAuth } from '../src/oauth.ts';
import { fencedSend } from '../src/tools.ts';

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
  const env = {
    DB,
    MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'),
    GOOGLE_CLIENT_ID: 'test-app-id',
    GOOGLE_CLIENT_SECRET: 'secret-only-for-unit-tests',
  } as any;
  return { sqlite, env };
}
function makeFetch(address = 'owner@example.test') {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'unit-test-token', refresh_token: 'unit-test-refresh', expires_in: 3600 });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
      return Response.json({ emailAddress: address });
    }
    throw new Error('unexpected remote: ' + url);
  }) as typeof fetch;
}
function extractState(redirect: string): string {
  const url = new URL(redirect);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://email.lirtual.dpdns.org/oauth/callback');
  return url.searchParams.get('state')!;
}

test('actual SQL migration creates an OAuth mailbox once and never stores plaintext tokens', async () => {
  const { sqlite, env } = fixture();
  const state = extractState(await beginOAuth(env, 'gmail', 'access-sub'));
  const stored = sqlite.prepare('SELECT * FROM oauth_sessions').get() as any;
  assert.notEqual(stored.state_hash, state);
  assert.doesNotMatch(stored.pkce_ciphertext, /unit-test/);
  const accountId = await completeOAuth(env, state, 'code-once', 'access-sub', makeFetch());
  assert.match(accountId, /^[0-9a-f-]{36}$/);
  const row = sqlite.prepare('SELECT * FROM mail_accounts WHERE account_id=?').get(accountId) as any;
  assert.equal(row.address, 'owner@example.test');
  assert.equal(row.provider, 'gmail');
  assert.equal(row.status, 'active');
  assert.doesNotMatch(row.credential_ciphertext, /unit-test-token|unit-test-refresh/);
  await assert.rejects(() => completeOAuth(env, state, 'code-once', 'access-sub', makeFetch()), /invalid_oauth_state/);
  sqlite.close();
});

test('reconnect preserves account ID, detects identity substitution and does not duplicate mailboxes', async () => {
  const { sqlite, env } = fixture();
  let state = extractState(await beginOAuth(env, 'gmail', 'access-sub'));
  const id = await completeOAuth(env, state, 'initial-code', 'access-sub', makeFetch());
  sqlite.prepare('UPDATE mail_accounts SET status=? WHERE account_id=?').run('reauthorization_required', id);
  state = extractState(await beginOAuth(env, 'gmail', 'access-sub', id));
  await assert.rejects(() => completeOAuth(env, state, 'code-for-different-account', 'access-sub', makeFetch('intruder@example.test')),
    /reauthorization_identity_mismatch/);
  assert.equal((sqlite.prepare('SELECT status FROM mail_accounts WHERE account_id=?').get(id) as any).status, 'reauthorization_required');
  state = extractState(await beginOAuth(env, 'gmail', 'access-sub', id));
  const again = await completeOAuth(env, state, 'new-code', 'access-sub', makeFetch());
  assert.equal(again, id);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM mail_accounts').get() as any).n, 1);
  assert.equal((sqlite.prepare('SELECT status FROM mail_accounts WHERE account_id=?').get(id) as any).status, 'active');
  sqlite.close();
});

test('owner subject mismatch cannot consume a session', async () => {
  const { sqlite, env } = fixture();
  const state = extractState(await beginOAuth(env, 'gmail', 'trusted-owner'));
  await assert.rejects(() => completeOAuth(env, state, 'stolen-code', 'other-owner', makeFetch()), /invalid_oauth_state/);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM mail_accounts').get() as any).n, 0);
  sqlite.close();
});

test('D1-shaped send fence persists unknown result across duplicate request', async () => {
  const { sqlite, env } = fixture();
  const accountId = crypto.randomUUID();
  sqlite.prepare('INSERT INTO mail_accounts(account_id,provider,address,status,credential_ciphertext,credential_key_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(accountId, 'gmail', 'owner@example.test', 'active', 'fake', '1', 1, 1);
  const account = { account_id: accountId } as any;
  let count = 0;
  const dispatch = async (): Promise<{ status: 'submitted' }> => { count++; throw new Error('after-send timeout'); };
  const original = await fencedSend(env, account, 'opaque-request-123', { subject: 'hello' }, dispatch);
  assert.equal(original.status, 'indeterminate');
  assert.equal((sqlite.prepare('SELECT status FROM send_attempts').get() as any).status, 'indeterminate');
  const duplicate = await fencedSend(env, account, 'opaque-request-123', { subject: 'hello' }, dispatch);
  assert.equal(duplicate.duplicate, true);
  assert.equal(count, 1);
  sqlite.close();
});
