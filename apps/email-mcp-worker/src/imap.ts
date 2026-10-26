import { ImapFlow, createSocketsTransport } from 'imapflow';
import PostalMime from 'postal-mime';
import { decrypt, base64url } from './crypto.ts';
import { base64Data, MAX_ATTACHMENTS_TOTAL } from './attachments.ts';
import { resolvePublicMailEndpoint, validateMailHost, validateMailPorts } from './mail-endpoints.ts';
import { fail, MailError } from './types.ts';
import type { Env, MailAccount } from './types.ts';
export type ProtocolCredentials = {
  imap_host: string; imap_port: 993; smtp_host: string; smtp_port: 465 | 587;
  username: string; password: string; smtp_username?: string; smtp_password?: string;
};
export function validateProtocolCredentials(input: ProtocolCredentials): ProtocolCredentials {
  validateMailPorts(input.imap_port, input.smtp_port);
  input.imap_host = validateMailHost(input.imap_host);
  input.smtp_host = validateMailHost(input.smtp_host);
  // Gmail/Outlook native accounts belong to their dedicated ChatGPT plugins.
  const blocked = new Set(['imap.gmail.com','smtp.gmail.com','imap.googlemail.com',
    'outlook.office365.com','smtp.office365.com','imap-mail.outlook.com',
    'smtp-mail.outlook.com']);
  if (blocked.has(input.imap_host) || blocked.has(input.smtp_host)) fail('unsupported_provider');
  for (const name of ['username','password','smtp_username','smtp_password'] as const) {
    const val = input[name];
    if (val != null && (typeof val !== 'string' || !val || val.length > 512 ||
      /[\r\n\x00-\x1f\x7f]/.test(val))) fail('invalid_mail_credential');
  }
  if (!input.username || !input.password) fail('invalid_mail_credential');
  return input;
}
export async function protocolCredentials(env: Env, account: MailAccount): Promise<ProtocolCredentials> {
  if (account.provider !== 'imap_smtp' || account.status !== 'active') fail('reauthorization_required');
  return validateProtocolCredentials(await decrypt<ProtocolCredentials>(env,
    'account:' + account.account_id + ':' + account.provider,
    account.credential_ciphertext, account.credential_key_id));
}
export async function withImap<T>(env: Env, account: MailAccount, work: (client: ImapFlow, cfg: ProtocolCredentials) => Promise<T>): Promise<T> {
  const cfg = await protocolCredentials(env, account);
  const target = await resolvePublicMailEndpoint(cfg.imap_host);
  const { connect } = await import('cloudflare:sockets');
  // Workers blocks disallowed TCP targets; its native transport resolves the hostname
  // independently of the public-DNS precheck, so this is NOT strict IP pinning.
  const client = new ImapFlow({ host: target.hostname, port: 993, secure: true,
    transport: createSocketsTransport((address, options) =>
      connect(address, { ...options, allowHalfOpen: false })),
    tls: { rejectUnauthorized: true },
    auth: { user: cfg.username, pass: cfg.password }, logger: false, socketTimeout: 15000 });
  // ImapFlow emits socket errors as EventEmitter events as well as rejected calls.
  client.on('error', () => { /* errors from operations are sanitized by the caller */ });
  try {
    await client.connect();
    return await work(client, cfg);
  } catch (err) {
    if (err instanceof MailError) throw err;
    return fail('imap_unavailable');
  } finally {
    try { await client.logout(); } catch {}
  }
}
export type ImapReference = { folder: string; uidvalidity: string; uid: number };
export function encodeImapReference(ref: ImapReference): string {
  return base64url(new TextEncoder().encode(JSON.stringify(ref)));
}
export function decodeImapReference(value: string): ImapReference {
  if (value.length > 750 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('stale_reference');
  try {
    const str = value.replaceAll('-', '+').replaceAll('_', '/');
    const raw = atob(str + '='.repeat((4 - str.length % 4) % 4));
    const ref = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0)))) as ImapReference;
    if (!ref || typeof ref.folder !== 'string' || !ref.folder || ref.folder.length > 255 ||
      /[\r\n\x00-\x1f]/.test(ref.folder) || !/^[1-9][0-9]{0,19}$/.test(ref.uidvalidity) ||
      !Number.isSafeInteger(ref.uid) || ref.uid <= 0) fail('stale_reference');
    return ref;
  } catch { return fail('stale_reference'); }
}
export async function withSelected<T>(client: ImapFlow, ref: ImapReference, work: () => Promise<T>): Promise<T> {
  const lock = await client.getMailboxLock(ref.folder);
  try {
    if (String(client.mailbox && client.mailbox.uidValidity) !== ref.uidvalidity) fail('stale_reference');
    return await work();
  } finally { lock.release(); }
}
export async function imapFolders(env: Env, account: MailAccount) {
  return withImap(env, account, async client => {
    const all = await client.list();
    return { account_id: account.account_id,
      folders: all.slice(0, 100).map(box => ({ id: box.path, name: box.path })),
      truncated: all.length > 100 };
  });
}
// Some IMAP providers (notably QQ/163/126) return unrelated results for TEXT
// searches. Scan only bounded INBOX envelope metadata there, never full bodies.
export function requiresEnvelopeSearch(host: string): boolean {
  return ['imap.qq.com', 'imap.163.com', 'imap.126.com'].includes(host.toLowerCase());
}
export function matchesEnvelopeQuery(envelope: unknown, query: string): boolean {
  if (!envelope || typeof envelope !== 'object' || !query) return false;
  const fields: string[] = [];
  const item = envelope as Record<string, unknown>;
  if (typeof item.subject === 'string') fields.push(item.subject);
  for (const key of ['from', 'sender', 'to', 'cc', 'bcc', 'replyTo']) {
    const addresses = item[key];
    if (!Array.isArray(addresses)) continue;
    for (const address of addresses) {
      if (!address || typeof address !== 'object') continue;
      for (const field of ['name', 'address']) {
        const value = (address as Record<string, unknown>)[field];
        if (typeof value === 'string') fields.push(value);
      }
    }
  }
  const needle = query.normalize('NFKC').toLowerCase();
  return fields.some(value => value.normalize('NFKC').toLowerCase().includes(needle));
}
export async function imapSearch(env: Env, account: MailAccount, query: string, after?: string, limit = 10) {
  return withImap(env, account, async (client, cfg) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const envelopeOnly = requiresEnvelopeSearch(cfg.imap_host);
      let matched: number[];
      if (envelopeOnly) {
        // This is a complete scan or a visible failure: never silently return a
        // partial set of results for a large or changing mailbox.
        const size = client.mailbox ? client.mailbox.exists : 0;
        if (size > 5000) fail('result_too_large');
        matched = [];
        if (size > 0) {
          let scanned = 0;
          for await (const message of client.fetch('1:*',
            { uid: true, envelope: true }, { uid: true })) {
            if (++scanned > 5000) fail('result_too_large');
            if (!Number.isSafeInteger(message.uid) || message.uid <= 0) fail('imap_unavailable');
            if (matchesEnvelopeQuery(message.envelope, query)) matched.push(message.uid);
          }
        }
      } else {
        const result = await client.search({ text: query }, { uid: true });
        if (!Array.isArray(result)) fail('imap_unavailable');
        matched = result;
      }
      if (matched.length > 5000) fail('result_too_large');
      const offset = after ? Number(after) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) fail('invalid_cursor');
      const ordered = [...matched].reverse();
      const ids = ordered.slice(offset, offset + limit);
      const found = ids.length ? await client.fetchAll(ids, { envelope: true, internalDate: true, uid: true }, { uid: true }) : [];
      const uidvalidity = String(client.mailbox && client.mailbox.uidValidity);
      return { messages: found.map(msg => ({
        account_id: account.account_id, provider: account.provider,
        id: encodeImapReference({ folder: 'INBOX', uidvalidity, uid: msg.uid }),
        subject: msg.envelope?.subject ?? '', from: msg.envelope?.from?.[0]?.address ?? '',
        to: msg.envelope?.to?.[0]?.address ?? '', date: msg.internalDate ? new Date(msg.internalDate).toISOString() : '',
        snippet: '',
      })), next: offset + limit < ordered.length ? String(offset + limit) : undefined,
        scope: 'INBOX', search_scope: envelopeOnly ? 'envelope' : 'full_text', consistent_snapshot: false };
    } finally { lock.release(); }
  });
}
async function rawMessage(client: ImapFlow, uid: number) {
  // Mail is fetched on demand; reject oversized content before parsing.
  const info = await client.fetchOne(uid, { uid: true, size: true }, { uid: true });
  if (!info) fail('stale_reference');
  if (info.size && info.size > 6 * 1024 * 1024) fail('result_too_large');
  const raw = await client.fetchOne(uid, { source: true }, { uid: true });
  if (!raw || !raw.source || raw.source.byteLength > 6 * 1024 * 1024) fail('result_too_large');
  return PostalMime.parse(raw.source, { maxNestingDepth: 16, maxHeadersSize: 32768,
    maxRfc822NestingDepth: 2 });
}
export async function imapGet(env: Env, account: MailAccount, identity: string) {
  const ref = decodeImapReference(identity);
  return withImap(env, account, client => withSelected(client, ref, async () => {
    const mail = await rawMessage(client, ref.uid);
    return { account_id: account.account_id, provider: account.provider, id: identity,
      subject: mail.subject ?? '', from: mail.from?.address ?? '',
      reply_to: mail.replyTo?.[0]?.address ?? mail.from?.address ?? '',
      to: mail.to?.map(item => 'address' in item ? item.address : '').join(', ') ?? '',
      date: mail.date ?? '', text: (mail.text ?? '').slice(0, 40000),
      snippet: (mail.text ?? '').slice(0, 1000),
      attachments: mail.attachments.map((a, index) => ({
        id: String(index), filename: a.filename ?? 'attachment',
        size: typeof a.content === 'string' ? a.content.length : a.content.byteLength,
      })) };
  }));
}
export async function imapAttachment(env: Env, account: MailAccount, identity: string, index: string) {
  const ref = decodeImapReference(identity);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(index)) fail('stale_reference');
  return withImap(env, account, client => withSelected(client, ref, async () => {
    const item = (await rawMessage(client, ref.uid)).attachments[Number(index)];
    if (!item) fail('stale_reference');
    const bytes = typeof item.content === 'string'
      ? new TextEncoder().encode(item.content) : new Uint8Array(item.content);
    if (bytes.length > MAX_ATTACHMENTS_TOTAL) fail('oversized_attachment');
    return { account_id: account.account_id, message_id: identity,
      attachment_id: index, size: bytes.length, data_base64: base64Data(bytes) };
  }));
}
// A selected mailbox and UIDVALIDITY only prove the folder identity, not that
// a particular UID still exists. A missing UID can otherwise make UID STORE
// appear successful even when no message was changed.
async function requireImapUid(client: ImapFlow, uid: number): Promise<void> {
  const current = await client.fetchOne(uid, { uid: true }, { uid: true });
  if (!current || current.uid !== uid) fail('stale_reference');
}

// Extract the selected-mailbox operations for network-free failure-path tests.
export async function markSelectedImapMessage(client: ImapFlow, uid: number, read: boolean): Promise<void> {
  await requireImapUid(client, uid);
  const result = read
    ? await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
    : await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
  if (result !== true) fail('imap_mutation_failed');
  // STORE success alone is not proof that the requested flag is now present.
  const updated = await client.fetchOne(uid, { uid: true, flags: true }, { uid: true });
  if (!updated || updated.uid !== uid) fail('stale_reference');
  if (!updated.flags || updated.flags.has('\\Seen') !== read) fail('imap_mutation_failed');
}

export async function moveSelectedImapMessage(client: ImapFlow, uid: number, folder: string): Promise<void> {
  await requireImapUid(client, uid);
  const result = await client.messageMove(uid, folder, { uid: true });
  if (!result || result.destination !== folder) fail('imap_mutation_failed');
}

export async function imapMark(env: Env, account: MailAccount, identity: string, read: boolean) {
  const ref = decodeImapReference(identity);
  return withImap(env, account, client => withSelected(client, ref, async () => {
    await markSelectedImapMessage(client, ref.uid, read);
    return { account_id: account.account_id, id: identity, is_read: read };
  }));
}
export async function imapMove(env: Env, account: MailAccount, identity: string, folder: string) {
  const ref = decodeImapReference(identity);
  if (!folder || folder.length > 255 || /[\x00-\x1f\x7f]/.test(folder)) fail('invalid_folder');
  return withImap(env, account, async client => {
    if (!(await client.list()).some(f => f.path === folder)) fail('invalid_folder');
    return withSelected(client, ref, async () => {
      if (!client.capabilities.has('MOVE')) fail('unsupported');
      await moveSelectedImapMessage(client, ref.uid, folder);
      return { account_id: account.account_id, old_id: identity,
        destination: folder, status: 'moved', new_reference: null };
    });
  });
}
export function findImapTrash(folders: { path: string; specialUse?: string }[]) {
  return folders.find(f => f.specialUse === '\\Trash') ??
    folders.find(f => /^(trash|deleted items|deleted)$/i.test(f.path));
}
export async function imapTrash(env: Env, account: MailAccount, identity: string) {
  return withImap(env, account, async client => {
    const trash = findImapTrash(await client.list());
    if (!trash || !client.capabilities.has('MOVE')) fail('unsupported');
    const ref = decodeImapReference(identity);
    return withSelected(client, ref, async () => {
      if (ref.folder === trash.path) fail('unsupported');
      await moveSelectedImapMessage(client, ref.uid, trash.path);
      return { account_id: account.account_id, old_id: identity,
        destination: trash.path, status: 'trashed', new_reference: null };
    });
  });
}
export async function verifyImapCredentials(input: ProtocolCredentials): Promise<void> {
  const cfg = validateProtocolCredentials(input);
  const [imapTarget] = await Promise.all([
    resolvePublicMailEndpoint(cfg.imap_host), resolvePublicMailEndpoint(cfg.smtp_host),
  ]);
  const { connect } = await import('cloudflare:sockets');
  const client = new ImapFlow({
    host: imapTarget.hostname, port: 993, secure: true,
    transport: createSocketsTransport((address, options) =>
      connect(address, { ...options, allowHalfOpen: false })),
    tls: { rejectUnauthorized: true },
    auth: { user: cfg.username, pass: cfg.password }, logger: false,
    socketTimeout: 15000, connectionTimeout: 10000,
  });
  client.on('error', () => { /* TLS/auth failure returned as a sanitized error */ });
  try { await client.connect(); }
  catch { fail('imap_connection_failed'); }
  finally { try { await client.logout(); } catch {} }
}
export async function imapDraftCreate(env: Env, account: MailAccount, to: string[], subject: string, body: string) {
  const nodemailer = (await import('nodemailer')).default;
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const composed = await composer.sendMail({ from: account.address, to, subject, text: body,
    disableFileAccess: true, disableUrlAccess: true });
  const raw = Buffer.from(composed.message);
  if (raw.byteLength > 256 * 1024) fail('payload_too_large');
  return withImap(env, account, async client => {
    const folders = await client.list();
    const box = folders.find(x => x.specialUse === '\\Drafts') ??
      folders.find(x => /^drafts$/i.test(x.path));
    if (!box || !client.capabilities.has('UIDPLUS')) fail('unsupported');
    const result = await client.append(box.path, raw, ['\\Draft']);
    if (!result || !result.uid || !result.uidValidity) fail('unknown_draft_outcome');
    return { account_id: account.account_id,
      id: encodeImapReference({ folder: box.path, uidvalidity: String(result.uidValidity), uid: result.uid }) };
  });
}
export function imapReplyHeaders(mail: {
  from?: { address?: string };
  replyTo?: { address?: string }[];
  subject?: string; messageId?: string; references?: string;
}, explicitTo: string) {
  // Incoming Reply-To is untrusted: do not silently select one recipient
  // when the message actually requests a reply to multiple addresses.
  if (mail.replyTo && mail.replyTo.length > 1) fail('unsupported');
  const expected = mail.replyTo?.[0]?.address ?? mail.from?.address;
  if (!expected || explicitTo.toLowerCase() !== expected.toLowerCase()) fail('reply_recipient_mismatch');
  const validId = (value: string) => /^<[^\s<>@]{1,150}@[a-zA-Z0-9.-]{3,120}>$/.test(value);
  const original = mail.messageId ?? '';
  if (!validId(original)) fail('unsupported');
  const previous = (mail.references ?? '').split(/\s+/).filter(validId).slice(-10);
  return {
    subject: /^(?:re:)/i.test(mail.subject ?? '') ? (mail.subject ?? '').slice(0, 500) :
      ('Re: ' + (mail.subject ?? '')).slice(0, 500),
    to: [explicitTo],
    inReplyTo: original, references: [...previous, original].join(' '),
  };
}
export async function imapReplyContext(env: Env, account: MailAccount, identity: string, explicitTo: string) {
  const ref = decodeImapReference(identity);
  return withImap(env, account, client => withSelected(client, ref, async () => {
    return imapReplyHeaders(await rawMessage(client, ref.uid), explicitTo);
  }));
}
