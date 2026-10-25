import test from 'node:test';
import assert from 'node:assert/strict';
import { encrypt } from '../src/crypto.ts';
import { resolveAttachments, validateAttachmentInputs, validateGraphUploadUrl } from '../src/attachments.ts';
import { sendMail } from '../src/providers.ts';

test('bounded attachments reject forged base64, header injection, arbitrary URLs and oversize data', async () => {
  assert.throws(() => validateAttachmentInputs([{ type: 'inline', filename: 'x\r\nBad: yes', data_base64: 'QQ==' }]), /invalid_attachment_name/);
  assert.throws(() => validateAttachmentInputs([{ type: 'inline', filename: 'safe.txt', data_base64: 'QQ' }]), /invalid_attachment/);
  assert.throws(() => validateAttachmentInputs([{ type: 'inline', filename: 'safe.txt', data_base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }]), /oversized_attachment/);
  const files = await resolveAttachments([
    { type:'inline', filename:'first.txt', data_base64: Buffer.from('hello').toString('base64') },
    { type:'mailbox', filename:'second.txt', message_id:'msg', attachment_id:'part' },
  ], async (message, part) => {
    assert.equal(message, 'msg');
    assert.equal(part, 'part');
    return { data_base64url: Buffer.from('world').toString('base64url'), size: 5 };
  });
  assert.deepEqual(files.map(f => Buffer.from(f.data).toString()), ['hello', 'world']);
  for (const url of [
    'https://evil.example/api/v1.0/Users/u/AttachmentSessions(a)?authtoken=evil',
    'http://outlook.office.com/api/v1.0/Users/u/AttachmentSessions(a)?authtoken=x',
    'https://outlook.office.com.evil.example/api/v1.0/Users/u/AttachmentSessions(a)?authtoken=x',
    'https://outlook.office.com/api/v1.0/Users/u/AttachmentSessions(a)?auth=missing',
  ]) assert.throws(() => validateGraphUploadUrl(url), /invalid_upload_url/);
});
async function account(provider: 'gmail' | 'graph') {
  const env = { MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') } as any;
  const aid = crypto.randomUUID();
  const encrypted = await encrypt(env, 'account:' + aid + ':' + provider, { access_token: 'account-oauth-token' });
  return {
    env,
    mailbox: {
      account_id: aid, provider, address: 'sender@example.test', status: 'active',
      credential_ciphertext: encrypted.ciphertext, credential_key_id: encrypted.keyId,
      token_expires_at: Math.floor(Date.now() / 1000) + 3600,
    } as any,
  };
}
test('Gmail multipart mail_send includes named attachments and safely encoded body', async () => {
  const {env, mailbox} = await account('gmail');
  const original = globalThis.fetch;
  let sent = '';
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(url), 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer account-oauth-token');
      const request = JSON.parse(String(init?.body));
      sent = Buffer.from(request.raw, 'base64url').toString();
      return Response.json({ id: 'g123' });
    }) as typeof fetch;
    const result = await sendMail(env, mailbox, ['recipient@example.test'], 'Att', 'Hello', [
      { type:'inline', filename:'note.txt', data_base64: Buffer.from('attached').toString('base64') },
    ]);
    assert.equal(result.status, 'submitted');
    assert.match(sent, /multipart\/mixed/);
    assert.match(sent, /filename="note.txt"/);
    assert.match(sent, /YXR0YWNoZWQ=/);
    assert.match(sent, /SGVsbG8=/);
  } finally { globalThis.fetch = original; }
});
test('Graph large file uses only trusted session URL and never sends OAuth bearer to PUT', async () => {
  const { env, mailbox } = await account('graph');
  const original = globalThis.fetch;
  const upload = "https://outlook.office.com/api/v1.0/Users('u')/Messages('m')/AttachmentSessions('a')?authtoken=trusted";
  const big = Buffer.alloc(3_800_000, 7);
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  let sent = false;
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url), method = init?.method ?? 'GET';
      calls.push({ url: target, method, headers: new Headers(init?.headers) });
      assert.equal(init?.redirect, 'error');
      if (target === 'https://graph.microsoft.com/v1.0/me/messages' && method === 'POST')
        return Response.json({ id: 'draft123' });
      if (target.endsWith('/attachments/createUploadSession') && method === 'POST')
        return Response.json({ uploadUrl: upload, expirationDateTime: new Date(Date.now() + 600000).toISOString() }, { status: 201 });
      if (target === upload && method === 'PUT') {
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        const range = new Headers(init?.headers).get('content-range') ?? '';
        const isFinal = range.endsWith('-3799999/3800000');
        return new Response(null, { status: isFinal ? 201 : 202 });
      }
      if (target.endsWith('/messages/draft123/send') && method === 'POST') {
        sent = true;
        return new Response(null, { status: 202 });
      }
      throw new Error('unexpected Graph request: ' + target);
    }) as typeof fetch;
    const outcome = await sendMail(env, mailbox, ['recipient@example.test'], 'File', 'Hello', [{
      type:'inline', filename:'large.bin', data_base64: big.toString('base64'),
    }]);
    assert.equal(outcome.status, 'accepted');
    assert.equal(sent, true);
    const uploads = calls.filter(c => c.method === 'PUT');
    assert.equal(uploads.length, 2);
    const firstRange = uploads[0]?.headers.get('content-range') ?? '';
    const firstBytes = Number(firstRange.match(/^bytes 0-(\d+)\//)?.[1]) + 1;
    assert.equal(firstBytes % (320 * 1024), 0, 'Graph non-final fragment size must be 320 KiB aligned');
    assert.ok(firstBytes <= 4_000_000, 'Graph upload fragment must be at most 4 MB');
    assert.equal(uploads[0]?.headers.get('content-range'), 'bytes 0-3276799/3800000', 'first chunk range');
    assert.equal(uploads[1]?.headers.get('content-range'), 'bytes 3276800-3799999/3800000');
    assert.equal(uploads[1]?.headers.get('authorization'), null);
  } finally { globalThis.fetch = original; }
});

test('Graph attachment failure stops before message send', async () => {
  const { env, mailbox } = await account('graph');
  const original = globalThis.fetch;
  let sent = 0;
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/me/messages') && init?.method === 'POST')
        return Response.json({ id: 'draft-stopped' }, { status: 201 });
      if (target.endsWith('/draft-stopped/attachments') && init?.method === 'POST')
        return Response.json({ error: { code: 'quota_exceeded' } }, { status: 413 });
      if (target.endsWith('/draft-stopped/send')) sent++;
      throw new Error('unexpected action ' + target);
    }) as typeof fetch;
    await assert.rejects(() => sendMail(env, mailbox, ['recipient@example.test'], 'Unsafe', 'Hello', [{
      type: 'inline', filename: 'small.txt', data_base64: Buffer.from('payload').toString('base64'),
    }]), /provider_error/);
    assert.equal(sent, 0);
  } finally { globalThis.fetch = original; }
});

test('Graph reply and forward with attachments create native drafts and send only after attachment upload', async () => {
  const { env, mailbox } = await account('graph');
  const { graphReplyForwardWithFiles } = await import('../src/providers.ts');
  const original = globalThis.fetch;
  const calls: string[] = [];
  let n = 0;
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push((init?.method ?? 'GET') + ' ' + path);
      if (path.endsWith('/createReply') || path.endsWith('/createForward')) {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.comment, path.endsWith('/createReply') ? 'Thanks' : 'FYI');
        if (path.endsWith('/createForward')) assert.equal(request.toRecipients[0].emailAddress.address, 'recipient@example.test');
        return Response.json({ id: 'native-draft-' + (++n) }, { status: 201 });
      }
      if (init?.method === 'PATCH') return Response.json({ id: 'native-draft-' + n });
      if (path.endsWith('/attachments')) return Response.json({ id: 'file-' + n }, { status: 201 });
      if (path.endsWith('/send')) return new Response(null, { status: 202 });
      throw new Error('unexpected path ' + path);
    }) as typeof fetch;
    const files = [{ filename: 'attachment.txt', mimeType: 'text/plain', data: new TextEncoder().encode('hello') }];
    const reply = await graphReplyForwardWithFiles(env, mailbox, 'reply', 'original', 'Thanks', files);
    assert.equal(reply.status, 'accepted');
    const forward = await graphReplyForwardWithFiles(env, mailbox, 'forward', 'original', 'FYI', files, ['recipient@example.test']);
    assert.equal(forward.status, 'accepted');
    assert.deepEqual(calls.map(s => s.split('/').slice(-1)[0]), [
      'createReply', 'attachments', 'send',
      'createForward', 'attachments', 'send',
    ]);
  } finally { globalThis.fetch = original; }
});

test('Graph upload session expiry is fail-closed before any upload or final send', async () => {
  const { env, mailbox } = await account('graph');
  const original = globalThis.fetch;
  let uploads = 0, sends = 0;
  try {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/me/messages') && init?.method === 'POST')
        return Response.json({ id: 'draft-expired' }, { status: 201 });
      if (target.endsWith('/createUploadSession')) return Response.json({
        uploadUrl: "https://outlook.office.com/api/v1.0/Users('u')/Messages('m')/AttachmentSessions('a')?authtoken=trusted",
        expirationDateTime: new Date(Date.now() - 5000).toISOString(),
      }, { status: 201 });
      if (init?.method === 'PUT') uploads++;
      if (target.endsWith('/send')) sends++;
      throw new Error('unexpected request');
    }) as typeof fetch;
    await assert.rejects(() => sendMail(env, mailbox, ['recipient@example.test'], 'File', 'Hello', [{
      type: 'inline', filename: 'large.bin', data_base64: Buffer.alloc(3_010_000).toString('base64'),
    }]), /upload_session_expired/);
    assert.equal(uploads, 0);
    assert.equal(sends, 0);
  } finally { globalThis.fetch = original; }
});
