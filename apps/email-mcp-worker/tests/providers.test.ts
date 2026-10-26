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


test('Graph reply requires a single confirmed native Reply-To before sending', async () => {
  const { assertGraphReplyRecipient, getMail } = await import('../src/providers.ts');
  const root = Buffer.alloc(32, 12).toString('base64');
  const env = { MAIL_ENCRYPTION_KEY: root } as any;
  const aid = crypto.randomUUID();
  const secret = await encrypt(env, 'account:' + aid + ':graph', { access_token: 'graph-token' });
  const account = {
    account_id: aid, provider: 'graph', address: 'owner@example.test', status: 'active',
    credential_ciphertext: secret.ciphertext, credential_key_id: secret.keyId,
    token_expires_at: Math.floor(Date.now() / 1000) + 3600,
  } as any;
  const source = {
    id: 'source-id', from: { emailAddress: { address: 'sender@example.test' } },
    replyTo: [{ emailAddress: { address: 'untrusted@example.test' } }],
  };
  const previous = globalThis.fetch;
  let sent = 0;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') sent++;
      assert.equal(init?.method, undefined, 'recipient preflight must never send');
      assert.equal(url.origin, 'https://graph.microsoft.com');
      if (url.pathname === '/v1.0/me/messages/source-id/attachments') return Response.json({ value: [] });
      assert.equal(url.pathname, '/v1.0/me/messages/source-id');
      assert.match(url.search, /replyTo/);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer graph-token');
      return Response.json(source);
    }) as typeof fetch;
    const msg = await getMail(env, account, 'source-id');
    assert.equal(msg.reply_to, 'untrusted@example.test');
    await assert.rejects(
      () => assertGraphReplyRecipient(env, account, 'source-id', 'sender@example.test'),
      /reply_recipient_mismatch/,
    );
    assert.equal(sent, 0);
    await assertGraphReplyRecipient(env, account, 'source-id', 'untrusted@example.test');
    source.replyTo.push({ emailAddress: { address: 'second@example.test' } });
    await assert.rejects(
      () => assertGraphReplyRecipient(env, account, 'source-id', 'untrusted@example.test'),
      /unsupported/,
    );
    source.replyTo = [];
    await assertGraphReplyRecipient(env, account, 'source-id', 'sender@example.test');
    assert.equal(sent, 0);
  } finally { globalThis.fetch = previous; }
});

test('Gmail nested MIME text and attachments are found without executing HTML', async () => {
  const { getMail } = await import('../src/providers.ts');
  const env = { MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 14).toString('base64') } as any;
  const aid = crypto.randomUUID();
  const secret = await encrypt(env, 'account:' + aid + ':gmail', { access_token: 'token' });
  const account = {
    account_id: aid, provider: 'gmail', address: 'owner@example.test', status: 'active',
    credential_ciphertext: secret.ciphertext, credential_key_id: secret.keyId,
    token_expires_at: Math.floor(Date.now() / 1000) + 3600,
  } as any;
  const payload: any = {
    mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: 'Nested mail' }],
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/html', body: { data: Buffer.from('<script>unsafe()</script><b>HTML</b>').toString('base64url') } },
        { mimeType: 'text/plain', body: { data: Buffer.from('Actual nested body').toString('base64url') } },
      ] },
      { mimeType: 'multipart/related', parts: [
        { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'nested-attachment', size: 123 } },
      ] },
    ],
  };
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      assert.equal(String(input), 'https://gmail.googleapis.com/gmail/v1/users/me/messages/nested?format=full');
      return Response.json({ id: 'nested', threadId: 'thread-nested', internalDate: String(Date.now()),
        snippet: 'Only a short excerpt', payload });
    }) as typeof fetch;
    const result = await getMail(env, account, 'nested');
    assert.equal(result.text, 'Actual nested body');
    assert.equal(result.snippet, 'Only a short excerpt');
    assert.deepEqual(result.attachments, [{ id: 'nested-attachment', filename: 'report.pdf', size: 123 }]);
    let root = { mimeType: 'text/plain', body: { data: Buffer.from('too deep').toString('base64url') } } as any;
    for (let i = 0; i < 17; i++) root = { mimeType: 'multipart/mixed', parts: [root] };
    payload.parts = [root];
    await assert.rejects(() => getMail(env, account, 'nested'), /result_too_large/,
      'untrusted deeply nested MIME trees must fail closed');
  } finally { globalThis.fetch = previous; }
});

test('bounded Gmail threads and Graph folders expose truncation metadata', async () => {
  const { listFolders, threadGet } = await import('../src/providers.ts');
  const env = { MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 21).toString('base64') } as any;
  async function account(provider: 'gmail' | 'graph') {
    const accountId = crypto.randomUUID();
    const value = await encrypt(env, 'account:' + accountId + ':' + provider, { access_token: 'token-' + provider });
    return { account_id: accountId, provider, address: 'owner@example.test',
      status: 'active', credential_ciphertext: value.ciphertext,
      credential_key_id: value.keyId, token_expires_at: Math.floor(Date.now() / 1000) + 3600 } as any;
  }
  const gmail = await account('gmail');
  const graph = await account('graph');
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/threads/thread-large?format=full'))
        return Response.json({ messages: Array.from({ length: 31 }, (_, i) =>
          ({ id: String(i), payload: { headers: [] } })) });
      if (url.endsWith('/threads/thread-small?format=full'))
        return Response.json({ messages: [{ id: 'only', payload: { headers: [] } }] });
      if (url.endsWith('/mailFolders?$top=100'))
        return Response.json({ value: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders?$skip=100' });
      throw new Error('unexpected provider request ' + url);
    }) as typeof fetch;
    const longThread = await threadGet(env, gmail, 'thread-large');
    assert.equal(longThread.messages.length, 30);
    assert.equal(longThread.truncated, true);
    assert.equal(longThread.consistent_snapshot, false);
    const shortThread = await threadGet(env, gmail, 'thread-small');
    assert.equal(shortThread.messages.length, 1);
    assert.equal(shortThread.truncated, false);
    const folders = await listFolders(env, graph) as any;
    assert.equal(folders.folders.length, 100);
    assert.equal(folders.truncated, true, 'Graph nextLink must be disclosed, not discarded silently');
  } finally { globalThis.fetch = oldFetch; }
});

test('failed first-page mailbox can resume without replaying completed account', async () => {
  const { searchAcross } = await import('../src/tools.ts');
  const key = Buffer.alloc(32, 22).toString('base64');
  const env = { MAIL_ENCRYPTION_KEY: key, DB: {} } as any;
  const failedId = crypto.randomUUID(), healthyId = crypto.randomUUID();
  const accounts = new Map<string, any>();
  for (const [aid, token] of [[failedId, 'fragile'], [healthyId, 'healthy']]) {
    const sealed = await encrypt(env, 'account:' + aid + ':graph', { access_token: token });
    accounts.set(aid, { account_id: aid, provider: 'graph', address: token + '@example.test',
      status: 'active', credential_ciphertext: sealed.ciphertext,
      credential_key_id: sealed.keyId, token_expires_at: Math.floor(Date.now() / 1000) + 3600 });
  }
  env.DB = { prepare(sql: string) {
    assert.equal(sql, 'SELECT * FROM mail_accounts WHERE account_id=?');
    return { bind(aid: string) { return { async first() { return accounts.get(aid) ?? null; } }; } };
  } };
  const oldFetch = globalThis.fetch;
  const seen: string[] = [];
  let failFragile = true;
  try {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization');
      seen.push(token ?? '');
      if (token === 'Bearer fragile' && failFragile)
        return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ value: [{ id: token === 'Bearer fragile' ? 'recovered' : 'healthy',
        receivedDateTime: '2026-10-25T00:00:00Z' }] });
    }) as typeof fetch;
    const first = await searchAcross(env, [failedId, healthyId], 'bounded', undefined);
    assert.equal(first.partial_failure, true);
    assert.deepEqual(first.messages.map((m: any) => m.id), ['healthy']);
    assert.equal(typeof first.cursor, 'string', 'first-page failure must be resumable');
    failFragile = false;
    const second = await searchAcross(env, [failedId, healthyId], 'bounded', first.cursor);
    assert.equal(second.partial_failure, false);
    assert.deepEqual(second.messages.map((m: any) => m.id), ['recovered']);
    assert.equal(second.cursor, undefined);
    assert.equal(seen.filter(v => v === 'Bearer healthy').length, 1,
      'already completed mailbox must not be replayed');
    failFragile = true;
    const solo = await searchAcross(env, [failedId], 'solo', undefined);
    assert.equal(solo.partial_failure, true);
    assert.equal(typeof solo.cursor, 'string', 'even an all-failed search must have a retry cursor');
    failFragile = false;
    const recovered = await searchAcross(env, [failedId], 'solo', solo.cursor);
    assert.equal(recovered.messages[0]?.id, 'recovered');
    assert.equal(recovered.cursor, undefined);
  } finally { globalThis.fetch = oldFetch; }
});

test('Graph mail text falls back to preview without exposing HTML', async () => {
  const { getMail, searchMail } = await import('../src/providers.ts');
  const env = { MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 23).toString('base64') } as any;
  const aid = crypto.randomUUID();
  const sealed = await encrypt(env, 'account:' + aid + ':graph', { access_token: 'graph-token' });
  const account = { account_id: aid, provider: 'graph', address: 'owner@example.test',
    status: 'active', credential_ciphertext: sealed.ciphertext, credential_key_id: sealed.keyId,
    token_expires_at: Math.floor(Date.now() / 1000) + 3600 } as any;
  const previous = globalThis.fetch;
  let requestedBody: any = {};
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1.0/me/messages')
        return Response.json({ value: [{ id: 'search-only', bodyPreview: 'Plain search preview',
          receivedDateTime: '2026-10-25T00:00:00Z' }] });
      if (url.pathname === '/v1.0/me/messages/source/attachments') return Response.json({ value: [] });
      assert.equal(url.pathname, '/v1.0/me/messages/source');
      return Response.json({ id: 'source', bodyPreview: 'Safe preview', ...requestedBody });
    }) as typeof fetch;
    const searched = await searchMail(env, account, 'example');
    assert.equal(searched.messages[0].text, 'Plain search preview',
      'search results do not request full Graph message body');
    requestedBody = { body: { contentType: 'html', content: '<img src="https://tracker.example/x"><script>bad()</script>' } };
    const html = await getMail(env, account, 'source');
    assert.equal(html.text, 'Safe preview', 'HTML body is not rendered or executed');
    requestedBody = { body: { contentType: 'Text', content: 'Full plain text' } };
    const plain = await getMail(env, account, 'source');
    assert.equal(plain.text, 'Full plain text');
    requestedBody = {};
    const missing = await getMail(env, account, 'source');
    assert.equal(missing.text, 'Safe preview');
  } finally { globalThis.fetch = previous; }
});

test('Graph mail_get discovers bounded attachment IDs including inline-only attachments', async () => {
  const { getMail, attachmentGet } = await import('../src/providers.ts');
  const env = { MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 24).toString('base64') } as any;
  const accountId = crypto.randomUUID();
  const sealed = await encrypt(env, 'account:' + accountId + ':graph', { access_token: 'graph-token' });
  const account = { account_id: accountId, provider: 'graph', address: 'owner@example.test',
    status: 'active', credential_ciphertext: sealed.ciphertext, credential_key_id: sealed.keyId,
    token_expires_at: Math.floor(Date.now() / 1000) + 3600 } as any;
  const originalFetch = globalThis.fetch;
  let many = false, metadataCalls = 0;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://graph.microsoft.com');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer graph-token');
      if (url.pathname === '/v1.0/me/messages/msg') {
        return Response.json({ id: 'msg', bodyPreview: 'Safe message', hasAttachments: false });
      }
      if (url.pathname === '/v1.0/me/messages/msg/attachments') {
        metadataCalls++;
        assert.equal(url.searchParams.get('$top'), '20');
        assert.equal(url.searchParams.get('$select'), 'id,name,size,isInline');
        const value = many ? Array.from({ length: 20 }, (_, i) =>
          ({ id: 'part-' + i, name: 'item-' + i + '.txt', size: i + 1 })) :
          [{ id: 'inline-1', name: 'inline.png', size: 3, isInline: true }];
        return Response.json(many
          ? { value, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages/msg/attachments?$skip=20' }
          : { value });
      }
      if (url.pathname === '/v1.0/me/messages/msg/attachments/inline-1') {
        return Response.json({ size: 3, contentBytes: Buffer.from('abc').toString('base64') });
      }
      throw new Error('unexpected Graph request ' + url);
    }) as typeof fetch;
    const inline = await getMail(env, account, 'msg');
    assert.deepEqual(inline.attachments, [{ id: 'inline-1', filename: 'inline.png', size: 3 }]);
    assert.equal(inline.attachments_truncated, false);
    const bytes = await attachmentGet(env, account, 'msg', inline.attachments[0].id);
    assert.equal(Buffer.from(bytes.data_base64, 'base64').toString(), 'abc');
    many = true;
    const page = await getMail(env, account, 'msg');
    assert.equal(page.attachments.length, 20);
    assert.equal(page.attachments_truncated, true);
    assert.equal(metadataCalls, 2);
  } finally { globalThis.fetch = originalFetch; }
});
