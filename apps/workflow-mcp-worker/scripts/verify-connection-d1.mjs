/* global URL, Request, Response, Headers, Buffer, TextEncoder, console */
// Node 24 / GitHub Actions: real SQLite verification of the exact D1 migration
// and admin SQL, without connecting to any remote Cloudflare environment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { registerApprovedConnection } from '../src/connection-admin.ts';
import { handleAdminRoute } from '../src/admin-routes.ts';
import { resolveRunConnectionPin, readLiveConnectionControl } from '../src/connection-revocation.ts';
import { callMcpTool, McpConnectionDeniedError } from '../src/mcp-client.ts';
import { resolveStepExecutionPolicy } from '../src/step-policy.ts';
import { getWorkflowRegistry } from '../src/registry.ts';
import { GITHUB_EXECUTOR_CONFIG } from '../src/platform-config.ts';

const crypto = globalThis.crypto ?? webcrypto;
const sqlite = new DatabaseSync(':memory:');
for (let index = 1; index <= 8; index++) {
  const files = {
    1: '0001_core.sql', 2: '0002_scheduler.sql', 3: '0003_mcp_dependencies.sql',
    4: '0004_remote_executor.sql', 5: '0005_artifacts.sql',
    6: '0006_provenance.sql', 7: '0007_connection_versions.sql',
    8: '0008_definition_publications.sql'
  };
  sqlite.exec(readFileSync(new URL('../migrations/' + files[index], import.meta.url), 'utf8'));
}
function bindSql(sql, args) {
  const statement = sqlite.prepare(sql);
  return {
    first: async () => statement.get(...args) ?? null,
    all: async () => ({ results: statement.all(...args) }),
    run: async () => ({ meta: { changes: Number(statement.run(...args).changes) } })
  };
}
let transactionTail = Promise.resolve();
const db = {
  prepare(sql) {
    return { bind: (...args) => bindSql(sql, args), ...bindSql(sql, []) };
  },
  async batch(statements) {
    // A single SQLite connection cannot start nested transactions. Serialize
    // transactions while preserving the competing requests' stale pre-read.
    const previous = transactionTail;
    let release;
    transactionTail = new Promise(resolve => { release = resolve; });
    await previous;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      sqlite.exec('COMMIT');
      return result;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    } finally {
      release();
    }
  }
};
function request(path, payload, bearer) {
  return new Request('https://example.test' + path, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {})
    }, body: JSON.stringify(payload)
  });
}
const initial = { actionId: 'register-1', connectionId: 'raindrop',
  expectedRevision: 0, tools: ['list_raindrops'] };
const registered = await registerApprovedConnection(request('/admin/connections/register', initial), db);
assert.equal(registered.status, 200, await registered.text());
assert.equal((await readLiveConnectionControl(db, 'raindrop')).disabled, false);
assert.equal(sqlite.prepare('SELECT revision FROM connection_policy_revision').get().revision, 2);
const retry = await registerApprovedConnection(request('/admin/connections/register', initial), db);
assert.equal(retry.status, 200);
assert.equal(sqlite.prepare('SELECT revision FROM connection_policy_revision').get().revision, 2);
assert.equal((await registerApprovedConnection(request('/admin/connections/register',
  { ...initial, tools: ['unknown_tool'] }), db)).status, 403);

const now = new Date().toISOString();
sqlite.prepare(`INSERT INTO workflow_definition_versions
  (definition_digest,workflow_id,dsl_version,normalized_plan_json,source_path,created_at)
  VALUES ('digest','test',1,'{}','test.yml',?)`).run(now);
sqlite.prepare(`INSERT INTO workflow_runs
  (run_id, workflow_id, definition_digest, input_json, trigger_json, state,
   engine_version, cf_workflow_instance_id, created_at, connection_versions_json)
  VALUES ('old-run','test','digest','{}','{}','running','test','old-run',?,'{"raindrop":1}')`).run(now);
const pinned = await resolveRunConnectionPin(db, 'old-run', 'raindrop', 'list_raindrops', 'read');
assert.equal(pinned.version, 1);
// Publish a newer approved revision. The existing Run still uses revision 1.
const updated = await registerApprovedConnection(request('/admin/connections/register',
  { ...initial, actionId: 'register-2', expectedRevision: 1 }), db);
assert.equal(updated.status, 200, await updated.text());
assert.equal(sqlite.prepare('SELECT current_version FROM connection_controls').get().current_version, 2);
assert.equal((await resolveRunConnectionPin(db, 'old-run', 'raindrop', 'list_raindrops', 'read')).version, 1);
assert.equal(sqlite.prepare('SELECT revision FROM connection_policy_revision').get().revision, 3);

const workflowRef = 'lirtual/mcp-workers/.github/workflows/workflow-mcp-publisher.yml@refs/heads/main';
const pair = await crypto.subtle.generateKey({
  name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'
}, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
publicKey.kid = 'test-key';
const nowSeconds = 1_800_000_000;
const encoded = x => Buffer.from(JSON.stringify(x)).toString('base64url');
async function token() {
  const head = encoded({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const body = encoded({
    iss: GITHUB_EXECUTOR_CONFIG.oidc.issuer, aud: 'workflow-mcp-publisher',
    exp: nowSeconds + 300, nbf: nowSeconds - 10, iat: nowSeconds - 10,
    repository_id: '1371085786', workflow_ref: workflowRef,
    ref: 'refs/heads/main', workflow_sha: 'trusted-sha',
    run_id: '12345', run_attempt: '1'
  });
  const signed = head + '.' + body;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey,
    new TextEncoder().encode(signed));
  return signed + '.' + Buffer.from(signature).toString('base64url');
}
const bearer = await token();
const env = {
  DB: db, MCP_ACCESS_TOKEN: 'sensitive-do-not-persist',
  ADMIN_PUBLISHER_REPOSITORY_ID: '1371085786',
  ADMIN_PUBLISHER_WORKFLOW_REF: workflowRef,
  ADMIN_PUBLISHER_REF: 'refs/heads/main',
  ADMIN_PUBLISHER_WORKFLOW_SHA: 'trusted-sha'
};
const opts = { nowSeconds, fetchImpl: async () => Response.json({ keys: [publicKey] }) };
async function admin(path, body) {
  return handleAdminRoute(request(path, body, bearer), env, opts);
}
const before = await handleAdminRoute(new Request('https://example.test/admin/connections/snapshot',
  { headers: { Authorization: 'Bearer ' + bearer } }), env, opts);
assert.equal(before.status, 200);
assert.equal((await before.json()).revision, 3);
// Secret rotation is evaluated at use, without changing immutable D1 metadata.
env.MCP_ACCESS_TOKEN = 'rotated-test-token';
const successful = [];
const successFetch = async (_url, init) => {
  const rpc = JSON.parse(String(init.body));
  successful.push(rpc.method);
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer rotated-test-token');
  if (rpc.method === 'tools/list') return Response.json({
    jsonrpc: '2.0', id: rpc.id, result: {
      tools: [{ name: 'list_raindrops', inputSchema: { type: 'object', properties: {} } }]
    }
  });
  return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [] } });
};
await callMcpTool(env, 'raindrop', 'list_raindrops', {}, successFetch, { db, pinned });
assert.deepEqual(successful, ['tools/list', 'tools/call']);

const external = [];
const mockFetch = async (_url, init) => {
  const rpc = JSON.parse(String(init.body));
  external.push(rpc.method);
  if (rpc.method === 'tools/list') {
    const decisions = await Promise.all([
      admin('/admin/connections/disable', {
        actionId: 'disable-1', connectionId: 'raindrop', expectedRevision: 2
      }),
      admin('/admin/connections/disable', {
        actionId: 'disable-2', connectionId: 'raindrop', expectedRevision: 2
      })
    ]);
    assert.deepEqual(decisions.map(d => d.status).sort(), [200, 409]);
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: {
      tools: [{ name: 'list_raindrops', inputSchema: { type: 'object', properties: {} } }]
    } });
  }
  throw new Error('Revoked tools/call was transmitted');
};
await assert.rejects(
  () => callMcpTool(env, 'raindrop', 'list_raindrops', {}, mockFetch, { db, pinned }),
  error => error instanceof McpConnectionDeniedError
);
assert.deepEqual(external, ['tools/list']);
assert.equal(sqlite.prepare('SELECT revision FROM connection_policy_revision').get().revision, 4);
assert.equal((await readLiveConnectionControl(db, 'raindrop')).disabled, true);
const after = await handleAdminRoute(new Request('https://example.test/admin/connections/snapshot',
  { headers: { Authorization: 'Bearer ' + bearer } }), env, opts);
assert.equal(after.status, 200);
const snapshot = JSON.stringify(await after.json());
assert.ok(snapshot.includes('"revision":4'));
assert.ok(!snapshot.includes('sensitive-do-not-persist'));
assert.ok(!snapshot.includes('MCP_ACCESS_TOKEN'));
const saved = sqlite.prepare('SELECT config_json FROM connection_config_versions').get().config_json;
assert.ok(!saved.includes('sensitive-do-not-persist'));
assert.ok(!saved.includes('rotated-test-token'));
assert.ok(!snapshot.includes('rotated-test-token'));
// A disabled old Run must not leak its credential during early step discovery.
let unauthorizedDiscovery = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  unauthorizedDiscovery++;
  throw new Error('Revoked discovery contacted the remote MCP server.');
};
try {
  const decision = await resolveStepExecutionPolicy({
    env, store: { getStepRunPolicy: async () => null },
    runId: 'old-run', stepRunId: 'unstarted-step',
    definition: { uses: 'mcp.call', executor: 'cloudflare', needs: [], with: {} },
    capabilityInput: { connection: 'raindrop', tool: 'list_raindrops' }
  });
  assert.equal(decision.ok, false);
  assert.equal(unauthorizedDiscovery, 0);
} finally {
  globalThis.fetch = originalFetch;
}

const registry = getWorkflowRegistry();
const baselineCount = registry.length;
const entry = registry.find(item => item.metadata.id === 'local-http-smoke');
assert.ok(entry);
const stage = {
  workflowId: entry.metadata.id,
  definitionDigest: entry.definitionDigest,
  sourceSha: 'a'.repeat(40),
  sourcePath: entry.sourcePath,
  policyRevision: 4,
  connectionVersions: {},
  plan: entry.plan
};
const staged = await admin('/admin/definitions/stage', stage);
assert.equal(staged.status, 200, await staged.text());
const stagedReply = await staged.json();
assert.equal(stagedReply.staged, true);
assert.equal(stagedReply.alreadyStaged, false);
const repeatedStage = await admin('/admin/definitions/stage', stage);
assert.equal(repeatedStage.status, 200);
assert.equal((await repeatedStage.json()).alreadyStaged, true);
assert.equal((await admin('/admin/definitions/stage',
  { ...stage, definitionDigest: '0'.repeat(64) })).status, 400);
assert.equal((await admin('/admin/definitions/stage',
  { ...stage, policyRevision: 3 })).status, 409);
assert.equal((await admin('/admin/definitions/stage',
  { ...stage, sourceSha: 'invalid' })).status, 400);
const differingSource = await admin('/admin/definitions/stage',
  { ...stage, sourceSha: 'b'.repeat(40) });
assert.equal(differingSource.status, 200);
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM definition_publications').get().n, 2);
assert.equal(sqlite.prepare(
  'SELECT count(*) AS n FROM workflow_definition_versions WHERE definition_digest = ?'
).get(entry.definitionDigest).n, 1);
assert.equal(getWorkflowRegistry().length, baselineCount);
assert.equal(sqlite.prepare('SELECT revision FROM connection_policy_revision').get().revision, 4);
const evidence = sqlite.prepare('SELECT publisher_repository_id, publisher_run_id, publisher_run_attempt FROM definition_publications LIMIT 1').get();
assert.deepEqual(evidence, {
  publisher_repository_id: '1371085786', publisher_run_id: '12345', publisher_run_attempt: 1
});
sqlite.close();
console.log('PASS: real SQLite D1 migration, approved revision update, secret rotation, signed admin CAS, pinned Run call, revoke-before-tools/call, and immutable definition stage');
