import { PublicError } from '../errors.js';
import type { Dialect } from '../types.js';

/** Previous keys must be retained while any D1 backup or rollback may need them. */
export interface EncryptionKeys {
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_KEY_ID?: string;
  DATABASE_ENCRYPTION_PREVIOUS_KEY?: string;
  DATABASE_PREVIOUS_KEY_ID?: string;
}
export interface EncryptedConfig { keyId: string; ciphertext: string }
export interface PrivateConnectionConfig { url: string; ca?: string }

const utf8 = new TextEncoder();
const idPattern = /^[A-Za-z0-9_-]{1,32}$/;
function unavailable(message: string): never { throw new PublicError('CONFIGURATION_UNAVAILABLE', message); }
function decodeCanonicalBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    unavailable('Encrypted database configuration is invalid.');
  }
  try {
    const decoded = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    if (encodeBase64(decoded) !== value) unavailable('Encrypted database configuration is invalid.');
    return decoded;
  } catch { return unavailable('Encrypted database configuration is invalid.'); }
}
function encodeBase64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
async function importEncryptionKey(value: string | undefined): Promise<CryptoKey> {
  if (typeof value !== 'string') unavailable('The database encryption key is not configured.');
  const bytes = decodeCanonicalBase64(value);
  if (bytes.length !== 32) unavailable('The database encryption key is invalid.');
  return crypto.subtle.importKey('raw', bytes.buffer as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
function currentId(keys: EncryptionKeys): string {
  if (!keys.DATABASE_KEY_ID || !idPattern.test(keys.DATABASE_KEY_ID)) {
    unavailable('The database encryption key identifier is invalid.');
  }
  return keys.DATABASE_KEY_ID;
}
function aad(id: string, dialect: Dialect): Uint8Array {
  return utf8.encode(`database-mcp:connection:v1:${id}:${dialect}`);
}
function validPayload(value: unknown): value is PrivateConnectionConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => key === 'url' || key === 'ca') &&
    typeof record.url === 'string' && record.url.length > 0 && record.url.length <= 8192 &&
    (record.ca === undefined || (typeof record.ca === 'string' && record.ca.length <= 16384));
}

export async function sealConnectionConfig(
  keys: EncryptionKeys, id: string, dialect: Dialect, payload: PrivateConnectionConfig
): Promise<EncryptedConfig> {
  if (!validPayload(payload)) unavailable('The database configuration is invalid.');
  const key = await importEncryptionKey(keys.DATABASE_ENCRYPTION_KEY);
  const keyId = currentId(keys);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv).buffer, additionalData: aad(id, dialect).buffer as ArrayBuffer },
    key, utf8.encode(JSON.stringify(payload))
  ));
  return { keyId, ciphertext: encodeBase64(iv) + '.' + encodeBase64(encrypted) };
}

export async function openConnectionConfig(
  keys: EncryptionKeys, id: string, dialect: Dialect, sealed: EncryptedConfig
): Promise<PrivateConnectionConfig> {
  const keyId = currentId(keys);
  let raw: string | undefined;
  if (sealed.keyId === keyId) raw = keys.DATABASE_ENCRYPTION_KEY;
  else if (keys.DATABASE_PREVIOUS_KEY_ID && sealed.keyId === keys.DATABASE_PREVIOUS_KEY_ID &&
    keys.DATABASE_PREVIOUS_KEY_ID !== keyId) raw = keys.DATABASE_ENCRYPTION_PREVIOUS_KEY;
  if (!raw) throw new PublicError('ENCRYPTION_KEY_UNAVAILABLE', 'The required database recovery key is unavailable.');
  const [ivString, ciphertextString, extra] = sealed.ciphertext.split('.');
  if (!ivString || !ciphertextString || extra !== undefined) unavailable('Encrypted database configuration is invalid.');
  const iv = decodeCanonicalBase64(ivString);
  const ciphertext = decodeCanonicalBase64(ciphertextString);
  if (iv.length !== 12 || ciphertext.length < 16) unavailable('Encrypted database configuration is invalid.');
  const key = await importEncryptionKey(raw);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv).buffer, additionalData: aad(id, dialect).buffer as ArrayBuffer },
      key, new Uint8Array(ciphertext).buffer
    );
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted));
    if (!validPayload(payload)) unavailable('Encrypted database configuration is invalid.');
    return payload;
  } catch { return unavailable('Encrypted database configuration is invalid.'); }
}
