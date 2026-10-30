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
    // Emit only a bounded operation class on failure; never emit Cloudflare
    // payloads, SQL parameters, credentials, row IDs or raw provider errors.
    const phase = path.includes('/d1/database/')
      ? (body?.sql?.startsWith('DELETE') ? 'd1_delete' : 'd1_query')
      : path.endsWith('/settings') ? 'worker_settings'
      : path.endsWith('/deployments') ? 'worker_deployments' : 'other';
    let response;
    try { response = await request(base + path, {
      method, headers: { authorization: 'Bearer ' + token, accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual', signal: AbortSignal.timeout(15000)
    }); } catch { fail('Cloudflare API unavailable'); }
    if (!response?.ok) {
      const status = [400,401,403,404,409,429,500,502,503].includes(response?.status)
        ? response.status : 'unknown';
      fail('Cloudflare response rejected at ' + phase + ' (HTTP ' + status + ')');
    }
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
  const readSql = 'SELECT id,dialect,transport,status,revision,config_id,binding_name,in_flight_count FROM database_connections WHERE id=?';
  const initial = await sql(readSql, [connectionId]);
  if (initial.results?.length !== 1) fail('logical connection absent');
  const row = initial.results[0];
  if (row.id !== connectionId || row.transport !== 'hyperdrive' || row.status !== 'disabled' ||
      row.revision !== Number(expectedRevision) || row.in_flight_count !== 0 || typeof row.config_id !== 'string' ||
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
  // `version_id` is the live deployment API field. Settings alone can be
  // newer than the version actually receiving traffic; verify its immutable
  // resources before permitting the D1 tombstone.
  const activeVersionId = versions[0].version_id;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(activeVersionId ?? '')) {
    fail('active production version ID unconfirmed');
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
  // The deployable=true API explicitly ignores pagination and returns all
  // rollback-eligible versions. Missing/ambiguous inventory cannot prove safety.
  const rollback = await cloud('/workers/scripts/database-mcp-worker/versions?deployable=true');
  if (!Array.isArray(rollback?.items) || rollback.items.length === 0 ||
      rollback.items.length > 100 || new Set(rollback.items.map(v=>v.id)).size !== rollback.items.length) {
    fail('rollback reference inventory unavailable');
  }
  if (!rollback.items.some(v => v.id === activeVersionId)) {
    fail('active production version absent from rollback inventory');
  }
  let verifiedLive = false;
  for (const version of rollback.items) {
    if (!/^[0-9a-f-]{36}$/i.test(version.id ?? '')) fail('rollback reference identity invalid');
    const detail = await cloud('/workers/scripts/database-mcp-worker/versions/' + version.id);
    if (detail?.id !== version.id || !Array.isArray(detail.resources?.bindings) ||
        detail.resources.bindings.some(b=>b.type==='hyperdrive' &&
          (b.id===row.config_id || b.name===row.binding_name))) fail('rollback version reference remains or is unconfirmed');
    if (version.id === activeVersionId) {
      const liveBindings = detail.resources.bindings;
      const remaining = liveBindings.filter(b=>b.type==='hyperdrive');
      if (liveBindings.filter(b=>b.type==='d1' && b.name==='DB' &&
          (b.database_id===REGISTRY || b.id===REGISTRY)).length!==1 ||
          remaining.length!==expectedBindings.length || expectedBindings.some(e=>
            remaining.filter(b=>b.id===e.id && b.name===e.binding).length!==1)) {
        fail('live production version binding inventory differs from reviewed release');
      }
      verifiedLive = true;
    }
  }
  if (!verifiedLive) fail('active version was not verified');
  // A logical connection must not be tombstoned while another Worker can
  // still use its config, including a rollback-eligible immutable version.
  // deployable=true explicitly ignores pagination; fail closed on unknown
  // account script inventories or version lists, without deleting resources.
  const versionIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const scriptInventory = await cloud('/workers/scripts');
  if (!Array.isArray(scriptInventory) || scriptInventory.length === 0 ||
      scriptInventory.length >= 100) fail('account Worker inventory incomplete');
  const scriptNames = scriptInventory.map(x => x.id ?? x.name);
  if (scriptNames.some(n => typeof n !== 'string' || !n) ||
      new Set(scriptNames).size !== scriptNames.length ||
      !scriptNames.includes('database-mcp-worker'))
    fail('account Worker identity inventory incomplete');
  const hasRetiredBinding = bs => bs.some(b => b.type === 'hyperdrive' &&
    (b.id === row.config_id || b.name === row.binding_name));
  const otherWorkers = [];
  for (const name of scriptNames.filter(n => n !== 'database-mcp-worker')) {
    const path = '/workers/scripts/' + encodeURIComponent(name);
    const current = await cloud(path + '/settings');
    if (!Array.isArray(current?.bindings)) fail('other Worker settings unavailable');
    if (hasRetiredBinding(current.bindings)) fail('another Worker still references config');
    const deployment = await cloud(path + '/deployments');
    const liveVersions = deployment?.deployments?.[0]?.versions;
    if (!Array.isArray(liveVersions) || liveVersions.length !== 1 ||
        liveVersions[0].percentage !== 100 ||
        !versionIdPattern.test(liveVersions[0].version_id ?? ''))
      fail('other Worker deployment unconfirmed');
    const otherVersions = await cloud(path + '/versions?deployable=true');
    const ids = otherVersions?.items?.map(v => v.id);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
        new Set(ids).size !== ids.length ||
        ids.some(id => !versionIdPattern.test(id)) ||
        !ids.includes(liveVersions[0].version_id))
      fail('other Worker rollback inventory incomplete');
    for (const id of ids) {
      const detail = await cloud(path + '/versions/' + id);
      if (detail?.id !== id || !Array.isArray(detail.resources?.bindings))
        fail('other Worker rollback detail unavailable');
      if (hasRetiredBinding(detail.resources.bindings))
        fail('another Worker rollback version references config');
    }
    otherWorkers.push({path,activeId:liveVersions[0].version_id,ids:ids.sort()});
    const again = await cloud(path + '/deployments');
    if (again?.deployments?.[0]?.versions?.length !== 1 ||
        again.deployments[0].versions[0].percentage !== 100 ||
        again.deployments[0].versions[0].version_id !== liveVersions[0].version_id)
      fail('other Worker deployment changed during check');
  }
  const inventoryAgain = await cloud('/workers/scripts');
  if (!Array.isArray(inventoryAgain) || inventoryAgain.length !== scriptNames.length ||
      inventoryAgain.map(x => x.id ?? x.name).sort().some((n,i) =>
        n !== [...scriptNames].sort()[i]))
    fail('account Worker inventory changed during check');
  for (const {path,activeId,ids} of otherWorkers) {
    const latest = await cloud(path + '/settings');
    if (!Array.isArray(latest?.bindings) || hasRetiredBinding(latest.bindings))
      fail('other Worker settings changed during check');
    const versionsAgain = await cloud(path + '/versions?deployable=true');
    if (!Array.isArray(versionsAgain?.items) ||
        versionsAgain.items.length !== ids.length ||
        versionsAgain.items.map(x => x.id).sort().some((id,i) => id !== ids[i]))
      fail('other Worker rollback inventory changed during check');
    const deploymentAgain = await cloud(path + '/deployments');
    if (deploymentAgain?.deployments?.[0]?.versions?.length !== 1 ||
        deploymentAgain.deployments[0].versions[0].percentage !== 100 ||
        deploymentAgain.deployments[0].versions[0].version_id !== activeId)
      fail('other Worker deployment changed during check');
  }
  const shared = await sql('SELECT COUNT(*) AS n FROM database_connections WHERE id<>? AND (config_id=? OR binding_name=?)',
    [connectionId, row.config_id, row.binding_name]);
  if (shared.results?.[0]?.n !== 0) fail('another D1 connection references this config');
  // Close an avoidable time-of-check-to-deletion window if another release
  // changed the live Worker while rollback resources were being examined.
  const liveAgain = await cloud('/workers/scripts/database-mcp-worker/deployments');
  if (liveAgain?.deployments?.[0]?.versions?.length!==1 ||
      liveAgain.deployments[0].versions[0].percentage!==100 ||
      liveAgain.deployments[0].versions[0].version_id!==activeVersionId) {
    fail('live production deployment changed during retirement verification');
  }
  // A different version may become rollback-eligible while other Workers are
  // scanned, without changing the currently serving production version.
  const latestOwnRollback = await cloud('/workers/scripts/database-mcp-worker/versions?deployable=true');
  const initialOwnIds = rollback.items.map(v => v.id).sort();
  if (!Array.isArray(latestOwnRollback?.items) ||
      latestOwnRollback.items.length !== initialOwnIds.length ||
      latestOwnRollback.items.map(v => v.id).sort().some((id,i) => id !== initialOwnIds[i]))
    fail('database Worker rollback inventory changed');
  // No upstream delete: older retained Worker versions, other apps, and shared
  // CA are outside this D1 CAS. They remain subject to separate human review.
  try {
    const deleted = await sql("DELETE FROM database_connections WHERE id=? AND revision=? AND transport='hyperdrive' AND status='disabled' AND in_flight_count=0 AND config_id=? AND binding_name=? AND NOT EXISTS (SELECT 1 FROM hyperdrive_operations WHERE logical_id=database_connections.id AND phase IN ('pending','running','awaiting_confirmation','unknown'))",
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
  main().catch(error => {
    const message = error instanceof Error ? error.message : '';
    // A fixed, allowlisted diagnostic label only. Never print arbitrary errors.
    const phase = /at (d1_delete|d1_query|worker_settings|worker_deployments)(?: \(HTTP (400|401|403|404|409|429|500|502|503|unknown)\))?/.exec(message);
    const suffix = phase ? ' stage=' + phase[1] + (phase[2] ? ' status=' + phase[2] : '') : '';
    process.stderr.write('Database Hyperdrive retirement: BLOCKED' + suffix + '.\n');
    process.exitCode = 1;
  });
}
