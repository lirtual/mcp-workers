import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeImapReference, decodeImapReference, validateProtocolCredentials, requiresEnvelopeSearch, matchesEnvelopeQuery } from '../src/imap.ts';
import { publicIp, resolvePublicMailEndpoint } from '../src/mail-endpoints.ts';
test('IMAP reference binds mailbox, UIDVALIDITY and UID including Unicode folder', () => {
  const ref = { folder: '收件箱', uidvalidity: '92102026', uid: 1234 };
  const opaque = encodeImapReference(ref);
  assert.deepEqual(decodeImapReference(opaque), ref);
  for (const bad of ['', 'not-valid?', 'a'.repeat(751),
    encodeImapReference({ folder: 'INBOX', uidvalidity: '0', uid: 5 }),
    encodeImapReference({ folder: 'INBOX\r\n', uidvalidity: '22', uid: 5 }),
    encodeImapReference({ folder: 'INBOX', uidvalidity: '22', uid: -1 })]) {
    assert.throws(() => decodeImapReference(bad), /stale_reference/);
  }
});
test('generic mailbox credentials and ports reject control characters/insecure configurations', () => {
  const good = { imap_host: 'imap.qq.com', imap_port: 993 as const,
    smtp_host: 'smtp.qq.com', smtp_port: 465 as const,
    username: 'owner@qq.com', password: 'sample-app-password' };
  assert.deepEqual(validateProtocolCredentials({ ...good }), good);
  assert.throws(() => validateProtocolCredentials({ ...good, imap_host: 'localhost' }), /invalid_mail_host/);
  assert.throws(() => validateProtocolCredentials({ ...good, smtp_port: 25 as 465 }), /unsupported_mail_port/);
  assert.throws(() => validateProtocolCredentials({ ...good, password: 'abc\nbcc' }), /invalid_mail_credential/);
});
test('mail endpoint IPv4 filter rejects IANA reserved ranges without blocking unrelated /16s', async () => {
  for (const address of [
    '0.1.2.3', '10.0.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255',
  ]) assert.equal(publicIp(address), false, address + ' must be rejected');
  for (const address of ['1.1.1.1', '8.8.8.8', '192.0.1.1', '198.20.0.1']) {
    assert.equal(publicIp(address), true, address + ' is not within those reserved ranges');
  }
  const documentationDns = (async () => Response.json({
    Status: 0, Answer: [{ type: 1, data: '192.0.2.44' }],
  })) as typeof fetch;
  await assert.rejects(
    () => resolvePublicMailEndpoint('mail.example.org', documentationDns),
    /unsafe_mail_host/,
  );
});

test('DNS precheck returns only public IPs and rejects unsafe hostname results', async () => {
  const dns = (async (uri: string, init?: RequestInit) => {
    assert.equal(init?.redirect, 'manual', 'Workerd does not support redirect:error');
    return Response.json({
      Status: 0,
      Answer: new URL(uri).searchParams.get('type') === '1' ? [{ type: 1, data: '1.1.1.1' }] : [],
    });
  }) as typeof fetch;
  assert.deepEqual(await resolvePublicMailEndpoint('IMAP.QQ.COM', dns),
    { hostname: 'imap.qq.com', address: '1.1.1.1' });
  const unsafe = (async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '192.168.1.9' }] })) as typeof fetch;
  await assert.rejects(() => resolvePublicMailEndpoint('imap.qq.com', unsafe), /unsafe_mail_host/);
  const redirected = (async (_uri: string, init?: RequestInit) => {
    assert.equal(init?.redirect, 'manual');
    return Response.redirect('https://attacker.example.test/dns-query', 302);
  }) as typeof fetch;
  await assert.rejects(() => resolvePublicMailEndpoint('imap.qq.com', redirected), /dns_unavailable/,
    'Cloudflare-compatible manual redirects must not follow arbitrary DNS destinations');
});
test('IMAP replies require a caller-confirmed Reply-To and a valid RFC message identity', async () => {
  const { imapReplyHeaders } = await import('../src/imap.ts');
  const original = {
    from: { address: 'sender@example.test' },
    replyTo: [{ address: 'reply@example.test' }],
    subject: 'Quarterly update',
    messageId: '<original123@example.test>',
    references: '<previous@example.test>',
  };
  const relation = imapReplyHeaders(original, 'reply@example.test');
  assert.deepEqual(relation.to, ['reply@example.test']);
  assert.equal(relation.subject, 'Re: Quarterly update');
  assert.equal(relation.inReplyTo, '<original123@example.test>');
  assert.equal(relation.references, '<previous@example.test> <original123@example.test>');
  assert.throws(() => imapReplyHeaders(original, 'attacker@example.test'), /reply_recipient_mismatch/);
  assert.throws(() => imapReplyHeaders({
    ...original, replyTo: [{ address: 'reply@example.test' }, { address: 'other@example.test' }],
  }, 'reply@example.test'), /unsupported/, 'must not silently ignore a second Reply-To target');
  assert.throws(() => imapReplyHeaders({ ...original, replyTo: [{ address: 'reply@example.test' }, {}] },
    'reply@example.test'), /unsupported/, 'malformed multi-target Reply-To must fail closed');
  const fallback = imapReplyHeaders({ ...original, replyTo: [] }, 'sender@example.test');
  assert.deepEqual(fallback.to, ['sender@example.test']);
  assert.throws(() => imapReplyHeaders({ ...original, messageId: 'bad\r\nBcc:someone@example.test' },
    'reply@example.test'), /unsupported/);
  assert.throws(() => imapReplyHeaders({ from: { address: 'sender@example.test' } },
    'sender@example.test'), /unsupported/);
});

test('IMAP trash prefers special-use designation even for localized folder names', async () => {
  const { findImapTrash } = await import('../src/imap.ts');
  assert.equal(findImapTrash([
    { path: 'Trash' },
    { path: '已删除邮件', specialUse: '\\Trash' },
  ])?.path, '已删除邮件');
  assert.equal(findImapTrash([{ path: 'Deleted Items' }])?.path, 'Deleted Items');
  assert.equal(findImapTrash([{ path: 'Archive', specialUse: '\\Archive' }]), undefined);
});

test('IMAP/SMTP DNS precheck rejects the entire IANA protocol-assignments block', () => {
  for (const ip of ['192.0.0.0', '192.0.0.2', '192.0.0.9', '192.0.0.10', '192.0.0.170', '192.0.0.255']) {
    assert.equal(publicIp(ip), false, ip);
  }
  assert.equal(publicIp('1.1.1.1'), true);
  assert.equal(publicIp('8.8.8.8'), true);
});

test('generic credential setup rejects native Google/Microsoft hosts and retains other mail hosts', async () => {
  const { validateProtocolCredentials } = await import('../src/imap.ts');
  const config = { imap_host: 'imap.qq.com', imap_port: 993 as const,
    smtp_host: 'smtp.qq.com', smtp_port: 465 as const,
    username: 'owner@qq.com', password: 'app-password' };
  assert.equal(validateProtocolCredentials({ ...config }).imap_host, 'imap.qq.com');
  for (const host of ['imap.gmail.com', 'outlook.office365.com', 'imap-mail.outlook.com']) {
    assert.throws(() => validateProtocolCredentials({ ...config, imap_host: host }), /unsupported_provider/);
  }
  for (const host of ['smtp.gmail.com', 'smtp.office365.com', 'smtp-mail.outlook.com']) {
    assert.throws(() => validateProtocolCredentials({ ...config, smtp_host: host }), /unsupported_provider/);
  }
});

test('QQ/163/126 use bounded header search; unrelated text and body-only tokens cannot match', () => {
  for (const host of ['imap.qq.com', 'IMAP.163.COM', 'imap.126.com']) {
    assert.equal(requiresEnvelopeSearch(host), true, host);
  }
  assert.equal(requiresEnvelopeSearch('imap.example.org'), false);
  const envelope = {
    subject: '季度 报告',
    from: [{ name: 'Alice Example', address: 'alice@example.org' }],
    to: [{ name: '研发', address: 'owner@qq.com' }],
    cc: [{ address: 'team@example.org' }],
  };
  for (const query of ['季度', '报告', 'ALICE', 'owner@QQ.COM', 'TEAM@EXAMPLE.ORG']) {
    assert.equal(matchesEnvelopeQuery(envelope, query), true, query);
  }
  for (const query of ['mcp-readonly-health-0123456789abcdef0123456789abcdef', 'body-only-secret', 'nobody@other.example']) {
    assert.equal(matchesEnvelopeQuery(envelope, query), false, query);
  }
  assert.equal(matchesEnvelopeQuery({ subject: 'HELLO', from: [{ address: 'x@y.test' }] }, 'hello'), true);
  assert.equal(matchesEnvelopeQuery(null, 'hello'), false);
  assert.equal(matchesEnvelopeQuery({}, 'hello'), false);
  assert.equal(matchesEnvelopeQuery({ subject: 123, from: [null, {}, 'bad'] }, 'hello'), false);
});
