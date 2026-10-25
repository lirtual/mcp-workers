import { accessToken } from './oauth.ts';
import { imapAttachment, imapDraftCreate, imapFolders, imapGet, imapMark, imapMove, imapSearch, imapTrash } from './imap.ts';
import { smtpSend } from './smtp.ts';
import { base64Data, resolveAttachments, validateGraphUploadUrl } from './attachments.ts';
import type { AttachmentInput, AttachmentFile } from './attachments.ts';
import { fail } from './types.ts';
import type { Env, MailAccount } from './types.ts';

type Message = {
  account_id: string; provider: string; id: string; thread_id?: string; reply_to?: string;
  subject: string; from: string; to?: string; date: string; snippet: string;
  text?: string; attachments?: { id: string; filename: string; size: number }[];
};
const enc = encodeURIComponent;
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const graph = 'https://graph.microsoft.com/v1.0/me';
const MAX_RESPONSE = 8 * 1024 * 1024;

export async function providerRequest(
  env: Env, account: MailAccount, path: string, init: RequestInit = {}, requestFetch: typeof fetch = fetch,
): Promise<Response> {
  if (!path.startsWith('/') || path.includes('://')) fail('invalid_request');
  const bearer = await accessToken(env, account, requestFetch);
  const url = (account.provider === 'gmail' ? gmail : graph) + path;
  const resp = await requestFetch(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: 'Bearer ' + bearer, ...init.headers },
  });
  if (resp.status === 401 || resp.status === 403) fail('reauthorization_required');
  if (resp.status === 404) fail('stale_reference');
  if (!resp.ok) fail('provider_error');
  const size = Number(resp.headers.get('content-length') ?? 0);
  if (size > MAX_RESPONSE) fail('result_too_large');
  return resp;
}
async function json(env: Env, account: MailAccount, path: string, init?: RequestInit, requestFetch: typeof fetch = fetch): Promise<any> {
  const resp = await providerRequest(env, account, path, init, requestFetch);
  if (resp.status === 204 || resp.status === 202) return {};
  const text = await resp.text();
  if (text.length > MAX_RESPONSE) fail('result_too_large');
  return text ? JSON.parse(text) : {};
}
function decode(value?: string): string {
  if (!value || value.length > 2 * 1024 * 1024) return '';
  try {
    const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
    return new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0))).slice(0, 40000);
  } catch { return ''; }
}
function plainText(value: string): string {
  // Provider HTML is never returned as active markup; default to text only.
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').slice(0, 40000);
}
function gmailParts(payload: any): any[] {
  // Gmail MessagePart.parts is recursive (e.g. mixed -> alternative -> plain).
  // Bound traversal of untrusted MIME trees, without parsing or executing HTML.
  const result: any[] = [];
  const pending: { part: any; depth: number }[] = [{ part: payload, depth: 0 }];
  while (pending.length) {
    if (result.length >= 128) fail('result_too_large');
    const { part, depth } = pending.pop()!;
    if (!part || typeof part !== 'object') continue;
    result.push(part);
    const children = Array.isArray(part.parts) ? part.parts : [];
    if ((depth >= 16 && children.length) ||
      result.length + pending.length + children.length > 128) fail('result_too_large');
    for (let i = children.length - 1; i >= 0; i--)
      pending.push({ part: children[i], depth: depth + 1 });
  }
  return result;
}
function gmailMessage(account: MailAccount, msg: any): Message {
  const parts = gmailParts(msg.payload);
  const headers = msg.payload?.headers ?? [];
  const h = (name: string): string => (headers.find((x: any) => x.name?.toLowerCase() === name)?.value ?? '').slice(0, 1000);
  const text = parts.find((p: any) => p.mimeType === 'text/plain' && !p.filename &&
    typeof p.body?.data === 'string')?.body?.data;
  const replyAddress = h('reply-to') || h('from');
  const attachments = parts.filter((p: any) => p.filename && p.body?.attachmentId)
    .map((p: any) => ({ id: p.body.attachmentId as string, filename: String(p.filename).slice(0, 200), size: Number(p.body.size) || 0 }));
  return {
    account_id: account.account_id, provider: account.provider, id: String(msg.id ?? ''),
    thread_id: String(msg.threadId ?? ''), subject: h('subject'), from: h('from'), to: h('to'),
    reply_to: (replyAddress.match(/<([^<>]+)>$/)?.[1] ?? replyAddress).slice(0, 320),
    date: new Date(Number(msg.internalDate ?? 0)).toISOString(), snippet: String(msg.snippet ?? '').slice(0, 1000),
    text: text ? decode(text) : String(msg.snippet ?? '').slice(0, 1000), attachments,
  };
}
function graphMessage(account: MailAccount, msg: any): Message {
  const recipients = msg.toRecipients ?? [];
  const body = msg.body?.contentType === 'text' ? msg.body?.content : '';
  return {
    account_id: account.account_id, provider: account.provider, id: String(msg.id ?? ''),
    thread_id: String(msg.conversationId ?? ''), subject: String(msg.subject ?? '').slice(0, 1000),
    from: String(msg.from?.emailAddress?.address ?? ''),
    reply_to: (Array.isArray(msg.replyTo) && msg.replyTo.length ? msg.replyTo : [msg.from])
      .map((r: any) => String(r?.emailAddress?.address ?? '')).filter(Boolean).join(', ').slice(0, 1000),
    to: recipients.map((r: any) => r.emailAddress?.address ?? '').join(', ').slice(0, 2000),
    date: String(msg.receivedDateTime ?? ''), snippet: plainText(String(msg.bodyPreview ?? '')).slice(0, 1000),
    text: plainText(String(body ?? msg.bodyPreview ?? '')),
  };
}
export async function getMail(env: Env, account: MailAccount, id: string): Promise<Message> {
  if (account.provider === 'imap_smtp') return imapGet(env, account, id);
  if (account.provider === 'gmail') {
    const msg = await json(env, account, '/messages/' + enc(id) + '?format=full');
    return gmailMessage(account, msg);
  }
  if (account.provider === 'graph') {
    const msg = await json(env, account, '/messages/' + enc(id) + '?$select=id,conversationId,subject,from,replyTo,toRecipients,receivedDateTime,bodyPreview,body', {
      headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
    });
    return graphMessage(account, msg);
  }
  return fail('unsupported');
}
export async function listFolders(env: Env, account: MailAccount): Promise<unknown> {
  if (account.provider === 'imap_smtp') return imapFolders(env, account);
  if (account.provider === 'gmail') return { account_id: account.account_id, folders: (await json(env, account, '/labels')).labels ?? [] };
  if (account.provider === 'graph') return { account_id: account.account_id, folders: (await json(env, account, '/mailFolders?$top=100')).value ?? [] };
  return fail('unsupported');
}
export function validateGraphNextLink(value: string): string {
  if (value.length > 4096) fail('invalid_cursor');
  const absolute = value.startsWith('/messages?') ? graph + value : value;
  if (!absolute.startsWith('https://graph.microsoft.com/v1.0/me/messages?')) fail('invalid_cursor');
  let parsed: URL;
  try { parsed = new URL(absolute); } catch { return fail('invalid_cursor'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== 'https://graph.microsoft.com' ||
      parsed.pathname !== '/v1.0/me/messages' || parsed.hash || parsed.username || parsed.password ||
      !parsed.searchParams.has('$skip') && !parsed.searchParams.has('$skiptoken')) fail('invalid_cursor');
  return '/messages' + parsed.search;
}

export async function searchMail(env: Env, account: MailAccount, query: string, after?: string, limit = 10) {
  if (account.provider === 'imap_smtp') return imapSearch(env, account, query, after, limit);
  if (account.provider === 'gmail') {
    const params = new URLSearchParams({ q: query, maxResults: String(limit) });
    if (after) params.set('pageToken', after);
    const result = await json(env, account, '/messages?' + params);
    const found = Array.isArray(result.messages) ? result.messages.slice(0, limit) : [];
    const messages = await Promise.all(found.map(async (item: any) => {
      const full = await json(env, account, '/messages/' + enc(String(item.id)) + '?format=metadata');
      return gmailMessage(account, full);
    }));
    return { messages, next: result.nextPageToken as string | undefined };
  }
  if (account.provider === 'graph') {
    const params = new URLSearchParams({
      '$search': '"' + query.replaceAll('"', '') + '"',
      '$top': String(limit),
      '$select': 'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview',
    });
    const path = after ? validateGraphNextLink(after) : '/messages?' + params;
    const result = await json(env, account, path, {
      headers: { Prefer: 'IdType="ImmutableId"' },
    });
    const messages = Array.isArray(result.value) ? result.value.slice(0, limit).map((m: any) => graphMessage(account, m)) : [];
    const next = result['@odata.nextLink'] ? validateGraphNextLink(String(result['@odata.nextLink'])) : undefined;
    return { messages, next };
  }
  return fail('unsupported');
}
function nonHeader(value: string, max: number): string {
  if (value.length > max || /[\r\n\x00-\x1f\x7f]/.test(value)) fail('invalid_mail_header');
  return value;
}
function recipients(value: string[]): string[] {
  if (value.length < 1 || value.length > 20 || value.some(v => !/^[^@\s,<>]{1,100}@[^@\s,<>]{3,200}$/.test(v))) fail('invalid_recipients');
  return value;
}
function utf8B64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let buffer = '';
  for (const b of bytes) buffer += String.fromCharCode(b);
  return btoa(buffer);
}
function encodedSubject(subject: string): string {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of subject) {
    const count = new TextEncoder().encode(character).length;
    if (bytes + count > 40) { chunks.push(current); current = ''; bytes = 0; }
    current += character;
    bytes += count;
  }
  if (current || !chunks.length) chunks.push(current);
  return chunks.map(part => '=?UTF-8?B?' + utf8B64(part) + '?=').join('\r\n ');
}
function mimeMessage(address: string, to: string[], subject: string, body: string,
  extra = '', files: AttachmentFile[] = []): string {
  recipients(to);
  nonHeader(subject, 500);
  if (body.length > 100000) fail('payload_too_large');
  const headers = [
    'From: ' + nonHeader(address, 320),
    'To: ' + to.join(',\r\n '),
    'Subject: ' + encodedSubject(subject),
    'MIME-Version: 1.0',
  ];
  if (extra) headers.push(extra);
  const fold = (value: string) => value.match(/.{1,76}/g)?.join('\r\n') ?? '';
  if (!files.length) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return headers.join('\r\n') + '\r\n\r\n' + fold(utf8B64(body));
  }
  const boundary = 'mail_' + crypto.randomUUID().replaceAll('-', '');
  headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  const parts = [
    '--' + boundary, 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', fold(utf8B64(body)),
  ];
  for (const file of files) {
    parts.push('--' + boundary, 'Content-Type: ' + file.mimeType,
      'Content-Disposition: attachment; filename="' + file.filename + '"',
      'Content-Transfer-Encoding: base64', '', fold(base64Data(file.data)));
  }
  parts.push('--' + boundary + '--', '');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}
async function attached(env: Env, account: MailAccount, input: AttachmentInput[]) {
  return resolveAttachments(input, (message, attachment) =>
    attachmentGet(env, account, message, attachment));
}
export async function graphAddAttachment(
  env: Env, account: MailAccount, draftId: string, file: AttachmentFile,
  sendFetch: typeof fetch = fetch,
): Promise<void> {
  if (account.provider !== 'graph') fail('unsupported');
  if (file.data.length < 3000000) {
    await json(env, account, '/messages/' + enc(draftId) + '/attachments', {
      method: 'POST', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.fileAttachment', name: file.filename,
        contentType: file.mimeType, contentBytes: base64Data(file.data),
      }),
    }, sendFetch);
    return;
  }
  const session = await json(env, account, '/messages/' + enc(draftId) + '/attachments/createUploadSession', {
    method: 'POST', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
    body: JSON.stringify({ AttachmentItem: {
      attachmentType: 'file', name: file.filename, size: file.data.length,
    } }),
  }, sendFetch) as { uploadUrl?: string; expirationDateTime?: string };
  const uploadUrl = validateGraphUploadUrl(session.uploadUrl ?? '');
  const expiry = Date.parse(session.expirationDateTime ?? '');
  if (!Number.isFinite(expiry) || expiry < Date.now() + 15_000) fail('upload_session_expired');
  // Graph upload fragments must align to 320 KiB except for the final range.
  // Each request must also stay below Outlook's 4 MB attachment-session limit.
  const chunkSize = 10 * 320 * 1024;
  for (let start = 0; start < file.data.length; start += chunkSize) {
    const endExclusive = Math.min(file.data.length, start + chunkSize);
    const chunk = new Uint8Array(file.data.slice(start, endExclusive)).buffer;
    const result = await sendFetch(uploadUrl, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/octet-stream',
        'content-length': String(endExclusive - start),
        'content-range': 'bytes ' + start + '-' + (endExclusive - 1) + '/' + file.data.length },
      body: chunk,
    });
    if (!result.ok || (endExclusive < file.data.length && ![200, 202].includes(result.status)) ||
      (endExclusive === file.data.length && ![200, 201].includes(result.status)))
      fail('provider_error');
  }
}
function header(headers: any[], name: string): string {
  const value = headers.find((h: any) => String(h.name ?? '').toLowerCase() === name)?.value ?? '';
  return nonHeader(String(value), 1000);
}
function mailboxAddress(value: string): string {
  const bracketed = value.match(/<([^<>]+)>$/)?.[1];
  return recipients([(bracketed ?? value).trim()])[0]!;
}
function messageId(value: string): string {
  if (!/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(value) || value.length > 250)
    fail('unsupported');
  return value;
}
function gmailRaw(value: string): string {
  return utf8B64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function graphRecipients(to: string[]) {
  return recipients(to).map(address => ({ emailAddress: { address } }));
}
export async function sendMail(env: Env, account: MailAccount, to: string[], subject: string, body: string,
  attachments: AttachmentInput[] = []) {
  const files = await attached(env, account, attachments);
  if (account.provider === 'imap_smtp') return smtpSend(env, account, to, subject, body, files);
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/messages/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: gmailRaw(mimeMessage(account.address, to, subject, body, '', files)) }),
    });
    return { status: 'submitted' as const, reference: String(response.id ?? '') };
  }
  if (account.provider === 'graph' && files.length) {
    const draft = await draftCreate(env, account, to, subject, body);
    if (!draft.id || typeof draft.id !== 'string') fail('provider_error');
    for (const file of files) await graphAddAttachment(env, account, draft.id, file);
    await providerRequest(env, account, '/messages/' + enc(draft.id) + '/send', { method: 'POST' });
    return { status: 'accepted' as const, reference: draft.id };
  }
  if (account.provider === 'graph') {
    await providerRequest(env, account, '/sendMail', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: {
        subject, body: { contentType: 'Text', content: body }, toRecipients: graphRecipients(to),
      }, saveToSentItems: true }),
    });
    return { status: 'accepted' as const, reference: null };
  }
  return fail('unsupported');
}
export async function assertGraphReplyRecipient(env: Env, account: MailAccount, messageId: string, confirmedTo: string): Promise<void> {
  if (account.provider !== 'graph') fail('unsupported');
  const source = await json(env, account, '/messages/' + enc(messageId) + '?$select=replyTo,from', {
    headers: { Prefer: 'IdType="ImmutableId"' },
  });
  const candidates = Array.isArray(source.replyTo) && source.replyTo.length ? source.replyTo : [source.from];
  // Native Graph reply honors Reply-To. Multiple targets cannot be confirmed with a single recipient.
  if (candidates.length !== 1) fail('unsupported');
  const target = candidates[0]?.emailAddress?.address;
  if (typeof target !== 'string' || recipients([target])[0]!.toLowerCase() !== confirmedTo.toLowerCase())
    fail('reply_recipient_mismatch');
}
export async function replyGmail(env: Env, account: MailAccount, messageIdValue: string, body: string, confirmedTo: string, files: AttachmentFile[] = []) {
  if (account.provider !== 'gmail') fail('unsupported');
  const original = await json(env, account, '/messages/' + enc(messageIdValue) + '?format=full');
  const headers: any[] = original.payload?.headers ?? [];
  const id = messageId(header(headers, 'message-id'));
  const replyTo = mailboxAddress(header(headers, 'reply-to') || header(headers, 'from'));
  // Inbound Reply-To is untrusted; never silently choose an outbound recipient.
  if (confirmedTo.toLowerCase() !== replyTo.toLowerCase()) fail('reply_recipient_mismatch');
  const subject = header(headers, 'subject');
  if (replyTo.toLowerCase() === account.address.toLowerCase()) fail('unsupported');
  const references = header(headers, 'references').trim();
  // Preserve native Gmail thread identity and RFC 2822 relation, never infer from subject.
  const relation = 'In-Reply-To: ' + id + '\r\nReferences: ' +
    (references ? references + ' ' + id : id);
  const raw = gmailRaw(mimeMessage(account.address, [confirmedTo], subject, body, relation, files));
  const result = await json(env, account, '/messages/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw, threadId: String(original.threadId ?? '') }),
  });
  return { status: 'submitted' as const, reference: String(result.id ?? '') };
}
export async function forwardGmail(env: Env, account: MailAccount, originalId: string, to: string[], comment: string, files: AttachmentFile[] = []) {
  if (account.provider !== 'gmail') fail('unsupported');
  const original = await getMail(env, account, originalId);
  const composed = comment + '\n\n---------- Forwarded message ----------\n' +
    'From: ' + original.from + '\nSubject: ' + original.subject +
    '\n\n' + (original.text ?? original.snippet);
  const raw = gmailRaw(mimeMessage(account.address, to, ('Fwd: ' + original.subject).slice(0, 500), composed, '', files));
  const result = await json(env, account, '/messages/send', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
  });
  return { status: 'submitted' as const, reference: String(result.id ?? '') };
}
export async function graphReplyForwardWithFiles(
  env: Env, account: MailAccount, operation: 'reply' | 'forward',
  sourceId: string, body: string, files: AttachmentFile[], to: string[] = [],
): Promise<{ status: 'accepted'; reference: string }> {
  if (account.provider !== 'graph' || files.length === 0) fail('unsupported');
  const endpoint = '/messages/' + enc(sourceId);
  const payload = operation === 'reply'
    ? { comment: body } : { comment: body, toRecipients: graphRecipients(to) };
  const draft = await json(env, account, endpoint + (operation === 'reply' ? '/createReply' : '/createForward'), {
    method: 'POST', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
    body: JSON.stringify(payload),
  }) as { id?: string };
  if (!draft.id) fail('provider_error');
  for (const file of files) await graphAddAttachment(env, account, draft.id, file);
  await providerRequest(env, account, '/messages/' + enc(draft.id) + '/send', { method: 'POST' });
  return { status: 'accepted', reference: draft.id };
}
export async function draftCreate(env: Env, account: MailAccount, to: string[], subject: string, body: string, attachments: AttachmentInput[] = []) {
  const files = await attached(env, account, attachments);
  if (account.provider === 'imap_smtp') {
    if (files.length) fail('unsupported');
    return imapDraftCreate(env, account, to, subject, body);
  }
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { raw: gmailRaw(mimeMessage(account.address, to, subject, body, '', files)) } }),
    });
    return { account_id: account.account_id, id: response.id };
  }
  if (account.provider === 'graph') {
    const response = await json(env, account, '/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
      body: JSON.stringify({ subject, body: { contentType: 'Text', content: body }, toRecipients: graphRecipients(to) }),
    });
    if (files.length) {
      if (!response.id) fail('provider_error');
      for (const file of files) await graphAddAttachment(env, account, String(response.id), file);
    }
    return { account_id: account.account_id, id: response.id };
  }
  return fail('unsupported');
}
export async function draftUpdate(env: Env, account: MailAccount, id: string, to: string[], subject: string, body: string, attachments: AttachmentInput[] = []) {
  const files = await attached(env, account, attachments);
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/drafts/' + enc(id), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, message: { raw: gmailRaw(mimeMessage(account.address, to, subject, body, '', files)) } }),
    });
    return { account_id: account.account_id, id: response.id };
  }
  if (account.provider === 'graph') {
    const response = await json(env, account, '/messages/' + enc(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
      body: JSON.stringify({ subject, body: { contentType: 'Text', content: body }, toRecipients: graphRecipients(to) }),
    });
    for (const file of files) await graphAddAttachment(env, account, id, file);
    return { account_id: account.account_id, id: response.id };
  }
  return fail('unsupported');
}
export async function markMail(env: Env, account: MailAccount, id: string, isRead: boolean) {
  if (account.provider === 'imap_smtp') return imapMark(env, account, id, isRead);
  if (account.provider === 'gmail') {
    await json(env, account, '/messages/' + enc(id) + '/modify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(isRead ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }),
    });
    return { account_id: account.account_id, id, is_read: isRead };
  }
  if (account.provider === 'graph') {
    await json(env, account, '/messages/' + enc(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
      body: JSON.stringify({ isRead }),
    });
    return { account_id: account.account_id, id, is_read: isRead };
  }
  return fail('unsupported');
}
export async function moveMail(env: Env, account: MailAccount, id: string, folder: string) {
  if (account.provider === 'imap_smtp') return imapMove(env, account, id, folder);
  if (account.provider === 'gmail') {
    // Gmail labels aren't folders and must not be represented as a destructive move.
    return fail('unsupported');
  }
  if (account.provider === 'graph') {
    const response = await json(env, account, '/messages/' + enc(id) + '/move', {
      method: 'POST', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
      body: JSON.stringify({ destinationId: folder }),
    });
    return { account_id: account.account_id, id: response.id, folder };
  }
  return fail('unsupported');
}
export async function trashMail(env: Env, account: MailAccount, id: string) {
  if (account.provider === 'imap_smtp') return imapTrash(env, account, id);
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/messages/' + enc(id) + '/trash', { method: 'POST' });
    return { account_id: account.account_id, id: response.id };
  }
  return moveMail(env, account, id, 'deleteditems');
}
export async function attachmentGet(env: Env, account: MailAccount, messageId: string, attachmentId: string) {
  if (account.provider === 'imap_smtp') return imapAttachment(env, account, messageId, attachmentId);
  if (account.provider === 'gmail') {
    const result = await json(env, account, '/messages/' + enc(messageId) + '/attachments/' + enc(attachmentId));
    if (Number(result.size) > 5 * 1024 * 1024 || String(result.data ?? '').length > 7 * 1024 * 1024) fail('oversized_attachment');
    return { account_id: account.account_id, message_id: messageId, attachment_id: attachmentId, data_base64url: result.data, size: result.size };
  }
  if (account.provider === 'graph') {
    const result = await json(env, account, '/messages/' + enc(messageId) + '/attachments/' + enc(attachmentId));
    if (Number(result.size) > 5 * 1024 * 1024 || String(result.contentBytes ?? '').length > 7 * 1024 * 1024) fail('oversized_attachment');
    if (!result.contentBytes) fail('unsupported');
    return { account_id: account.account_id, message_id: messageId, attachment_id: attachmentId, data_base64: result.contentBytes, size: result.size };
  }
  return fail('unsupported');
}
export async function threadGet(env: Env, account: MailAccount, id: string) {
  if (account.provider === 'graph') {
    if (id.length > 512) fail('invalid_request');
    const params = new URLSearchParams({
      '$filter': "conversationId eq '" + id.replaceAll("'", "''") + "'",
      '$top': '30',
      '$select': 'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview',
    });
    const result = await json(env, account, '/messages?' + params, {
      headers: { Prefer: 'IdType="ImmutableId"' },
    });
    const messages = Array.isArray(result.value) ? result.value.slice(0, 30).map((m: any) => graphMessage(account, m)) : [];
    return { account_id: account.account_id, thread_id: id, messages,
      truncated: Boolean(result['@odata.nextLink']), consistent_snapshot: false };
  }
  if (account.provider === 'gmail') {
    const result = await json(env, account, '/threads/' + enc(id) + '?format=full');
    const list = Array.isArray(result.messages) ? result.messages.slice(0, 30) : [];
    return { account_id: account.account_id, thread_id: id, messages: list.map((m: any) => gmailMessage(account, m)) };
  }
  return fail('unsupported');
}
