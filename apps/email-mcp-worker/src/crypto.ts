import type { Env } from './types.ts';
import { fail } from './types.ts';

const utf8 = new TextEncoder();
function bytesToBase64(value: Uint8Array): string {
  let s = '';
  for (const b of value) s += String.fromCharCode(b);
  return btoa(s);
}
function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('invalid_ciphertext');
  try {
    const s = atob(value);
    return Uint8Array.from(s, ch => ch.charCodeAt(0));
  } catch { return fail('invalid_ciphertext'); }
}
async function keyFromSecret(value: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(value);
  if (bytes.length !== 32 || bytesToBase64(bytes) !== value) fail('invalid_encryption_key');
  return crypto.subtle.importKey('raw', bytes.buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export function currentKeyId(env: Env): string {
  const value = env.MAIL_KEY_ID ?? '1';
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(value)) fail('invalid_encryption_key');
  return value;
}
export async function encrypt(env: Env, context: string, plaintext: unknown): Promise<{ ciphertext: string; keyId: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromSecret(env.MAIL_ENCRYPTION_KEY);
  const raw = utf8.encode(JSON.stringify(plaintext));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv).buffer, additionalData: utf8.encode(context) }, key, raw,
  ));
  return { ciphertext: bytesToBase64(iv) + '.' + bytesToBase64(ciphertext), keyId: currentKeyId(env) };
}
export async function decrypt<T>(env: Env, context: string, ciphertext: string, keyId: string): Promise<T> {
  const versions = [{ id: currentKeyId(env), value: env.MAIL_ENCRYPTION_KEY }];
  if (env.MAIL_ENCRYPTION_PREVIOUS_KEY) versions.push({ id: env.MAIL_PREVIOUS_KEY_ID ?? 'previous', value: env.MAIL_ENCRYPTION_PREVIOUS_KEY });
  const secret = versions.find(item => item.id === keyId);
  if (!secret) fail('encryption_key_unavailable');
  const parts = ciphertext.split('.');
  if (parts.length !== 2) fail('invalid_ciphertext');
  const iv = base64ToBytes(parts[0]!);
  const ct = base64ToBytes(parts[1]!);
  if (iv.length !== 12 || ct.length < 16) fail('invalid_ciphertext');
  try {
    const key = await keyFromSecret(secret!.value);
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv).buffer, additionalData: utf8.encode(context) }, key, new Uint8Array(ct).buffer,
    );
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as T;
  } catch { return fail('invalid_ciphertext'); }
}
export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value)));
  return Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
}
export function base64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function nonce(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
