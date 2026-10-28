// Read-only Spec #344 Direct cutover verifier; never changes D1 or contacts an origin.
import { webcrypto } from 'node:crypto';
import { parseLegacyImport } from './database-prep-344.mjs';

const expectedIds = ['b2b', 'scrape_relay'];
const textEncoder = new TextEncoder();
function blocked() {
  throw Error('Database Direct preflight failed: identity, key or encrypted row mismatch (values withheld)');
}
function canonicalBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) blocked();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) blocked();
  return bytes;
}

/**
 * Verifies that both disabled, encrypted legacy rows are authentic and still
 * equal the exact approved original connection URLs. No secrets are returned.
 * The GitHub Environment copy of DATABASE_CONFIG cannot independently attest
 * that the deployed Cloudflare legacy Secret is byte-for-byte equal.
 */
export async function verifyDirectCutoverPreflight({ rows, originalConfig, encryptionKey, keyId }) {
  const catalog = parseLegacyImport(originalConfig);
  if (!Array.isArray(rows) || rows.length !== expectedIds.length ||
      typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) blocked();
  const raw = canonicalBase64(encryptionKey);
  if (raw.length !== 32) blocked();
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);

  for (let i = 0; i < expectedIds.length; i++) {
    const id = expectedIds[i];
    const row = rows[i];
    if (!row || row.id !== id || catalog[i]?.id !== id ||
        row.dialect !== 'mysql' || row.transport !== 'direct' ||
        row.status !== 'disabled' || row.revision !== 1 ||
        row.key_id !== keyId || row.config_id !== null || row.binding_name !== null ||
        typeof row.ciphertext !== 'string' || row.ciphertext.length > 32768) blocked();

    const segments = row.ciphertext.split('.');
    if (segments.length !== 2) blocked();
    const iv = canonicalBase64(segments[0]);
    const sealed = canonicalBase64(segments[1]);
    if (iv.length !== 12 || sealed.length < 16) blocked();

    let payload;
    try {
      const plaintext = await webcrypto.subtle.decrypt({
        name: 'AES-GCM',
        iv,
        additionalData: textEncoder.encode('database-mcp:connection:v1:' + id + ':mysql')
      }, key, sealed);
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    } catch { blocked(); }
    if (!payload || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || payload.url !== catalog[i].url) blocked();
  }
  return { valid: true, ids: [...expectedIds], expectedRevision: 1 };
}
