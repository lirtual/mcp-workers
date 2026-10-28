// Read-only Spec #344 Direct cutover verifier; never changes D1 or contacts an origin.
import { readFile } from 'node:fs/promises';
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
export async function verifyDirectCutoverPreflight({ rows, originalConfig, encryptionKey, keyId, phase = 'staged' }) {
  if (!['staged', 'release'].includes(phase)) blocked();
  const expectedStatus = phase === 'staged' ? 'disabled' : 'active';
  const expectedRevision = phase === 'staged' ? 1 : 2;
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
        row.status !== expectedStatus || row.revision !== expectedRevision ||
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
  return { valid: true, ids: [...expectedIds], expectedRevision };
}

const D1_ID = '8853a6ac-beaa-45aa-bdb2-0867e6f3df6d';
const LEGACY_WORKER_VERSION = 'eb3f4823-124b-4d76-abdc-42f85097bb5a';
const D1_READ_SQL = "SELECT id,dialect,transport,status,revision,key_id,ciphertext,config_id,binding_name FROM database_connections ORDER BY id";
const LEDGER_SQL = "SELECT (SELECT COUNT(*) FROM d1_migrations WHERE name IN ('0001_connections.sql','0002_transport_and_retired_ids.sql')) AS migrations,(SELECT COUNT(*) FROM retired_connection_ids) AS retired,(SELECT COUNT(*) FROM database_connections) AS total,(SELECT COUNT(*) FROM database_connections WHERE id IN (SELECT id FROM retired_connection_ids)) AS reused";

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

/** A deliberately read-only attestation. Does not enable rows or deploy a Worker. */
export async function checkReadOnlyD1(env = process.env) {
  const phase = env.DATABASE_DIRECT_PREFLIGHT_PHASE || 'staged';
  if (!['staged', 'release'].includes(phase)) blocked();
  if (env.GITHUB_ACTOR !== 'lirtual' || env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
      !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') ||
      !env.CLOUDFLARE_API_TOKEN || !env.DATABASE_ENCRYPTION_KEY ||
      !env.DATABASE_KEY_ID) blocked();
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const settings = await readCloudflare('/workers/scripts/database-mcp-worker/settings', token, account);
  const deployment = await readCloudflare('/workers/scripts/database-mcp-worker/deployments', token, account);
  const active = deployment?.deployments?.[0]?.versions;
  if (!Array.isArray(settings?.bindings) || !Array.isArray(active) || active.length !== 1 ||
      active[0]?.percentage !== 100 || typeof active[0]?.version_id !== 'string') blocked();
  const originalWorkerStillActive = active[0].version_id === LEGACY_WORKER_VERSION;
  const named = name => settings.bindings.filter(b => b?.name === name);
  const original = named('DATABASE_CONFIG');
  const d1 = named('DB');
  const legacy = original.length === 1 && original[0].type === 'secret_text' && d1.length === 0;
  const registry = d1.length === 1 && d1[0].type === 'd1' &&
    (d1[0].id || d1[0].database_id) === D1_ID &&
    !original.some(b => b.type !== 'secret_text');
  // Out-of-band binding changes on the original Worker cannot be mistaken
  // for a completed code cutover. Require a real nonlegacy 100% deployment.
  if ((originalWorkerStillActive && !legacy) ||
      (!originalWorkerStillActive && !registry) ||
      (phase === 'staged' && !originalWorkerStillActive)) blocked();
  const ledger = await readD1(LEDGER_SQL, token, account);
  if (ledger.length !== 1 || ledger[0].migrations !== 2 ||
      !Number.isSafeInteger(ledger[0].retired) || ledger[0].retired < 0 ||
      !Number.isSafeInteger(ledger[0].total) || ledger[0].total < 0 ||
      ledger[0].total > 10 || ledger[0].reused !== 0) blocked();
  const rows = await readD1(D1_READ_SQL, token, account);
  if (ledger[0].total !== rows.length) blocked();
  if (originalWorkerStillActive) {
    if (ledger[0].retired !== 0 || rows.length !== 2 || !env.DATABASE_CONFIG) blocked();
    await verifyDirectCutoverPreflight({
      rows, originalConfig: env.DATABASE_CONFIG,
      encryptionKey: env.DATABASE_ENCRYPTION_KEY, keyId: env.DATABASE_KEY_ID, phase
    });
    return { valid: true, records: 2, status: phase === 'staged' ? 'disabled' : 'active', workerChanged: false };
  }
  if (phase !== 'release') blocked();
  // The runtime consumes this same versioned, nonsecret manifest. The later
  // Cloudflare-origin readback gate independently checks every declared config.
  const manifest = JSON.parse(await readFile(new URL(
    '../apps/database-mcp-worker/hyperdrive-bindings.json', import.meta.url), 'utf8'));
  const result = await verifyRegistryReadiness(rows, env, manifest);
  // The phased initial Worker release admits only MySQL Direct. A later
  // publication must not quietly accept an active D1 row the runtime itself
  // refuses, even if its ciphertext or Hyperdrive manifest is otherwise valid.
  // Disabled future-mode metadata may remain safely staged for later review.
  if (rows.some(row => row.status === 'active' &&
      (row.transport !== 'direct' || row.dialect !== 'mysql'))) blocked();
  return { ...result, status: 'registry', workerChanged: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkReadOnlyD1().then(() => {
    console.log('Database #344 read-only release preflight passed (legacy cutover or D1 registry verified).');
  }).catch(() => {
    console.error('Database #344 Direct read-only preflight blocked; no D1 writes or Worker deployment attempted.');
    process.exitCode = 1;
  });
}
