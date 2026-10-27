import assert from 'node:assert/strict';
import test from 'node:test';
import { createIlinkClient, IlinkError, bindVerifiedContext, createOwnershipProof } from './protocol.mjs';

const knownProof = 'WX346-A1B2C3D4E5F60718293A4B5C';
const account = { botToken: 'secret-test-token', scannedUserId: 'owner-A', botId: 'bot-A' };
function mock(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
test('mock iLink QR -> verified owner inbound -> text send; upstream acceptance is not delivery', async () => {
  const fake = mock([
    { qrcode: 'QR-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/qr/mock' },
    { status: 'confirmed', bot_token: account.botToken, ilink_bot_id: account.botId, ilink_user_id: account.scannedUserId },
    { ret: 0, get_updates_buf: 'cursor-secret', msgs: [
      { from_user_id: 'owner-A', to_user_id: 'bot-A', message_type: 1, context_token: 'ctx-private', item_list: [{ type: 1, text_item: { text: knownProof } }] }
    ] },
    { ret: 0 }
  ]);
  const api = createIlinkClient({ fetchImpl: fake.fetchImpl });
  const qr = await api.getQr();
  const scanned = await api.pollQr(qr.qrcode);
  assert.equal(scanned.status, 'confirmed');
  assert.equal(scanned.ilink_user_id, 'owner-A');
  const updates = await api.getUpdates(account.botToken, '');
  const verified = bindVerifiedContext(scanned, updates, account.botId, knownProof);
  assert.equal(verified.recipientId, 'owner-A');
  const result = await api.sendText({
    botToken: account.botToken, recipientId: verified.recipientId,
    contextToken: verified.contextToken, requestId: 'd6d361d3-39cf-45a2-b2f0-cccb4e0b61ba',
    text: 'https://example.org/hello'
  });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(fake.calls.map(c => new URL(c.url).pathname), [
    '/ilink/bot/get_bot_qrcode','/ilink/bot/get_qrcode_status','/ilink/bot/getupdates','/ilink/bot/sendmessage'
  ]);
  assert.equal(fake.calls[2].init.headers.Authorization, 'Bearer secret-test-token');
  const outgoing = JSON.parse(fake.calls[3].init.body);
  assert.equal(outgoing.msg.to_user_id, 'owner-A');
  assert.equal(outgoing.msg.context_token, 'ctx-private');
  assert.equal(outgoing.msg.item_list[0].text_item.text, 'https://example.org/hello');
  assert.equal(outgoing.msg.client_id, 'd6d361d3-39cf-45a2-b2f0-cccb4e0b61ba');
  assert.equal(outgoing.msg.message_type, 2);
  assert.equal(outgoing.msg.message_state, 2);
  assert.equal(outgoing.msg.from_user_id, '');
});
test('does not activate binding from another sender, a group, or missing context', () => {
  const scanned = { status: 'confirmed', ilink_user_id: 'owner-A' };
  for (const message of [
    { from_user_id: 'attacker', context_token: 'ctx' },
    { from_user_id: 'owner-A', context_token: 'ctx', group_id: 'group' },
    { from_user_id: 'owner-A', context_token: '' }
  ]) {
    assert.throws(() => bindVerifiedContext(scanned, { msgs: [message] }, 'bot-A', knownProof), e => e instanceof IlinkError && e.code === 'IDENTITY_UNVERIFIED');
  }
});
test('fails closed on hostile protocol hosts, redirects, oversized and malformed replies', async () => {
  assert.throws(() => createIlinkClient({ apiOrigin: 'http://localhost:1234' }), /not allowed/);
  assert.throws(() => createIlinkClient({ apiOrigin: 'https://evil.example' }), /not allowed/);
  let attempts = 0;
  const api = createIlinkClient({ fetchImpl: async () => {
    attempts++;
    return Response.redirect('https://evil.example/steal', 302);
  } });
  await assert.rejects(() => api.getQr(), e => e instanceof IlinkError && e.code === 'UNSAFE_REDIRECT');
  assert.equal(attempts, 1);
  const oversized = createIlinkClient({ fetchImpl: async () =>
    new Response('x'.repeat(70000), { status: 200 }) });
  await assert.rejects(() => oversized.getQr(), e => e instanceof IlinkError && e.code === 'INVALID_RESPONSE');
  const malformed = createIlinkClient({ fetchImpl: async () => new Response('{not json', { status: 200 }) });
  await assert.rejects(() => malformed.getQr(), e => e instanceof IlinkError && e.code === 'INVALID_RESPONSE');
});
test('blocked unverified context and invalid input never dispatch', async () => {
  const fake = mock([{ ret: 0 }]);
  const api = createIlinkClient({ fetchImpl: fake.fetchImpl });
  const base = { botToken: 'token', recipientId: 'owner', contextToken: '', requestId: 'd6d361d3-39cf-45a2-b2f0-cccb4e0b61ba', text: 'Hi' };
  for (const patch of [{}, { contextToken: 'ctx', text: '  ' }, { contextToken: 'ctx', text: '😊'.repeat(1500) },
    { contextToken: 'ctx', requestId: 'invalid' }, { contextToken: 'ctx', recipientId: '' }]) {
    await assert.rejects(() => api.sendText({ ...base, ...patch }), e => e instanceof IlinkError && e.code === 'INVALID_INPUT');
  }
  assert.equal(fake.calls.length, 0);
});
test('nonzero ret rejected; uncertain transport is unknown and never auto-retried', async () => {
  const input = { botToken: 't', recipientId: 'owner', contextToken: 'ctx', requestId: 'd6d361d3-39cf-45a2-b2f0-cccb4e0b61ba', text: 'Hi' };
  const failing = mock([{ ret: -14 }]);
  await assert.rejects(() => createIlinkClient({ fetchImpl: failing.fetchImpl }).sendText(input), e => e instanceof IlinkError && e.code === 'UPSTREAM_REJECTED');
  assert.equal(failing.calls.length, 1);
  const timedOut = mock([new Error('secrets should not leak')]);
  await assert.rejects(() => createIlinkClient({ fetchImpl: timedOut.fetchImpl }).sendText(input),
    e => e instanceof IlinkError && e.code === 'UNKNOWN_SEND' && !e.message.includes('secrets'));
  assert.equal(timedOut.calls.length, 1);
});

test('getUpdates -14 marks stale session and never attempts a second poll', async () => {
  const fake = mock([{ ret: -14, msgs: [], get_updates_buf: '' }]);
  await assert.rejects(() => createIlinkClient({ fetchImpl: fake.fetchImpl }).getUpdates('token', ''),
    e => e instanceof IlinkError && e.code === 'STALE_SESSION');
  assert.equal(fake.calls.length, 1);
});
test('QR redirected sessions and server-supplied alternative baseurls are not silently trusted', async () => {
  const fake = mock([
    { status: 'scaned_but_redirect', redirect_host: 'evil.example' },
    { status: 'confirmed', bot_token: 'bot-secret', ilink_bot_id: 'bot', ilink_user_id: 'owner', baseurl: 'https://evil.example' }
  ]);
  const api = createIlinkClient({ fetchImpl: fake.fetchImpl });
  await assert.rejects(() => api.pollQr('qr'), e => e instanceof IlinkError && e.code === 'UNSAFE_REDIRECT');
  await assert.rejects(() => api.pollQr('qr'), e => e instanceof IlinkError && e.code === 'INVALID_RESPONSE');
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) assert.equal(new URL(call.url).origin, 'https://ilinkai.weixin.qq.com');
});

test('a redirected or throttled write is uncertain after dispatch, never auto-followed or replayed', async () => {
  const input = { botToken: 't', recipientId: 'owner', contextToken: 'ctx',
    requestId: 'd6d361d3-39cf-45a2-b2f0-cccb4e0b61ba', text: 'write once' };
  for (const response of [
    Response.redirect('https://evil.example/receive', 302),
    new Response(JSON.stringify({ ret: 429 }), { status: 429 })
  ]) {
    let count = 0;
    const api = createIlinkClient({ fetchImpl: async (_url, init) => {
      count++;
      assert.equal(init.redirect, 'manual');
      return response;
    } });
    await assert.rejects(() => api.sendText(input), e => e instanceof IlinkError && e.code === 'UNKNOWN_SEND');
    assert.equal(count, 1);
  }
});

test('QR owner verification requires a fresh one-time challenge in an inbound user message', () => {
  const proof = createOwnershipProof();
  assert.match(proof, /^WX346-[0-9A-F]{24}$/);
  assert.notEqual(proof, createOwnershipProof());
  const scan = { status: 'confirmed', ilink_user_id: 'owner-A' };
  const message = { from_user_id: 'owner-A', to_user_id: 'bot-A', message_type: 1,
    context_token: 'ctx', item_list: [{ type: 1, text_item: { text: proof } }] };
  assert.deepEqual(bindVerifiedContext(scan, { msgs: [message] }, 'bot-A', proof),
    { recipientId: 'owner-A', contextToken: 'ctx' });
  for (const incorrect of [undefined, '', 'bad', 'WX346-FFFFFFFFFFFFFFFFFFFFFFFF']) {
    assert.throws(() => bindVerifiedContext(scan, { msgs: [message] }, 'bot-A', incorrect),
      e => e instanceof IlinkError && e.code === 'IDENTITY_UNVERIFIED');
  }
  for (const payload of [
    { ...message, message_type: 2 },
    { ...message, group_id: 'group' },
    { ...message, item_list: [{ type: 1, text_item: { text: 'wrong' } }] }
  ]) {
    assert.throws(() => bindVerifiedContext(scan, { msgs: [payload] }, 'bot-A', proof),
      e => e instanceof IlinkError && e.code === 'IDENTITY_UNVERIFIED');
  }
  assert.throws(() => bindVerifiedContext(scan, { msgs: [message, message] }, 'bot-A', proof),
    e => e instanceof IlinkError && e.code === 'IDENTITY_UNVERIFIED');
});

test('refuses non-Weixin or non-HTTPS QR payloads before displaying to owner', async () => {
  const candidates = [
    'https://evil.example/steal',
    'https://liteapp.weixin.qq.com.evil.example/login',
    'http://liteapp.weixin.qq.com/login',
    'https://user:password@liteapp.weixin.qq.com/login',
    'https://liteapp.weixin.qq.com:8443/login',
    'javascript:alert(1)',
    'weixin://unreviewed',
  ];
  for (const qrcode_img_content of candidates) {
    const fake = mock([{ qrcode: 'opaque-token', qrcode_img_content }]);
    await assert.rejects(() => createIlinkClient({ fetchImpl: fake.fetchImpl }).getQr(),
      e => e instanceof IlinkError && e.code === 'UNSAFE_REDIRECT');
    assert.equal(fake.calls.length, 1);
  }
  const good = mock([{ qrcode: 'opaque-token', qrcode_img_content: 'https://liteapp.weixin.qq.com/some-path?opaque=abc' }]);
  assert.equal((await createIlinkClient({ fetchImpl: good.fetchImpl }).getQr()).qrcode, 'opaque-token');
});

test('getUpdates business rejection exposes only bounded numeric status, never errmsg or raw payload', async () => {
  for (const answer of [
    { ret: 1001, errcode: 2002, errmsg: 'SENSITIVE_TOKEN_INTERNAL' },
    { ret: 0, errcode: 2403, errmsg: 'SENSITIVE_TOKEN_INTERNAL' },
    { errcode: 3, errmsg: 'SENSITIVE_TOKEN_INTERNAL' },
    { ret: 'do not expose this', errcode: 0, errmsg: 'SENSITIVE_TOKEN_INTERNAL' },
  ]) {
    const fake = mock([answer]);
    await assert.rejects(() => createIlinkClient({ fetchImpl: fake.fetchImpl }).getUpdates('token', ''),
      e => e instanceof IlinkError && e.code === 'UPSTREAM_REJECTED' &&
        e.diagnostic?.ret === (Number.isSafeInteger(answer.ret) ? answer.ret : null) &&
        e.diagnostic?.errcode === (Number.isSafeInteger(answer.errcode) ? answer.errcode : null) &&
        e.diagnostic?.ret_kind === (answer.ret === undefined ? 'missing' : typeof answer.ret) &&
        e.diagnostic?.errcode_kind === (answer.errcode === undefined ? 'missing' : typeof answer.errcode) &&
        !JSON.stringify({message:e.message,diagnostic:e.diagnostic}).includes('SENSITIVE_TOKEN_INTERNAL'));
    assert.equal(fake.calls.length, 1, 'never silently repeat polling');
  }
});

test('getUpdates permits absent status only for a fully valid message/cursor envelope', async () => {
  const accepted = [
    { msgs: [], get_updates_buf: 'opaque-cursor' },
    { msgs: [], get_updates_buf: '', errcode: 0 },
    { msgs: [], get_updates_buf: '', ret: 0 },
  ];
  for (const envelope of accepted) {
    const fake = mock([envelope]);
    assert.deepEqual(
      await createIlinkClient({ fetchImpl: fake.fetchImpl }).getUpdates('token',''),
      envelope,
    );
    assert.equal(fake.calls.length, 1);
  }
  for (const envelope of [
    {},
    { errmsg:'private upstream message' },
    { msgs: [] },
    { get_updates_buf:'' },
    { msgs:[], get_updates_buf:'', errmsg:'upstream private failure' },
    { msgs:[], get_updates_buf:'', ret:'0' },
    { msgs:[], get_updates_buf:'', ret:-3 },
    { msgs:[], get_updates_buf:'', errcode:-3 },
  ]) {
    const fake = mock([envelope]);
    await assert.rejects(
      () => createIlinkClient({ fetchImpl: fake.fetchImpl }).getUpdates('token',''),
      error => error instanceof IlinkError &&
        ['INVALID_RESPONSE', 'UPSTREAM_REJECTED'].includes(error.code) &&
        !error.message.includes('private') &&
        !JSON.stringify(error.diagnostic ?? '').includes('private'),
    );
    assert.equal(fake.calls.length, 1);
  }
});

test('sendText treats an absent or malformed business receipt as unknown, never rejected or auto-retried', async () => {
  const input = { botToken: 't', recipientId: 'owner', contextToken: 'ctx',
    requestId: 'd6d361d3-39cf-45a2-b2f0-cccb4e0b61ba', text: 'one controlled text' };
  for (const reply of [
    {}, { errcode: 0 }, { errmsg: 'delivered eventually but no ret' },
    { ret: null }, { ret: '0' }, { ret: 0, errcode: null },
  ]) {
    const fake = mock([reply]);
    await assert.rejects(
      () => createIlinkClient({ fetchImpl: fake.fetchImpl }).sendText(input),
      err => err instanceof IlinkError && err.code === 'UNKNOWN_SEND' &&
        err.message === 'UNKNOWN_SEND',
    );
    assert.equal(fake.calls.length, 1, 'unknown is final; do not retry a write');
  }
  for (const reply of [{ ret: -3 }, { ret: 0, errcode: 3 }, { errcode: 3 }]) {
    const fake = mock([reply]);
    await assert.rejects(
      () => createIlinkClient({ fetchImpl: fake.fetchImpl }).sendText(input),
      err => err instanceof IlinkError && err.code === 'UPSTREAM_REJECTED',
    );
    assert.equal(fake.calls.length, 1);
  }
  for (const reply of [{ ret: 0 }, { ret: 0, errcode: 0 }]) {
    const fake = mock([reply]);
    assert.deepEqual(
      await createIlinkClient({ fetchImpl: fake.fetchImpl }).sendText(input),
      { status: 'accepted' }, 'only an explicit success is API-accepted',
    );
    assert.equal(fake.calls.length, 1);
  }
});
