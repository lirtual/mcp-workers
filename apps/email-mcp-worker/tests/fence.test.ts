import test from 'node:test';
import assert from 'node:assert/strict';
import { fencedSend } from '../src/tools.ts';
import { MailError } from '../src/types.ts';
import { assertSmtpRecipientAcceptance } from '../src/smtp.ts';
const account = { account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', provider: 'imap_smtp', status: 'active' } as any;
function database() {
  const records = new Map<string, { payload_digest: string; status: string; reference: string | null }>();
  return {
    prepare(query: string) {
      return {
        bind(...params: any[]) {
          return {
            async run() {
              if (query.startsWith('DELETE FROM send_attempts')) return { meta: { changes: 0 } };
              if (query.startsWith('INSERT OR IGNORE')) {
                const [accountId, id, digest, status] = params;
                const key = accountId + ':' + id;
                if (records.has(key)) return { meta: { changes: 0 } };
                records.set(key, { payload_digest: digest, status, reference: null });
                return { meta: { changes: 1 } };
              }
              if (query.startsWith('UPDATE send_attempts SET status=? WHERE')) {
                const [status, accountId, id] = params;
                const item = records.get(accountId + ':' + id)!;
                item.status = status;
                return { meta: { changes: 1 } };
              }
              if (query.startsWith('UPDATE send_attempts')) {
                const [status, ref, accountId, id] = params;
                const item = records.get(accountId + ':' + id)!;
                item.status = status;
                item.reference = ref;
                return { meta: { changes: 1 } };
              }
              throw Error('unexpected query');
            },
            async first() {
              const [accountId, id] = params;
              return records.get(accountId + ':' + id) ?? null;
            },
          };
        },
      };
    },
    records,
  };
}
test('only first send dispatches, repeat never sends, digest conflict fails', async () => {
  const db = database(), env = { DB: db } as any;
  let dispatches = 0;
  const fn = async () => { dispatches++; return { status: 'accepted' as const }; };
  const first = await fencedSend(env, account, 'stable-id-123', { to: ['x@y.com'] }, fn);
  assert.equal(first.status, 'accepted');
  const again = await fencedSend(env, account, 'stable-id-123', { to: ['x@y.com'] }, fn);
  assert.equal(again.duplicate, true);
  assert.equal(dispatches, 1);
  await assert.rejects(() => fencedSend(env, account, 'stable-id-123', { to: ['z@y.com'] }, fn), /conflicting_send_request/);
});
test('unknown send outcome stays fenced and cannot trigger a retry', async () => {
  const db = database(), env = { DB: db } as any;
  let dispatches = 0;
  const fn = async (): Promise<{ status: 'accepted' }> => { dispatches++; throw new Error('network timeout'); };
  const first = await fencedSend(env, account, 'request-abc123', { body: 'Hello' }, fn);
  assert.equal(first.status, 'indeterminate');
  const replay = await fencedSend(env, account, 'request-abc123', { body: 'Hello' }, fn);
  assert.equal(replay.status, 'indeterminate');
  assert.equal(replay.duplicate, true);
  assert.equal(dispatches, 1);
});

test('unconfirmed reply recipient is failed before submission and remains fenced', async () => {
  const db = database(), env = { DB: db } as any;
  let dispatches = 0;
  const operation = async (): Promise<{ status: 'accepted' }> => {
    dispatches++;
    throw new MailError('reply_recipient_mismatch');
  };
  await assert.rejects(
    () => fencedSend(env, account, 'reply-check-123', { to: 'wrong@example.test' }, operation),
    /reply_recipient_mismatch/,
  );
  assert.equal(db.records.get(account.account_id + ':reply-check-123')?.status, 'failed');
  const duplicate = await fencedSend(env, account, 'reply-check-123', { to: 'wrong@example.test' }, operation);
  assert.equal(duplicate.status, 'failed');
  assert.equal(duplicate.duplicate, true);
  assert.equal(dispatches, 1);
});

test('SMTP partial recipient acceptance is never marked fully accepted', () => {
  const recipients = ['first@example.test', 'second@example.test'];
  assert.doesNotThrow(() => assertSmtpRecipientAcceptance({
    accepted: ['FIRST@example.test', 'second@example.test'], rejected: [],
  }, recipients));
  assert.throws(() => assertSmtpRecipientAcceptance({
    accepted: ['first@example.test'], rejected: ['second@example.test'],
  }, recipients), /smtp_partial_rejection/);
  assert.throws(() => assertSmtpRecipientAcceptance({
    accepted: ['first@example.test'], rejected: [],
  }, recipients), /smtp_partial_rejection/, 'missing recipient acceptance cannot be ignored');
  assert.throws(() => assertSmtpRecipientAcceptance({ accepted: [], rejected: [] }, recipients),
    /smtp_partial_rejection/);
});

test('partial SMTP submission remains indeterminate and duplicate dispatch is fenced', async () => {
  const db = database(), env = { DB: db } as any;
  let dispatches = 0;
  const send = async (): Promise<{ status: 'accepted' }> => {
    dispatches++;
    assertSmtpRecipientAcceptance({
      accepted: ['first@example.test'], rejected: ['second@example.test'],
    }, ['first@example.test', 'second@example.test']);
    return { status: 'accepted' };
  };
  const input = { to: ['first@example.test', 'second@example.test'], body: 'hello' };
  const first = await fencedSend(env, account, 'partial-smtp-123', input, send);
  assert.equal(first.status, 'indeterminate');
  assert.equal(first.error, 'smtp_partial_rejection');
  assert.equal(db.records.get(account.account_id + ':partial-smtp-123')?.status, 'indeterminate');
  const again = await fencedSend(env, account, 'partial-smtp-123', input, send);
  assert.equal(again.status, 'indeterminate');
  assert.equal(again.duplicate, true);
  assert.equal(dispatches, 1, 'already accepted recipient must never receive an automatic replay');
});
