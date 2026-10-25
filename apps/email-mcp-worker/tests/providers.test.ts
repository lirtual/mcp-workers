import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt } from '../src/crypto.ts';
import { searchMail, validateGraphNextLink } from '../src/providers.ts';
const NEXT = 'https://graph.microsoft.com/v1.0/me/messages?%24skip=41&%24top=10';
test('Graph nextLink must remain in same mailbox and preserve upstream continuation', () => {
  assert.equal(validateGraphNextLink(NEXT), '/messages?%24skip=41&%24top=10');
  for (const value of [
    'https://evil.example/v1.0/me/messages?$skip=41',
    'https://graph.microsoft.com.evil.example/v1.0/me/messages?$skip=41',
    'https://graph.microsoft.com/v1.0/users/other/messages?$skip=41',
    'http://graph.microsoft.com/v1.0/me/messages?$skip=41',
    'https://graph.microsoft.com/v1.0/me/messages?%24top=10',
    '//evil.example/v1.0/me/messages?$skip=41',
  ]) assert.throws(() => validateGraphNextLink(value), /invalid_cursor/, value);
});
test('Graph search uses untouched upstream nextLink without calculating skip', async () => {
  const root = Buffer.alloc(32, 3).toString('base64');
  const env = { MAIL_ENCRYPTION_KEY: root } as any;
  const aid = crypto.randomUUID();
  const secret = await encrypt(env, 'account:' + aid + ':graph', { access_token: 'token' });
  const account = {
    account_id: aid, provider: 'graph', address: 'owner@example.test',
    status: 'active', credential_ciphertext: secret.ciphertext,
    credential_key_id: secret.keyId, token_expires_at: Date.now() / 1000 + 3600,
  } as any;
  const previous = globalThis.fetch;
  const seen: string[] = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
      assert.equal(init?.redirect, 'error');
      if (seen.length === 1) return Response.json({
        value: [{ id:'first', subject:'first', receivedDateTime:'2026-10-25T00:00:00Z' }],
        '@odata.nextLink': NEXT,
      });
      return Response.json({ value: [{ id:'second', subject:'second', receivedDateTime:'2026-10-24T00:00:00Z' }] });
    }) as typeof fetch;
    const first = await searchMail(env, account, 'hello');
    assert.equal(first.next, '/messages?%24skip=41&%24top=10');
    assert.equal(first.messages[0]?.id, 'first');
    const second = await searchMail(env, account, 'hello', first.next);
    assert.equal(second.messages[0]?.id, 'second');
    assert.equal(seen[1], NEXT);
  } finally { globalThis.fetch = previous; }
});
test('Gmail reply preserves native thread and RFC Message-ID relations; forward does not fabricate a thread', async () => {
  const { replyGmail, forwardGmail } = await import('../src/providers.ts');
  const root = Buffer.alloc(32, 3).toString('base64');
  const env = { MAIL_ENCRYPTION_KEY: root } as any;
  const accountId = crypto.randomUUID();
  const secret = await encrypt(env, 'account:' + accountId + ':gmail', { access_token: 'token' });
  const account = {
    account_id: accountId, provider: 'gmail', address: 'me@example.test', status: 'active',
    credential_ciphertext: secret.ciphertext, credential_key_id: secret.keyId,
    token_expires_at: Date.now() / 1000 + 3600,
  } as any;
  const original = {
    id: 'source123', threadId: 'thread123', internalDate: String(Date.now()),
    snippet: 'Hello', payload: {
      headers: [
        { name: 'Message-ID', value: '<abc123@sender.test>' },
        { name: 'From', value: 'Someone <sender@example.test>' },
        { name: 'Subject', value: 'Subject 123' },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Original body').toString('base64url') } }],
    },
  };
  const oldFetch = globalThis.fetch;
  const sent: any[] = [];
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/messages/source123?format=full')) return Response.json(original);
      if (target.endsWith('/messages/send')) {
        const body = JSON.parse(String(init?.body));
        sent.push({ ...body, mime: Buffer.from(body.raw, 'base64url').toString('utf8') });
        return Response.json({ id: 'new-message-' + sent.length });
      }
      throw new Error('unexpected route ' + target);
    }) as typeof fetch;
    const reply = await replyGmail(env, account, 'source123', 'Thanks', 'sender@example.test');
    assert.equal(reply.status, 'submitted');
    assert.equal(sent[0].threadId, 'thread123');
    assert.match(sent[0].mime, /In-Reply-To: <abc123@sender\.test>\r\nReferences: <abc123@sender\.test>/);
    assert.match(sent[0].mime, /To: sender@example\.test/);
    assert.match(sent[0].mime, /\r\n\r\n/);
    const forward = await forwardGmail(env, account, 'source123', ['target@example.test'], 'For review');
    assert.equal(forward.status, 'submitted');
    assert.equal(sent[1].threadId, undefined);
    assert.match(sent[1].mime, /To: target@example\.test/);
    assert.ok(sent[1].mime.includes(Buffer.from('Fwd: Subject 123').toString('base64')));
    original.payload.headers.push({ name: 'Reply-To', value: 'untrusted@example.test' });
    const { getMail } = await import('../src/providers.ts');
    const observed = await getMail(env, account, 'source123');
    assert.equal(observed.reply_to, 'untrusted@example.test');
    await assert.rejects(() => replyGmail(env, account, 'source123', 'Thanks', 'sender@example.test'), /reply_recipient_mismatch/);
    assert.equal(sent.length, 2, 'unconfirmed Reply-To must never dispatch a message');
    await replyGmail(env, account, 'source123', 'Thanks', 'untrusted@example.test');
    assert.match(sent[2].mime, /To: untrusted@example\.test/);
  } finally { globalThis.fetch = oldFetch; }
});
test('Graph thread_get filters native conversationId and marks truncation', async () => {
  const { threadGet } = await import('../src/providers.ts');
  const env = { MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64') } as any;
  const accountId = crypto.randomUUID();
  const secret = await encrypt(env, 'account:' + accountId + ':graph', { access_token: 'token' });
  const account = {
    account_id: accountId, provider: 'graph', address: 'owner@example.test',
    status: 'active', credential_ciphertext: secret.ciphertext,
    credential_key_id: secret.keyId, token_expires_at: Date.now() / 1000 + 3600,
  } as any;
  const prior = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, 'https://graph.microsoft.com');
      assert.equal(parsed.pathname, '/v1.0/me/messages');
      assert.equal(parsed.searchParams.get('$filter'), "conversationId eq 'native-conversation'");
      assert.equal(new Headers(init?.headers).get('Prefer'), 'IdType="ImmutableId"');
      return Response.json({
        value: [{ id: 'message1', conversationId: 'native-conversation', subject: 'Hello', receivedDateTime: '2026-10-25T01:00:00Z' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=31',
      });
    }) as typeof fetch;
    const result = await threadGet(env, account, 'native-conversation');
    assert.equal(result.thread_id, 'native-conversation');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].account_id, accountId);
    assert.equal(result.truncated, true);
  } finally { globalThis.fetch = prior; }
});


test('cross-mailbox pagination does not replay a completed mailbox', async () => {
  const { searchAcross } = await import('../src/tools.ts');
  const key = Buffer.alloc(32, 9).toString('base64');
  const mailboxes = new Map<string, any>();
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [index, aid] of ids.entries()) {
    const credentials = await encrypt({ MAIL_ENCRYPTION_KEY: key } as any, 'account:' + aid + ':graph',
      { access_token: index === 0 ? 'token-a' : 'token-b' });
    mailboxes.set(aid, {
      account_id: aid, provider: 'graph', address: 'mailbox' + index + '@example.test',
      status: 'active', credential_ciphertext: credentials.ciphertext,
      credential_key_id: credentials.keyId, token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
  }
  const env = {
    MAIL_ENCRYPTION_KEY: key,
    DB: {
      prepare(sql: string) {
        assert.equal(sql, 'SELECT * FROM mail_accounts WHERE account_id=?');
        return { bind(aid: string) { return { async first() { return mailboxes.get(aid) ?? null; } }; } };
      },
    },
  } as any;
  const previous = globalThis.fetch;
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const token = new Headers(init?.headers).get('authorization');
      assert.equal(url.pathname, '/v1.0/me/messages');
      calls.push(token ?? '');
      const result = (id: string) => ({ id, subject: id, receivedDateTime: '2026-10-25T00:00:00Z' });
      if (token === 'Bearer token-a') {
        if (url.searchParams.has('$skip')) return Response.json({ value: [result('a-second')] });
        return Response.json({ value: [result('a-first')],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=10&$top=10' });
      }
      if (token === 'Bearer token-b') return Response.json({ value: [result('b-only')] });
      throw new Error('unexpected test account');
    }) as typeof fetch;
    const first = await searchAcross(env, ids, 'hello', undefined);
    assert.deepEqual(first.messages.map((m: any) => m.id).sort(), ['a-first', 'b-only']);
    assert.equal(typeof first.cursor, 'string');
    const second = await searchAcross(env, ids, 'hello', first.cursor);
    assert.deepEqual(second.messages.map((m: any) => m.id), ['a-second']);
    assert.equal(second.cursor, undefined);
    assert.equal(calls.filter(x => x === 'Bearer token-a').length, 2);
    assert.equal(calls.filter(x => x === 'Bearer token-b').length, 1,
      'a mailbox with no nextPageToken must not be queried again');
  } finally { globalThis.fetch = previous; }
});
