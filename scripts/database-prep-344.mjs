// One-shot, fail-closed Spec #344 preparation: no Worker publish and no origin SQL.
// Only run from the protected database-mcp-worker GitHub Environment on main.
// Legacy URLs and encryption keys exist only as process Environment Secrets.
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const IDS = ['b2b', 'scrape_relay'];
const MAX_PLAINTEXT = 24545;
const MAX_CIPHERTEXT = 32768;
const encoder = new TextEncoder();

function fail() {
  throw Error('Database #344 preparation blocked; prerequisites or readback invalid (values withheld)');
}
function sameIds(value) {
  return Array.isArray(value) && value.length === IDS.length &&
    IDS.every(id => value.includes(id)) && new Set(value).size === IDS.length;
}
export function parseLegacyImport(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { fail(); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !sameIds(Object.keys(obj))) fail();
  return IDS.map(id => {
    const value = obj[id];
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192) fail();
    let url;
    try { url = new URL(value); } catch { fail(); }
    // A different target, dialect, transport or URI option requires separate authorization.
    if (url.protocol !== 'mysql:' || !url.hostname || !url.username ||
        url.hash !== '' || url.search !== '' || url.port && !(Number(url.port) > 0 && Number(url.port) <= 65535)) fail();
    return { id, url: value };
  });
}
function required(name) {
  const value = process.env[name];
  if (!value || typeof value !== 'string') fail();
  return value;
}
function canonicalKey(value) {
  if (!/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) fail();
  return bytes;
}
export async function encryptDirect(id, url, keyText) {
  if (!IDS.includes(id)) fail();
  const content = encoder.encode(JSON.stringify({ url }));
  if (content.byteLength > MAX_PLAINTEXT) fail();
  const key = await webcrypto.subtle.importKey('raw', canonicalKey(keyText), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode('database-mcp:connection:v1:' + id + ':mysql');
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, content));
  const ciphertext = Buffer.from(iv).toString('base64') + '.' + Buffer.from(encrypted).toString('base64');
  if (ciphertext.length > MAX_CIPHERTEXT) fail();
  const original = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encrypted));
  if (new TextDecoder().decode(original) !== new TextDecoder().decode(content)) fail();
  return ciphertext;
}
async function query(dbId, sql, params = []) {
  const resp = await fetch('https://api.cloudflare.com/client/v4/accounts/' + required('CLOUDFLARE_ACCOUNT_ID') +
    '/d1/database/' + dbId + '/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + required('CLOUDFLARE_API_TOKEN'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params: params.map(String) }),
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) fail();
  const payload = await resp.json();
  if (payload.success !== true || !Array.isArray(payload.result) || payload.result.length !== 1 ||
      payload.result[0].success !== true || !Array.isArray(payload.result[0].results)) fail();
  return payload.result[0].results;
}
const STATUS_SQL = "SELECT " +
  "(SELECT COUNT(*) FROM d1_migrations WHERE name='0001_connections.sql') AS m1, " +
  "(SELECT COUNT(*) FROM d1_migrations WHERE name='0002_transport_and_retired_ids.sql') AS m2, " +
  "(SELECT COUNT(*) FROM database_connections) AS n, " +
  "(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='retired_connection_ids') AS retired_table";
async function state(dbId, stage) {
  const rows = await query(dbId, STATUS_SQL);
  if (rows.length !== 1) fail();
  const r = rows[0];
  if (r.m1 !== 1 || r.m2 !== (stage === 'before' ? 0 : 1) || r.n !== 0 ||
      r.retired_table !== (stage === 'before' ? 0 : 1)) fail();
}
async function main() {
  const mode = process.argv[2];
  if (!['validate', 'import'].includes(mode)) fail();
  if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_ACTOR !== 'lirtual' ||
      !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) fail();
  const expected = JSON.parse(required('DATABASE_CUTOVER_EXPECTED_IDS'));
  if (!sameIds(expected)) fail();
  const catalog = parseLegacyImport(required('DATABASE_LEGACY_IMPORT_CONFIG'));
  const key = required('DATABASE_ENCRYPTION_KEY');
  const keyId = required('DATABASE_KEY_ID');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) fail();
  const configured = JSON.parse(await readFile(new URL('../apps/database-mcp-worker/wrangler.jsonc', import.meta.url), 'utf8'));
  const db = configured.d1_databases?.[0];
  if (configured.name !== 'database-mcp-worker' || configured.main !== 'src/index.ts' ||
      configured.d1_databases?.length !== 1 || db?.binding !== 'DB' ||
      db?.database_name !== 'database-mcp-db' || !/^[a-f0-9-]{36}$/i.test(db.database_id || '') ||
      !/^[a-f0-9]{32}$/i.test(required('CLOUDFLARE_ACCOUNT_ID'))) fail();
  // Fully encrypt and self-decrypt both before any mutation, so bad keys fail first.
  const records = await Promise.all(catalog.map(async item =>
    ({ id: item.id, sealed: await encryptDirect(item.id, item.url, key) })));
  await state(db.database_id, mode === 'validate' ? 'before' : 'after');
  if (mode === 'validate') {
    console.log('Database #344 preparation preflight passed; no D1 mutation performed.');
    return;
  }
  const timestamp = Date.now();
  // One atomic SQLite INSERT; no SQL/credential/ciphertext is printed to logs.
  const insert = "INSERT INTO database_connections " +
    "(id,dialect,transport,status,ciphertext,key_id,revision,created_at,updated_at) VALUES " +
    "(?,'mysql','direct','disabled',?,?,1,?,?), (?,'mysql','direct','disabled',?,?,1,?,?)";
  const params = records.flatMap(r => [r.id, r.sealed, keyId, String(timestamp), String(timestamp)]);
  await query(db.database_id, insert, params);
  const readback = await query(db.database_id,
    "SELECT id,dialect,transport,status,key_id AS key_id,length(ciphertext) AS bytes,revision " +
    "FROM database_connections ORDER BY id");
  if (readback.length !== 2 || readback.some((r,i) =>
    r.id !== records[i].id || r.dialect !== 'mysql' || r.transport !== 'direct' ||
    r.status !== 'disabled' || r.key_id !== keyId || r.revision !== 1 ||
    !(r.bytes >= 40 && r.bytes <= MAX_CIPHERTEXT))) fail();
  console.log('Database #344 D1 import verified: two disabled MySQL Direct records; Worker unchanged.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Database #344 preparation failed; inspect gate conditions (no values printed).'); process.exitCode = 1; });
}
