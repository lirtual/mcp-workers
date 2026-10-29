// Protected, Owner-invoked final D1 retirement after an independently released
// Hyperdrive unbinding. Does not delete Cloudflare configs or shared CA.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfiguration, verifyDatabaseHyperdriveSource } from './manual-worker-release.mjs';

const REGISTRY = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const fail = message => { throw Error('Hyperdrive retirement blocked: ' + message); };

export async function retireDatabaseHyperdrive({
  connectionId, expectedRevision, accountId, token, actor, ref, sourceSha,
  source, manifest, request = fetch
}) {
  if (actor !== 'lirtual' || ref !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(sourceSha ?? '') ||
      !/^[a-f0-9]{32}$/i.test(accountId ?? '') ||
      !token || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(connectionId ?? '') ||
      !/^[1-9][0-9]{0,12}$/.test(expectedRevision ?? '') ||
      !Number.isSafeInteger(Number(expectedRevision))) fail('Owner/revision gate');
  if (source?.name !== 'database-mcp-worker' || source?.main !== 'src/index.ts' ||
      source?.d1_databases?.length !== 1 || source.d1_databases[0].binding !== 'DB' ||
      source.d1_databases[0].database_id !== REGISTRY ||
      source.d1_databases[0].database_name !== 'database-mcp-registry') fail('managed D1 source');
  verifyDatabaseHyperdriveSource(source, manifest);
  const base = 'https://api.cloudflare.com/client/v4/accounts/' + accountId;
  async function cloud(path, method = 'GET', body) {
    let response;
    try { response = await request(base + path, {
      method, headers: { authorization: 'Bearer ' + token, accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    }); } catch { fail('Cloudflare API unavailable'); }
    if (!response?.ok) fail('Cloudflare response rejected');
    let envelope;
    try { envelope = await response.json(); } catch { fail('invalid Cloudflare response'); }
    if (!envelope || envelope.success !== true || envelope.result == null) fail('unconfirmed API result');
    return envelope.result;
  }
  async function sql(statement, params = []) {
    const result = await cloud('/d1/database/' + REGISTRY + '/query', 'POST',
      { sql: statement, params: params.map(String) });
    if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true) fail('D1 query rejected');
    return result[0];
  }
  const readSql = 'SELECT id,dialect,transport,status,revision,config_id,binding_name FROM database_connections WHERE id=?';
  const initial = await sql(readSql, [connectionId]);
  if (initial.results?.length !== 1) fail('logical connection absent');
  const row = initial.results[0];
  if (row.id !== connectionId || row.transport !== 'hyperdrive' || row.status !== 'disabled' ||
      row.revision !== Number(expectedRevision) || typeof row.config_id !== 'string' ||
      typeof row.binding_name !== 'string') fail('connection is active, stale or invalid');
  // Release source and *deployed* Worker must no longer contain either ref.
  if (manifest.some(x => x.id === row.config_id || x.binding === row.binding_name) ||
      (source.hyperdrive ?? []).some(x => x.id === row.config_id || x.binding === row.binding_name)) {
    fail('binding has not been removed from reviewed main');
  }
  const deployments = await cloud('/workers/scripts/database-mcp-worker/deployments');
  const versions = deployments.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].percentage !== 100) {
    fail('current production deployment is not a single version');
  }
  const settings = await cloud('/workers/scripts/database-mcp-worker/settings');
  const bindings = settings?.bindings;
  if (!Array.isArray(bindings) || bindings.filter(x => x.type === 'd1' &&
      x.name === 'DB' && (x.id === REGISTRY || x.database_id === REGISTRY)).length !== 1 ||
      bindings.some(x => x.type === 'hyperdrive' &&
      (x.id === row.config_id || x.name === row.binding_name))) fail('still bound in deployed Worker');
  const expectedBindings = source.hyperdrive ?? [];
  const deployedBindings = bindings.filter(x => x.type === 'hyperdrive');
  if (deployedBindings.length !== expectedBindings.length || expectedBindings.some(e =>
      deployedBindings.filter(x => x.id === e.id && x.name === e.binding).length !== 1)) {
    fail('deployed Hyperdrive manifest drift');
  }
  const shared = await sql('SELECT COUNT(*) AS n FROM database_connections WHERE id<>? AND (config_id=? OR binding_name=?)',
    [connectionId, row.config_id, row.binding_name]);
  if (shared.results?.[0]?.n !== 0) fail('another D1 connection references this config');
  // No upstream delete: older retained Worker versions, other apps, and shared
  // CA are outside this D1 CAS. They remain subject to separate human review.
  try {
    const deleted = await sql("DELETE FROM database_connections WHERE id=? AND revision=? AND transport='hyperdrive' AND status='disabled' AND config_id=? AND binding_name=?",
      [connectionId, expectedRevision, row.config_id, row.binding_name]);
    if (deleted.meta?.changes !== 1) fail('stale revision or deletion conflict');
  } catch {
    // Lost acknowledgment may follow committed deletion: inspect, never repeat.
    const after = await sql(readSql, [connectionId]).catch(() => null);
    const retired = await sql('SELECT id FROM retired_connection_ids WHERE id=?', [connectionId]).catch(() => null);
    if (after?.results?.length === 0 && retired?.results?.length === 1) {
      return { retired: true, connectionId };
    }
    fail('ambiguous deletion; verify D1 before any retry');
  }
  const after = await sql(readSql, [connectionId]);
  const retired = await sql('SELECT id FROM retired_connection_ids WHERE id=?', [connectionId]);
  if (after.results?.length !== 0 || retired.results?.length !== 1 ||
      retired.results[0].id !== connectionId) fail('retirement readback unconfirmed');
  return { retired: true, connectionId };
}

export async function main() {
  const source = readConfiguration('database-mcp-worker', await readFile(
    new URL('../apps/database-mcp-worker/wrangler.jsonc', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(
    new URL('../apps/database-mcp-worker/hyperdrive-bindings.json', import.meta.url), 'utf8'));
  await retireDatabaseHyperdrive({
    connectionId: process.env.DATABASE_RETIRE_ID,
    expectedRevision: process.env.DATABASE_RETIRE_REVISION,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    actor: process.env.GITHUB_ACTOR,
    ref: process.env.GITHUB_REF,
    sourceSha: process.env.GITHUB_SHA, source, manifest
  });
  process.stdout.write('Retired disabled unbound Hyperdrive D1 identity; upstream Cloudflare config retained.\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('Database Hyperdrive retirement: BLOCKED (details withheld).\n');
    process.exitCode = 1; });
}
