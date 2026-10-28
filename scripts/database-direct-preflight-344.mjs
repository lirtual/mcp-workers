// Read-only Spec #344 Direct cutover verifier; never changes D1 or contacts an origin.
import { webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const D1_ID = '8853a6ac-beaa-45aa-bdb2-0867e6f3df6d';
const D1_READ_SQL = "SELECT id,dialect,transport,status,revision,key_id,ciphertext,config_id,binding_name FROM database_connections ORDER BY id";
const LEDGER_SQL = "SELECT (SELECT COUNT(*) FROM d1_migrations WHERE name IN ('0001_connections.sql','0002_transport_and_retired_ids.sql')) AS migrations,(SELECT COUNT(*) FROM retired_connection_ids) AS retired,(SELECT COUNT(*) FROM database_connections) AS total";

async function readCloudflare(path, token, account, body) {
  const response = await fetch('https://api.cloudflare.com/client/v4/accounts/' + account + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) blocked();
  const value = await response.json();
  if (value?.success !== true) blocked();
  return value.result;
}
async function readD1(sql, token, account) {
  const data = await readCloudflare('/d1/database/' + D1_ID + '/query', token, account, { sql });
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.success !== true ||
      !Array.isArray(data[0].results)) blocked();
  return data[0].results;
}

/** A deliberately read-only attestation. Does not enable rows or deploy a Worker. */
export async function checkReadOnlyD1(env = process.env) {
  if (env.GITHUB_ACTOR !== 'lirtual' || env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
      !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') ||
      !env.CLOUDFLARE_API_TOKEN || !env.DATABASE_CONFIG ||
      !env.DATABASE_ENCRYPTION_KEY || !env.DATABASE_KEY_ID) blocked();
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;

  const settings = await readCloudflare('/workers/scripts/database-mcp-worker/settings', token, account);
  if (!Array.isArray(settings?.bindings) ||
      !settings.bindings.some(binding => binding.name === 'DATABASE_CONFIG' &&
        binding.type === 'secret_text') ||
      settings.bindings.some(binding => binding.name === 'DB' && binding.type === 'd1')) blocked();

  const ledger = await readD1(LEDGER_SQL, token, account);
  if (ledger.length !== 1 || ledger[0].migrations !== 2 ||
      ledger[0].retired !== 0 || ledger[0].total !== 2) blocked();
  const rows = await readD1(D1_READ_SQL, token, account);
  await verifyDirectCutoverPreflight({
    rows, originalConfig: env.DATABASE_CONFIG,
    encryptionKey: env.DATABASE_ENCRYPTION_KEY, keyId: env.DATABASE_KEY_ID
  });
  return { valid: true, records: 2, status: 'disabled', workerChanged: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkReadOnlyD1().then(() => {
    console.log('Database #344 Direct read-only preflight passed; two disabled encrypted IDs match approved input.');
  }).catch(() => {
    console.error('Database #344 Direct read-only preflight blocked; no D1 writes or Worker deployment attempted.');
    process.exitCode = 1;
  });
}
