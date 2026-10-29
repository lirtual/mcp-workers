// Authenticated read-only prepublication verification of the managed D1 registry.
// No historical catalog imports, Worker restore paths, or upstream SQL probes.
import { webcrypto } from 'node:crypto';

const textEncoder = new TextEncoder();
function blocked() { throw Error('Database registry preflight failed (details withheld)'); }
function canonicalBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) blocked();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) blocked();
  return bytes;
}

/**
 * After cutover, independent Owner setup operations may change, disable,
 * retire or add connections. This read-only guard authenticates every stored
 * Direct ciphertext using only currently configured recovery keys, without
 * requiring the original two IDs or disclosing any decrypted URL.
 */
export async function verifyRegistryReadiness(rows, keys, manifest = []) {
  if (!Array.isArray(rows) || rows.length > 10 || !Array.isArray(manifest) ||
      manifest.length > 10 || !keys ||
      typeof keys.DATABASE_KEY_ID !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(keys.DATABASE_KEY_ID)) blocked();
  const seenIds = new Set();
  const seenConfigs = new Set();
  const seenBindings = new Set();
  let direct = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.id) ||
        seenIds.has(row.id) || !['mysql', 'postgres'].includes(row.dialect) ||
        !['active', 'disabled'].includes(row.status) ||
        !Number.isSafeInteger(row.revision) || row.revision < 1) blocked();
    seenIds.add(row.id);
    if (row.transport === 'hyperdrive') {
      if (row.ciphertext !== null || row.key_id !== null ||
          typeof row.config_id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(row.config_id) ||
          typeof row.binding_name !== 'string' || !/^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(row.binding_name) ||
          seenConfigs.has(row.config_id) || seenBindings.has(row.binding_name)) blocked();
      seenConfigs.add(row.config_id); seenBindings.add(row.binding_name);
      // Disabled references may legitimately await a binding release. An
      // active reference must match the immutable, protected source mapping;
      // otherwise an existing consumer would lose its connection on release.
      if (row.status === 'active' && manifest.filter(item =>
        item?.binding === row.binding_name && item?.id === row.config_id &&
        item?.dialect === row.dialect).length !== 1) blocked();
      continue;
    }
    if (row.transport !== 'direct' || row.config_id !== null || row.binding_name !== null ||
        typeof row.key_id !== 'string' || typeof row.ciphertext !== 'string' ||
        row.ciphertext.length > 32768) blocked();
    const selected = row.key_id === keys.DATABASE_KEY_ID
      ? keys.DATABASE_ENCRYPTION_KEY
      : row.key_id === keys.DATABASE_PREVIOUS_KEY_ID &&
        keys.DATABASE_PREVIOUS_KEY_ID !== keys.DATABASE_KEY_ID
        ? keys.DATABASE_ENCRYPTION_PREVIOUS_KEY : null;
    if (!selected) blocked();
    try {
      const raw = canonicalBase64(selected);
      if (raw.length !== 32) blocked();
      const parts = row.ciphertext.split('.');
      if (parts.length !== 2) blocked();
      const iv = canonicalBase64(parts[0]);
      const ciphertext = canonicalBase64(parts[1]);
      if (iv.length !== 12 || ciphertext.length < 16) blocked();
      const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      const decoded = await webcrypto.subtle.decrypt({
        name: 'AES-GCM', iv,
        additionalData: textEncoder.encode(`database-mcp:connection:v1:${row.id}:${row.dialect}`)
      }, key, ciphertext);
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
      if (!payload || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
          typeof payload.url !== 'string' || payload.url.length === 0 || payload.url.length > 8192) blocked();
      const url = new URL(payload.url);
      const dialect = url.protocol === 'mysql:' ? 'mysql' :
        ['postgres:', 'postgresql:'].includes(url.protocol) ? 'postgres' : null;
      // Runtime Direct admission rejects scheme/dialect mismatch, URL options,
      // fragments and missing identity. Prevent a subsequent code release from
      // silently retaining an active connection which cannot be admitted.
      if (dialect !== row.dialect || url.search || url.hash ||
          !url.hostname || !url.username ||
          (dialect === 'postgres' && url.pathname.replace(/^\/+/, '').length === 0)) blocked();
    } catch { blocked(); }
    direct++;
  }
  return { valid: true, records: rows.length, direct, hyperdrive: rows.length - direct };
}
