// Owner-triggered Hyperdrive activation in the existing protected release workflow.
// Never import a Cloudflare management token into the Worker; never print API payloads.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfiguration, verifyDatabaseHyperdriveSource } from './manual-worker-release.mjs';
import { verifyDatabaseHyperdriveCloudReadback } from './verify-database-hyperdrive.mjs';

function requireGate(condition, message) {
  if (!condition) throw Error('Database activation blocked: ' + message);
}
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const revisionPattern = /^[1-9][0-9]{0,12}$/;
const accountPattern = /^[a-f0-9]{32}$/i;

export async function activateDatabaseHyperdrive({
  connectionId, expectedRevision, accountId, token, portalToken, actor, ref, sourceSha,
  source, manifest, request = fetch
}) {
  requireGate(actor === 'lirtual' && ref === 'refs/heads/main' && /^[a-f0-9]{40}$/.test(sourceSha ?? ''),
    'only Owner on the exact protected main source may activate');
  requireGate(typeof connectionId === 'string' && idPattern.test(connectionId) &&
    typeof expectedRevision === 'string' && revisionPattern.test(expectedRevision) &&
    Number.isSafeInteger(Number(expectedRevision)), 'invalid connection id or expected revision');
  requireGate(accountPattern.test(accountId ?? '') && typeof token === 'string' && token.length > 0 &&
    typeof portalToken === 'string' && portalToken.length > 0, 'required protected credentials are unavailable');

  requireGate(source?.name === 'database-mcp-worker' && source?.main === 'src/index.ts' &&
    source?.d1_databases?.length === 1 && source.d1_databases[0].binding === 'DB' &&
    source.d1_databases[0].database_name === 'database-mcp-db' &&
    /^[a-f0-9-]{36}$/i.test(source.d1_databases[0].database_id ?? ''),
    'reviewed Worker/D1 source is missing');
  verifyDatabaseHyperdriveSource(source, manifest);
  const manifestEntries = manifest.filter(row => row && row.binding && row.id);
  requireGate(manifestEntries.length > 0, 'no approved Hyperdrive bindings');
  const d1Id = source.d1_databases[0].database_id;
  const base = 'https://api.cloudflare.com/client/v4/accounts/' + accountId;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };

  async function cloud(path, method = 'GET', body) {
    let response;
    try {
      response = await request(base + path, {
        method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000)
      });
    } catch { throw Error('Database activation blocked: Cloudflare API unavailable'); }
    requireGate(response?.ok === true, 'Cloudflare API rejected operation');
    let envelope;
    try { envelope = await response.json(); }
    catch { throw Error('Database activation blocked: malformed Cloudflare response'); }
    requireGate(envelope?.success === true && envelope.result != null, 'Cloudflare API did not confirm operation');
    return envelope.result;
  }
  async function sql(statement, params = []) {
    const result = await cloud('/d1/database/' + d1Id + '/query', 'POST', { sql: statement, params: params.map(String) });
    requireGate(Array.isArray(result) && result.length === 1 && result[0].success === true,
      'D1 operation not confirmed');
    return result[0];
  }
  async function verifyCloudAndBinding() {
    const settings = await cloud('/workers/scripts/database-mcp-worker/settings');
    const bindings = settings?.bindings;
    requireGate(Array.isArray(bindings), 'deployed Worker settings missing');
    const expectedBindings = source.hyperdrive ?? [];
    const actual = bindings.filter(b => b.type === 'hyperdrive');
    requireGate(actual.length === expectedBindings.length && expectedBindings.every(e =>
      actual.filter(b => b.name === e.binding && b.id === e.id).length === 1),
    'deployed Hyperdrive binding differs from reviewed main source');
    requireGate(bindings.filter(b => b.name === 'DB' && b.type === 'd1' &&
      (b.id === d1Id || b.database_id === d1Id)).length === 1,
    'deployed Worker D1 binding differs from reviewed source');
    requireGate(bindings.some(b => b.name === 'MCP_ACCESS_TOKEN' && b.type === 'secret_text'),
      'MCP bearer authentication is not present');
    const checked = await verifyDatabaseHyperdriveCloudReadback({
      source, manifest, accountId, token, request
    });
    requireGate(checked.verified === manifest.length, 'Hyperdrive security readback incomplete');
  }
  await verifyCloudAndBinding();
  const migration = await sql("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0002_transport_and_retired_ids.sql'");
  requireGate(migration.results?.length === 1 && migration.results[0].n === 1,
    'additive D1 migration is not applied');
  const read = await sql('SELECT id,dialect,transport,status,revision,config_id,binding_name FROM database_connections WHERE id=?',
    [connectionId]);
  requireGate(read.results?.length === 1, 'disabled logical connection was not found');
  const row = read.results[0];
  const expected = manifest.find(m => m.id === row.config_id && m.binding === row.binding_name);
  requireGate(row.status === 'disabled' && row.transport === 'hyperdrive' &&
    row.revision === Number(expectedRevision) && expected && row.dialect === expected.dialect,
    'connection state, revision, or approved Binding has changed');
  await verifyCloudAndBinding();

  const update = await sql("UPDATE database_connections SET status='active',revision=revision+1,updated_at=? WHERE id=? AND status='disabled' AND revision=? AND transport='hyperdrive' AND dialect=? AND config_id=? AND binding_name=?",
    [Date.now(), connectionId, expectedRevision, row.dialect, row.config_id, row.binding_name]);
  requireGate(update.meta?.changes === 1, 'activation revision conflict');

  try {
    // The only supported health path needs a D1-active connection. Keep this
    // bounded; on failure immediately CAS-disable rather than leave it enabled.
    const healthUrl = 'https://database-mcp-worker.aiyaya.workers.dev/mcp';
    let response;
    try {
      response = await request(healthUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + portalToken, Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'health_check', arguments: { connection: connectionId } } }),
        signal: AbortSignal.timeout(12000)
      });
    } catch { throw Error('MCP health request failed'); }
    requireGate(response?.ok === true, 'live MCP health was rejected');
    const raw = await response.text();
    requireGate(raw.length > 0 && raw.length <= 16384, 'invalid bounded MCP health result');
    let message;
    try {
      const frames = response.headers?.get?.('content-type')?.includes('text/event-stream')
        ? raw.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
        : [raw];
      message = frames.map(v => JSON.parse(v)).find(v => v?.id === 1);
    } catch { throw Error('Unrecognized MCP health response'); }
    const tool = message?.result;
    let value = tool?.structuredContent;
    if (!value && Array.isArray(tool?.content)) {
      try { value = JSON.parse(tool.content.find(c => c.type === 'text')?.text); } catch { /* fail below */ }
    }
    requireGate(!message?.error && !tool?.isError && value?.ok === true &&
      value?.connection === connectionId && value?.transport === 'hyperdrive' &&
      value?.dialect === row.dialect, 'live MCP health did not verify approved origin');
    await verifyCloudAndBinding();
  } catch {
    let disabled = false;
    try {
      const revert = await sql("UPDATE database_connections SET status='disabled',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='active' AND transport='hyperdrive' AND config_id=? AND binding_name=?",
        [Date.now(), connectionId, Number(expectedRevision) + 1, row.config_id, row.binding_name]);
      disabled = revert.meta?.changes === 1;
      if (!disabled) {
        const state = await sql('SELECT status FROM database_connections WHERE id=?', [connectionId]);
        disabled = state.results?.length === 1 && state.results[0]?.status === 'disabled';
      }
    } catch { /* surface fail-closed uncertainty, never claim rollback success */ }
    throw Error(disabled
      ? 'Database activation blocked: health/readback failed; connection CAS-disabled'
      : 'Database activation unsafe: post-check failed and disable was not confirmed; manual intervention required');
  }
  return { activated: true, connectionId, revision: Number(expectedRevision) + 1 };
}

export async function main() {
  const source = readConfiguration('database-mcp-worker',
    await readFile(new URL('../apps/database-mcp-worker/wrangler.jsonc', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(
    new URL('../apps/database-mcp-worker/hyperdrive-bindings.json', import.meta.url), 'utf8'));
  await activateDatabaseHyperdrive({
    connectionId: process.env.DATABASE_ACTIVATION_ID,
    expectedRevision: process.env.DATABASE_ACTIVATION_REVISION,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    portalToken: process.env.MCP_ACCESS_TOKEN,
    actor: process.env.GITHUB_ACTOR,
    ref: process.env.GITHUB_REF,
    sourceSha: process.env.GITHUB_SHA,
    source, manifest
  });
  process.stdout.write('Database Hyperdrive activated with protected Cloudflare readback and live MCP health.\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Database Hyperdrive activation: BLOCKED (details withheld).\n');
    process.exitCode = 1;
  });
}
