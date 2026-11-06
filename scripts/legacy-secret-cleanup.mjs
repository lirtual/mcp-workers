// Spec #733: read-only guards for separately authorized Worker Secret cleanup.
// No Secret values, uploads, version creation or deployment occur in this file.
import { readFile, readdir } from 'node:fs/promises';
import { REQUIRED_SECRETS, readConfiguration, verifyBindings } from './manual-worker-release.mjs';
import {
  TERMINAL_RUN_ID, SECOND_TERMINAL_RUN_ID, THIRD_TERMINAL_RUN_ID, FOURTH_TERMINAL_RUN_ID,
  FIFTH_TERMINAL_RUN_ID, SIXTH_TERMINAL_RUN_ID, SEVENTH_TERMINAL_RUN_ID,
  NINTH_TERMINAL_RUN_ID, TENTH_TERMINAL_RUN_ID, ELEVENTH_TERMINAL_RUN_ID, TWELFTH_TERMINAL_RUN_ID,
} from './workflow-terminal-run-exception.mjs';
import { EIGHTH_MCP_RUN_ID } from './workflow-mcp-no-dispatch-proof.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const historical = [
  TERMINAL_RUN_ID, SECOND_TERMINAL_RUN_ID, THIRD_TERMINAL_RUN_ID, FOURTH_TERMINAL_RUN_ID,
  FIFTH_TERMINAL_RUN_ID, SIXTH_TERMINAL_RUN_ID, SEVENTH_TERMINAL_RUN_ID, EIGHTH_MCP_RUN_ID,
  NINTH_TERMINAL_RUN_ID, TENTH_TERMINAL_RUN_ID, ELEVENTH_TERMINAL_RUN_ID, TWELFTH_TERMINAL_RUN_ID,
];
export const CLEANUP_LEGACY_SECRETS = Object.freeze({
  'database-mcp-worker': ['DATABASE_ENCRYPTION_KEY', 'DATABASE_GITHUB_ACTIONS_TOKEN', 'DATABASE_KEY_ID'],
  'ssh-mcp-worker': ['ENCRYPTION_KEY'],
  'workflow-mcp-worker': ['MCP_PORTAL_CLIENT_SECRET', 'SESSION_RUNTIME_DATA_KEY'],
});
const assert = (truth, message) => { if (!truth) throw new Error(message); };
const names = bindings => (bindings ?? []).map(b => b.name).sort();
const stable = value => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const cleanupNames = worker => CLEANUP_LEGACY_SECRETS[worker];
const expectedNames = (worker, withLegacy) => [
  ...REQUIRED_SECRETS[worker],
  ...(worker === 'database-mcp-worker' ? ['DATABASE_B2B_PASSWORD', 'DATABASE_SCRAPE_RELAY_PASSWORD'] : []),
  ...(withLegacy ? cleanupNames(worker) : []),
].sort();
const ensureUuid = value => assert(UUID.test(value ?? ''), 'Reviewed Worker version ID required');
const ensureWorker = worker => assert(Object.hasOwn(CLEANUP_LEGACY_SECRETS, worker), 'Cleanup Worker is not enabled');
const safeBinding = b => b.type === 'secret_text' ? { name: b.name, type: b.type } : b;

export function verifyCleanupRequest({ worker, phase, expectedSha, actualSha, currentVersion, candidateVersion }) {
  ensureWorker(worker);
  assert(phase === 'prepare' || phase === 'publish', 'Unsupported cleanup phase');
  assert(SHA.test(expectedSha ?? '') && expectedSha === actualSha, 'Owner-reviewed main SHA mismatch');
  ensureUuid(currentVersion);
  if (phase === 'prepare') assert(!candidateVersion, 'Prepare must not accept a candidate version');
  else { ensureUuid(candidateVersion); assert(candidateVersion !== currentVersion, 'Candidate must differ from active version'); }
  return true;
}

export function verifyCandidateVersion(worker, baseline, candidate) {
  ensureWorker(worker);
  assert(baseline?.id && candidate?.id && baseline.id !== candidate.id &&
    Number.isInteger(baseline.number) && Number.isInteger(candidate.number) &&
    candidate.number > baseline.number, 'Candidate version is not newer than reviewed active version');
  const base = baseline.resources, next = candidate.resources;
  assert(base?.script?.etag && next?.script?.etag === base.script.etag,
    'Candidate Worker code etag differs');
  assert(stable(base.script.handlers) === stable(next.script.handlers) &&
    stable(base.script.named_handlers) === stable(next.script.named_handlers) &&
    stable(base.script_runtime) === stable(next.script_runtime),
    'Candidate Worker runtime or entrypoints differ');
  const oldNames = cleanupNames(worker);
  const before = base.bindings, after = next.bindings;
  assert(Array.isArray(before) && Array.isArray(after), 'Candidate binding inventory missing');
  assert(new Set(names(before)).size === before.length && new Set(names(after)).size === after.length,
    'Duplicate Worker binding names');
  const baseSecrets = before.filter(b => b.type === 'secret_text');
  const nextSecrets = after.filter(b => b.type === 'secret_text');
  assert(stable(names(baseSecrets)) === stable(expectedNames(worker, true)) &&
    stable(names(nextSecrets)) === stable(expectedNames(worker, false)),
    'Candidate Secret inventory differs from the exact reviewed deletion set');
  const normalized = bs => bs.filter(b => !oldNames.includes(b.name))
    .map(safeBinding).sort((a, b) => a.name.localeCompare(b.name));
  assert(stable(normalized(before)) === stable(after.map(safeBinding).sort((a, b) => a.name.localeCompare(b.name))),
    'Candidate changes resources, Variables or retained binding metadata');
  return true;
}

// The /settings and /secrets endpoints describe the latest uploaded version,
// which may be an *undeployed* cleanup candidate. The deployed version is the
// authoritative production baseline; only a separately reviewed candidate
// may explain the latest configuration after Prepare.
export function verifyScopedCleanupInventory(worker, baseline, candidate, settings, inventory) {
  ensureWorker(worker);
  const deployed = baseline?.resources?.bindings;
  const latest = candidate ? candidate?.resources?.bindings : deployed;
  assert(Array.isArray(deployed) && Array.isArray(latest) &&
    Array.isArray(settings?.bindings) && Array.isArray(inventory),
    'Version-scoped cleanup inventory unavailable');
  const actualSecrets = bindings => bindings.filter(b => b.type === 'secret_text').map(b => b.name).sort();
  assert(new Set(names(deployed)).size === deployed.length &&
    new Set(names(latest)).size === latest.length &&
    stable(actualSecrets(deployed)) === stable(expectedNames(worker, true)),
    'Deployed version Secret inventory differs from reviewed baseline');
  if (candidate) verifyCandidateVersion(worker, baseline, candidate);
  const signature = bindings => bindings.map(b => [b.name, b.type]).sort((a, b) => a[0].localeCompare(b[0]));
  assert(stable(signature(settings.bindings)) === stable(signature(latest)) &&
    stable(inventory.map(s => s.name).sort()) === stable(actualSecrets(latest)) &&
    new Set(inventory.map(s => s.name)).size === inventory.length,
    'Latest Worker Settings/Secrets do not match the reviewed version');
  return { bindings: deployed, secrets: deployed.filter(b => b.type === 'secret_text')
    .map(b => ({ name: b.name, type: b.type })) };
}

export function verifyLiveVersion(deployments, expectedVersion) {
  ensureUuid(expectedVersion);
  const rows = deployments?.deployments;
  assert(Array.isArray(rows) && rows.length === 1 &&
    Array.isArray(rows[0]?.versions) && rows[0].versions.length === 1 &&
    rows[0].versions[0].percentage === 100 &&
    rows[0].versions[0].version_id === expectedVersion,
    'Active production version differs from reviewed 100% baseline');
  return true;
}

// Read-only Cloudflare API calls. The D1 POST is deliberately a fixed SELECT.
async function cloudflare(path, sql) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert(account && token, 'Protected Cloudflare read credentials unavailable');
  const url = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(account) + path;
  const response = await fetch(url, {
    method: sql ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, ...(sql ? { 'Content-Type': 'application/json' } : {}) },
    ...(sql ? { body: JSON.stringify({ sql }) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
  });
  assert(response.ok, 'Cloudflare read-only inventory unavailable (HTTP ' + response.status + ')');
  const payload = await response.json();
  assert(payload?.success === true, 'Cloudflare read-only inventory rejected');
  return payload;
}

export async function verifyWorkflowQuiet() {
  const migrations = (await readdir('apps/workflow-mcp-worker/migrations'))
    .filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert(migrations.length === 20, 'Workflow source migration inventory differs');
  const database = '/d1/database/a4a477cd-6339-478c-ab7c-f7d87bb0d772/query';
  const applied = await cloudflare(database, 'SELECT name FROM d1_migrations ORDER BY name');
  const appliedNames = applied.result?.[0]?.results?.map(row => row.name);
  assert(stable(appliedNames) === stable(migrations), 'Workflow D1 applied migration names differ');
  const checked = historical.map(id => "'" + id + "'").join(',');
  const sql = `SELECT
    (SELECT COUNT(*) FROM runs WHERE outcome IS NULL OR outcome NOT IN ('succeeded','failed','cancelled')) AS nonterminal_runs,
    (SELECT COUNT(*) FROM runs WHERE (outcome IS NULL OR outcome NOT IN ('succeeded','failed','cancelled')) AND id NOT IN (${checked})) AS unreviewed_runs,
    (SELECT COUNT(*) FROM session_executions WHERE state != 'terminated') AS active_sessions,
    (SELECT state FROM cloudflare_action_gate WHERE id=1) AS admission_gate`;
  const counts = (await cloudflare(database, sql)).result?.[0]?.results?.[0];
  assert(counts?.nonterminal_runs === 12 && counts.unreviewed_runs === 0 &&
    counts.active_sessions === 0 && counts.admission_gate === 'open',
    'Workflow historical Run, active Session or admission-gate drift');
  for(const status of ['queued','running','paused','waiting','rollingBack']) {
    const response = await cloudflare('/workflows/workflow-mcp-orchestrator/instances?status=' +
      encodeURIComponent(status) + '&per_page=100');
    const items = Array.isArray(response.result) ? response.result : response.result?.instances;
    assert(Array.isArray(items) && items.length === 0 &&
      (response.result_info == null || response.result_info.total_count === 0) &&
      !response.result?.cursor && !response.result?.next_cursor,
      'Active native Workflow instance or incomplete instance inventory');
  }
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  assert(['preflight', 'candidate'].includes(mode), 'Cleanup helper is inventory-only');
  ensureWorker(worker);
  assert(process.env.GITHUB_REPOSITORY === 'lirtual/mcp-workers' &&
    process.env.GITHUB_REF === 'refs/heads/main' &&
    process.env.GITHUB_ACTOR === 'lirtual',
    'Cleanup must use the protected Owner main workflow');
  const phase = process.env.LEGACY_CLEANUP_MODE;
  const expected = process.env.EXPECTED_ACTIVE_VERSION;
  const candidateId = process.env.CANDIDATE_VERSION_ID || '';
  verifyCleanupRequest({
    worker, phase,
    expectedSha: process.env.EXPECTED_SOURCE_SHA, actualSha: process.env.GITHUB_SHA,
    currentVersion: expected, candidateVersion: phase === 'publish' ? candidateId : '',
  });
  if (mode === 'candidate') assert(UUID.test(candidateId),
    'Candidate verification requires reviewed version ID');
  const path = '/workers/scripts/' + encodeURIComponent(worker);
  const [deploy, current, settings, secretInventory] = await Promise.all([
    cloudflare(path + '/deployments?per_page=1'),
    cloudflare(path + '/versions/' + expected),
    cloudflare(path + '/settings'),
    cloudflare(path + '/secrets'),
  ]);
  assert(current.result?.id === expected, 'Reviewed Worker version does not exist');
  verifyLiveVersion(deploy.result, expected);
  const candidate = candidateId
    ? (await cloudflare(path + '/versions/' + candidateId)).result : null;
  if (candidateId) assert(candidate?.id === candidateId,
    'Cloudflare candidate identity differs from reviewed UUID');
  const deployed = verifyScopedCleanupInventory(worker, current.result, candidate,
    settings.result, secretInventory.result);
  const config = readConfiguration(worker, await readFile('apps/' + worker + '/wrangler.jsonc', 'utf8'));
  // Validate the deployed baseline, not latest Settings (which reflect an
  // undeployed candidate). Post-publish cleanup-readback enforces absence.
  verifyBindings(worker, { ...settings.result, bindings: deployed.bindings }, deployed.secrets, {
    mode: 'readback',
    sourceConfig: config,
    ...(worker === 'database-mcp-worker' ? {
      databaseConnections: process.env.DATABASE_CONNECTIONS,
      databaseVariables: { DB_HOST: process.env.DB_HOST },
    } : {}),
    ...(worker === 'workflow-mcp-worker' ? {
      expectedWorkflowPortalClientId: process.env.WORKFLOW_MCP_PORTAL_CLIENT_ID,
      expectedWorkflowGrants: process.env.WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES,
    } : {}),
  });
  if (worker === 'workflow-mcp-worker') await verifyWorkflowQuiet();
  console.log('Spec 733 cleanup ' + mode + ' PASS; Worker=' + worker +
    '; baseline=' + expected + (candidateId ? '; candidate=' + candidateId : '') +
    '; 100% active baseline unchanged; no Secret values read');
}

if (process.argv[1]?.endsWith('/legacy-secret-cleanup.mjs'))
  main().catch(error => { console.error('Cleanup gate blocked: ' + error.message); process.exitCode = 1; });
