import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeImapReference, decodeImapReference, validateProtocolCredentials } from '../src/imap.ts';
import { resolvePublicMailEndpoint } from '../src/mail-endpoints.ts';
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
test('DNS resolution pins only verified public IPs, never the attacker-controlled hostname', async () => {
  const dns = (async (uri: string) => Response.json({
    Status: 0,
    Answer: new URL(uri).searchParams.get('type') === '1' ? [{ type: 1, data: '1.1.1.1' }] : [],
  })) as typeof fetch;
  assert.deepEqual(await resolvePublicMailEndpoint('IMAP.QQ.COM', dns),
    { hostname: 'imap.qq.com', address: '1.1.1.1' });
  const unsafe = (async () => Response.json({ Status: 0, Answer: [{ type: 1, data: '192.168.1.9' }] })) as typeof fetch;
  await assert.rejects(() => resolvePublicMailEndpoint('imap.qq.com', unsafe), /unsafe_mail_host/);
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
