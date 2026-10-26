import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttachments, validateAttachmentInputs } from '../src/attachments.ts';

test('IMAP/SMTP attachments accept only validated inline data and stable mailbox IDs', async () => {
  const input = [{ type: 'inline' as const, filename: 'note.txt',
    data_base64: Buffer.from('hello').toString('base64'), mime_type: 'text/plain' }];
  const files = await resolveAttachments(input, async () => { throw new Error('unexpected lookup'); });
  assert.equal(new TextDecoder().decode(files[0]!.data), 'hello');
  await assert.rejects(() => resolveAttachments([
    { type: 'mailbox', filename: 'source.txt', message_id: 'uid-ref', attachment_id: '0' },
  ], async (id, attachment) => {
    assert.equal(id, 'uid-ref');
    assert.equal(attachment, '0');
    return { data_base64: Buffer.from('from-mailbox').toString('base64'), size: 11 };
  }), /invalid_attachment/);
  const source = await resolveAttachments([
    { type: 'mailbox', filename: 'source.txt', message_id: 'uid-ref', attachment_id: '0' },
  ], async () => ({ data_base64: Buffer.from('from-mailbox').toString('base64'), size: 12 }));
  assert.equal(source.length, 1);
  assert.equal(new TextDecoder().decode(source[0]!.data), 'from-mailbox');
});

test('attachments reject invalid headers, noncanonical encoding and oversized content', async () => {
  assert.throws(() => validateAttachmentInputs([
    { type: 'inline', filename: '../unsafe', data_base64: 'YQ==' },
  ]), /invalid_attachment_name/);
  assert.throws(() => validateAttachmentInputs([
    { type: 'inline', filename: 'safe.txt', data_base64: 'not_base64!' },
  ]), /invalid_attachment/);
  assert.throws(() => validateAttachmentInputs([
    { type: 'inline', filename: 'safe.txt', data_base64: 'QQ==', mime_type: 'text/plain\r\nBcc: x' },
  ]), /invalid_attachment/);
  const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => validateAttachmentInputs([
    { type: 'inline', filename: 'big.dat', data_base64: big },
  ]), /oversized_attachment/);
});
