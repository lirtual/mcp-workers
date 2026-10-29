// Read-only readiness for a fresh D1 registry; never reads or mutates the historical registry.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRegistryReadiness } from './database-registry-readiness-344.mjs';

const D1_ID = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const LEDGER_SQL = "SELECT (SELECT COUNT(*) FROM d1_migrations WHERE name IN ('0001_connections.sql','0002_transport_and_retired_ids.sql')) AS migrations, (SELECT COUNT(*) FROM database_connections) AS total, (SELECT COUNT(*) FROM retired_connection_ids) AS retired, (SELECT COUNT(*) FROM database_connections WHERE id IN (SELECT id FROM retired_connection_ids)) AS reused";
const ROWS_SQL = 'SELECT id,dialect,transport,status,revision,key_id,ciphertext,config_id,binding_name FROM database_connections ORDER BY id';
function blocked() { throw Error('Database fresh registry preflight rejected (details withheld)'); }
async function requestCloudflare(env, path, sql, fetcher) {
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    method: sql ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...(sql ? { 'Content-Type': 'application/json' } : {}) },
    ...(sql ? { body: JSON.stringify({ sql }) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) blocked();
  const json = await response.json();
  if (json?.success !== true) blocked();
  return json.result;
}
async function readD1(env, sql, fetcher) {
  const data = await requestCloudflare(env, `/d1/database/${D1_ID}/query`, sql, fetcher);
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.success !== true || !Array.isArray(data[0].results)) blocked();
  return data[0].results;
}
export async function checkFreshRegistry(env = process.env, fetcher = fetch) {
  if (env.GITHUB_ACTOR !== 'lirtual' || env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[0-9a-f]{40}$/i.test(env.GITHUB_SHA ?? '') ||
      !/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') ||
      !env.CLOUDFLARE_API_TOKEN || !env.DATABASE_ENCRYPTION_KEY || !env.DATABASE_KEY_ID) blocked();
  const [settings, deployment] = await Promise.all([
    requestCloudflare(env, '/workers/scripts/database-mcp-worker/settings', null, fetcher),
    requestCloudflare(env, '/workers/scripts/database-mcp-worker/deployments', null, fetcher)
  ]);
  const active = deployment?.deployments?.[0]?.versions;
  if (!Array.isArray(settings?.bindings) || !Array.isArray(active) || active.length !== 1 ||
      active[0]?.percentage !== 100 || typeof active[0].version_id !== 'string') blocked();
  const d1 = settings.bindings.filter(x => x.name === 'DB');
  if (d1.length !== 1 || d1[0].type !== 'd1' ||
      (d1[0].id || d1[0].database_id) !== D1_ID) blocked();
  const ledger = await readD1(env, LEDGER_SQL, fetcher);
  if (ledger.length !== 1 || ledger[0].migrations !== 2 ||
      !Number.isSafeInteger(ledger[0].total) || ledger[0].total < 0 || ledger[0].total > 10 ||
      !Number.isSafeInteger(ledger[0].retired) || ledger[0].retired < 0 || ledger[0].reused !== 0) blocked();
  const rows = await readD1(env, ROWS_SQL, fetcher);
  if (rows.length !== ledger[0].total) blocked();
  const manifest = JSON.parse(await readFile(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json', import.meta.url), 'utf8'));
  const verified = await verifyRegistryReadiness(rows, env, manifest);
  // Active Hyperdrive references are accepted only when their immutable
  // config/binding/dialect pair matched the reviewed manifest above.
  // Do not reintroduce an obsolete Direct-only restriction here.
  return { valid: true, phase: 'managed', records: verified.records };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkFreshRegistry().then(result => console.log(`Database fresh registry: PASS; ${result.phase}; records=${result.records}`))
    .catch(() => { console.error('Database fresh registry check failed; no writes attempted.'); process.exitCode = 1; });
}
