import { accessToken } from './oauth.ts';
import { fail } from './types.ts';
import type { Env, MailAccount } from './types.ts';

type Message = {
  account_id: string; provider: string; id: string; thread_id?: string;
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
function gmailMessage(account: MailAccount, msg: any): Message {
  const parts = [msg.payload, ...(msg.payload?.parts ?? [])].filter(Boolean);
  const headers = msg.payload?.headers ?? [];
  const h = (name: string): string => (headers.find((x: any) => x.name?.toLowerCase() === name)?.value ?? '').slice(0, 1000);
  const text = parts.find((p: any) => p.mimeType === 'text/plain')?.body?.data;
  const attachments = parts.filter((p: any) => p.filename && p.body?.attachmentId)
    .map((p: any) => ({ id: p.body.attachmentId as string, filename: String(p.filename).slice(0, 200), size: Number(p.body.size) || 0 }));
  return {
    account_id: account.account_id, provider: account.provider, id: String(msg.id ?? ''),
    thread_id: String(msg.threadId ?? ''), subject: h('subject'), from: h('from'), to: h('to'),
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
    to: recipients.map((r: any) => r.emailAddress?.address ?? '').join(', ').slice(0, 2000),
    date: String(msg.receivedDateTime ?? ''), snippet: plainText(String(msg.bodyPreview ?? '')).slice(0, 1000),
    text: plainText(String(body ?? msg.bodyPreview ?? '')),
  };
}
export async function getMail(env: Env, account: MailAccount, id: string): Promise<Message> {
  if (account.provider === 'gmail') {
    const msg = await json(env, account, '/messages/' + enc(id) + '?format=full');
    return gmailMessage(account, msg);
  }
  if (account.provider === 'graph') {
    const msg = await json(env, account, '/messages/' + enc(id) + '?$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,body', {
      headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
    });
    return graphMessage(account, msg);
  }
  return fail('unsupported');
}
export async function listFolders(env: Env, account: MailAccount): Promise<unknown> {
  if (account.provider === 'gmail') return { account_id: account.account_id, folders: (await json(env, account, '/labels')).labels ?? [] };
  if (account.provider === 'graph') return { account_id: account.account_id, folders: (await json(env, account, '/mailFolders?$top=100')).value ?? [] };
  return fail('unsupported');
}
export async function searchMail(env: Env, account: MailAccount, query: string, after?: string, limit = 10) {
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
    const skip = after ? Number(after) : 0;
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > 1000) fail('invalid_cursor');
    const params = new URLSearchParams({
      '$search': '"' + query.replaceAll('"', '') + '"',
      '$top': String(limit),
      '$skip': String(skip),
      '$select': 'id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview',
    });
    const result = await json(env, account, '/messages?' + params, {
      headers: { Prefer: 'IdType="ImmutableId"' },
    });
    const messages = Array.isArray(result.value) ? result.value.slice(0, limit).map((m: any) => graphMessage(account, m)) : [];
    return { messages, next: result['@odata.nextLink'] ? String(skip + messages.length) : undefined };
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
function mimeMessage(address: string, to: string[], subject: string, body: string, extra = ''): string {
  recipients(to);
  nonHeader(subject, 500);
  if (body.length > 100000) fail('payload_too_large');
  const headers = [
    'From: ' + nonHeader(address, 320),
    'To: ' + to.join(',\r\n '),
    'Subject: ' + encodedSubject(subject),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  if (extra) headers.push(extra);
  return headers.join('\r\n') + '\r\n\r\n' + utf8B64(body);
}
function gmailRaw(value: string): string {
  return utf8B64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function graphRecipients(to: string[]) {
  return recipients(to).map(address => ({ emailAddress: { address } }));
}
export async function sendMail(env: Env, account: MailAccount, to: string[], subject: string, body: string) {
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/messages/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: gmailRaw(mimeMessage(account.address, to, subject, body)) }),
    });
    return { status: 'submitted' as const, reference: String(response.id ?? '') };
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
export async function draftCreate(env: Env, account: MailAccount, to: string[], subject: string, body: string) {
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { raw: gmailRaw(mimeMessage(account.address, to, subject, body)) } }),
    });
    return { account_id: account.account_id, id: response.id };
  }
  if (account.provider === 'graph') {
    const response = await json(env, account, '/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
      body: JSON.stringify({ subject, body: { contentType: 'Text', content: body }, toRecipients: graphRecipients(to) }),
    });
    return { account_id: account.account_id, id: response.id };
  }
  return fail('unsupported');
}
export async function draftUpdate(env: Env, account: MailAccount, id: string, to: string[], subject: string, body: string) {
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/drafts/' + enc(id), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, message: { raw: gmailRaw(mimeMessage(account.address, to, subject, body)) } }),
    });
    return { account_id: account.account_id, id: response.id };
  }
  if (account.provider === 'graph') {
    const response = await json(env, account, '/messages/' + enc(id), {
      method: 'PATCH', headers: { 'content-type': 'application/json', Prefer: 'IdType="ImmutableId"' },
      body: JSON.stringify({ subject, body: { contentType: 'Text', content: body }, toRecipients: graphRecipients(to) }),
    });
    return { account_id: account.account_id, id: response.id };
  }
  return fail('unsupported');
}
export async function markMail(env: Env, account: MailAccount, id: string, isRead: boolean) {
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
  if (account.provider === 'gmail') {
    const response = await json(env, account, '/messages/' + enc(id) + '/trash', { method: 'POST' });
    return { account_id: account.account_id, id: response.id };
  }
  return moveMail(env, account, id, 'deleteditems');
}
export async function attachmentGet(env: Env, account: MailAccount, messageId: string, attachmentId: string) {
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
  if (account.provider === 'gmail') {
    const result = await json(env, account, '/threads/' + enc(id) + '?format=full');
    const list = Array.isArray(result.messages) ? result.messages.slice(0, 30) : [];
    return { account_id: account.account_id, thread_id: id, messages: list.map((m: any) => gmailMessage(account, m)) };
  }
  return fail('unsupported');
}
