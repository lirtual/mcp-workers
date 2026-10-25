import { fail } from './types.ts';

export type AttachmentInput =
  | { type: 'inline'; filename: string; data_base64: string; mime_type?: string }
  | { type: 'mailbox'; filename: string; message_id: string; attachment_id: string };
export type AttachmentFile = { filename: string; mimeType: string; data: Uint8Array };
export const MAX_ATTACHMENTS_TOTAL = 5 * 1024 * 1024;

export function attachmentName(name: string): string {
  // ASCII-only names deliberately avoid ambiguous RFC 2231 or unsafe header encodings.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}$/.test(name) ||
    name.includes('..') || name.trim() !== name) fail('invalid_attachment_name');
  return name;
}
function canonicalBase64(value: string): Uint8Array {
  // Linear-time validation; multi-MB repeated regex groups can overflow JS stacks.
  const decodedLength = Math.floor(value.length / 4) * 3 -
    (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (decodedLength > MAX_ATTACHMENTS_TOTAL || value.length > 7 * 1024 * 1024) fail('oversized_attachment');
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('invalid_attachment');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { return fail('invalid_attachment'); }
  if (bytes.length !== decodedLength) fail('invalid_attachment');
  return bytes;
}
export function validateAttachmentInputs(items: AttachmentInput[]): void {
  if (items.length > 5) fail('oversized_attachment');
  let knownSize = 0;
  for (const input of items) {
    attachmentName(input.filename);
    if (input.type === 'inline') {
      if (input.mime_type && !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(input.mime_type))
        fail('invalid_attachment');
      if (input.data_base64.length > 7 * 1024 * 1024) fail('oversized_attachment');
      knownSize += canonicalBase64(input.data_base64).length;
    } else {
      if (!input.message_id || !input.attachment_id || input.message_id.length > 512 || input.attachment_id.length > 512) fail('invalid_attachment');
    }
    if (knownSize > MAX_ATTACHMENTS_TOTAL) fail('oversized_attachment');
  }
}
export async function resolveAttachments(
  items: AttachmentInput[],
  lookup: (messageId: string, attachmentId: string) => Promise<{ data_base64?: string; data_base64url?: string; size?: number }>,
): Promise<AttachmentFile[]> {
  validateAttachmentInputs(items);
  const files: AttachmentFile[] = [];
  let bytes = 0;
  for (const item of items) {
    let data: Uint8Array;
    if (item.type === 'inline') data = canonicalBase64(item.data_base64);
    else {
      const fromMailbox = await lookup(item.message_id, item.attachment_id);
      const encoded = fromMailbox.data_base64 ??
        (fromMailbox.data_base64url?.replaceAll('-', '+').replaceAll('_', '/') +
          '='.repeat((4 - (fromMailbox.data_base64url?.length ?? 0) % 4) % 4));
      if (!encoded || Number(fromMailbox.size) > MAX_ATTACHMENTS_TOTAL) fail('oversized_attachment');
      data = canonicalBase64(encoded);
      if (fromMailbox.size != null && fromMailbox.size !== data.length) fail('invalid_attachment');
    }
    bytes += data.length;
    if (bytes > MAX_ATTACHMENTS_TOTAL) fail('oversized_attachment');
    files.push({ filename: item.filename,
      mimeType: item.type === 'inline' ? (item.mime_type ?? 'application/octet-stream') : 'application/octet-stream',
      data });
  }
  return files;
}
export function base64Data(data: Uint8Array): string {
  let raw = '';
  for (const b of data) raw += String.fromCharCode(b);
  return btoa(raw);
}
export function validateGraphUploadUrl(value: string): string {
  if (value.length > 4096) fail('invalid_upload_url');
  let u: URL;
  try { u = new URL(value); } catch { return fail('invalid_upload_url'); }
  if (u.origin !== 'https://outlook.office.com' || u.port || u.username || u.password || u.hash ||
    !/^\/api\/(?:v[12]\.0|gv1\.0)\/users\('[^/?#]{1,250}'\)\/messages\('[^/?#]{1,500}'\)\/attachmentsessions\('[^/?#]{1,500}'\)$/i.test(u.pathname) ||
    !u.searchParams.has('authtoken') || !u.searchParams.get('authtoken')) fail('invalid_upload_url');
  return value;
}
