import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { updateActiveDefinition } from '../src/active-registry-admin.js';
import { listVisibleWorkflows } from '../src/registry.js';
import { getWorkflowRegistry } from '../src/registry.js';
import type { GitHubJobIdentity } from '../src/oidc.js';
import type { Env } from '../src/types.js';

const entry = getWorkflowRegistry().find(item => item.metadata.id === 'local-http-smoke')!;
const publisher: GitHubJobIdentity = {
  repositoryId: '1371085786', workflowRef: 'trusted',
  ref: 'refs/heads/main', workflowSha: 'trusted-sha',
  runId: '123456', runAttempt: 1
};
async function store(): Promise<D1Database | null> {
  let sqlite: DatabaseSync;
  try {
    const module = await import('node:sqlite');
    sqlite = new module.DatabaseSync(':memory:');
  } catch { return null; }
  for (const name of ['0001_core.sql', '0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql',
    '0009_active_definitions.sql']) {
    sqlite.exec(readFileSync('migrations/' + name, 'utf8'));
  }
  sqlite.prepare(
    `INSERT INTO workflow_definition_versions
     (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
     VALUES (?, ?, 1, ?, ?, ?)`
  ).run(entry.definitionDigest, entry.metadata.id, JSON.stringify(entry.plan), entry.sourcePath, '2026-09-22');
  sqlite.prepare(
    `INSERT INTO definition_publications
     (publication_id, workflow_id, definition_digest, source_sha, repository_id, publisher_run_id,
      publisher_run_attempt, publisher_workflow_sha, policy_revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run('stage-1', entry.metadata.id, entry.definitionDigest, 'a'.repeat(40),
    publisher.repositoryId, publisher.runId, publisher.runAttempt, publisher.workflowSha, '2026-09-22');
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...(args as Array<string | number | bigint | null>)) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as Array<string | number | bigint | null>)) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...(args as Array<string | number | bigint | null>)).changes } })
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (commands: Array<{ run(): Promise<{ meta: { changes: number } }> }>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const command of commands) result.push(await command.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  } as unknown as D1Database;
}
function request(actionId: string, expectedDigest: string | null, targetDigest: string | null,
  expectedRevision: number): Request {
  return new Request('https://example.invalid/admin/definitions/activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actionId, workflowId: entry.metadata.id, expectedDigest, targetDigest, expectedRevision
    })
  });
}

describe('real SQLite active pointer and rollback contract', () => {
  it('activates exact staged digest, hides on deactivation and rolls back using activate', async () => {
    const db = await store();
    if (!db) throw new Error('node:sqlite is required for real CAS validation');
    const env = { DB: db, DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true' } as Env;
    expect(await listVisibleWorkflows(env)).toEqual([]);
    const first = await updateActiveDefinition(
      request('activate-1', null, entry.definitionDigest, 0), env, publisher, 'activate');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revision: 1, activeDigest: entry.definitionDigest });
    expect((await listVisibleWorkflows(env)).map(item => item.definitionDigest)).toEqual([entry.definitionDigest]);
    const duplicate = await updateActiveDefinition(
      request('activate-1', null, entry.definitionDigest, 0), env, publisher, 'activate');
    expect(duplicate.status).toBe(200);
    const disabled = await updateActiveDefinition(
      request('disable-1', entry.definitionDigest, null, 1), env, publisher, 'deactivate');
    expect(disabled.status).toBe(200);
    expect(await listVisibleWorkflows(env)).toEqual([]);
    const rollback = await updateActiveDefinition(
      request('rollback-1', null, entry.definitionDigest, 2), env, publisher, 'activate');
    expect(rollback.status).toBe(200);
    expect((await listVisibleWorkflows(env)).map(item => item.definitionDigest)).toEqual([entry.definitionDigest]);
    const events = await db.prepare('SELECT COUNT(*) AS count FROM workflow_registry_actions')
      .first<{ count: number }>();
    expect(events?.count).toBe(3);
    const history = await db.prepare(
      'SELECT action_kind, previous_digest, next_digest, expected_revision, resulting_revision FROM workflow_registry_actions ORDER BY resulting_revision'
    ).all<{
      action_kind: string; previous_digest: string | null; next_digest: string | null;
      expected_revision: number; resulting_revision: number
    }>();
    expect(history.results).toMatchObject([
      { action_kind: 'activate', previous_digest: null, next_digest: entry.definitionDigest,
        expected_revision: 0, resulting_revision: 1 },
      { action_kind: 'deactivate', previous_digest: entry.definitionDigest, next_digest: null,
        expected_revision: 1, resulting_revision: 2 },
      { action_kind: 'activate', previous_digest: null, next_digest: entry.definitionDigest,
        expected_revision: 2, resulting_revision: 3 }
    ]);
  });

  it('rejects stale expected revision without changing pointer or recording misleading audit', async () => {
    const db = await store();
    if (!db) throw new Error('node:sqlite is required for real CAS validation');
    const env = { DB: db } as Env;
    expect((await updateActiveDefinition(request('first', null, entry.definitionDigest, 0),
      env, publisher, 'activate')).status).toBe(200);
    expect((await updateActiveDefinition(request('stale', null, entry.definitionDigest, 0),
      env, publisher, 'activate')).status).toBe(409);
    const pointer = await db.prepare(
      'SELECT active_digest, registry_revision FROM workflow_active_definitions WHERE workflow_id = ?'
    ).bind(entry.metadata.id).first<{ active_digest: string; registry_revision: number }>();
    expect(pointer).toMatchObject({ active_digest: entry.definitionDigest, registry_revision: 1 });
    const count = await db.prepare('SELECT COUNT(*) AS count FROM workflow_registry_actions')
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
  it('rejects action-ID reuse with a changed request without altering the durable audit', async () => {
    const db = await store();
    if (!db) throw new Error('node:sqlite is required for real CAS validation');
    const env = { DB: db } as Env;
    expect((await updateActiveDefinition(request('same-action', null, entry.definitionDigest, 0),
      env, publisher, 'activate')).status).toBe(200);
    const conflicting = await updateActiveDefinition(
      request('same-action', entry.definitionDigest, null, 1), env, publisher, 'deactivate');
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toEqual({ error: 'action_conflict' });
    const pointer = await db.prepare(
      'SELECT state, active_digest, registry_revision FROM workflow_active_definitions WHERE workflow_id = ?'
    ).bind(entry.metadata.id).first<{ state: string; active_digest: string; registry_revision: number }>();
    expect(pointer).toMatchObject({
      state: 'enabled', active_digest: entry.definitionDigest, registry_revision: 1
    });
    expect((await db.prepare('SELECT COUNT(*) AS count FROM workflow_registry_actions')
      .first<{ count: number }>())?.count).toBe(1);
  });


  it('serializes competing first activations, leaving exactly one durable winner', async () => {
    const db = await store();
    if (!db) throw new Error('node:sqlite is required for real CAS validation');
    const env = { DB: db, DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true' } as Env;
    const [first, second] = await Promise.all([
      updateActiveDefinition(request('racing-first', null, entry.definitionDigest, 0),
        env, publisher, 'activate'),
      updateActiveDefinition(request('racing-second', null, entry.definitionDigest, 0),
        env, publisher, 'activate')
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const events = await db.prepare(
      'SELECT action_id, previous_digest, next_digest, resulting_revision FROM workflow_registry_actions'
    ).all<{ action_id: string; previous_digest: string | null; next_digest: string; resulting_revision: number }>();
    expect(events.results).toHaveLength(1);
    expect(events.results[0]).toMatchObject({
      previous_digest: null, next_digest: entry.definitionDigest, resulting_revision: 1
    });
    const pointer = await db.prepare(
      'SELECT active_digest, registry_revision FROM workflow_active_definitions WHERE workflow_id = ?'
    ).bind(entry.metadata.id).first<{ active_digest: string; registry_revision: number }>();
    expect(pointer).toMatchObject({ active_digest: entry.definitionDigest, registry_revision: 1 });
  });


  it('reconciles an identical action when D1 loses its response after commit', async () => {
    const db = await store();
    if (!db) throw new Error('node:sqlite is required for real CAS validation');
    const originalBatch = db.batch.bind(db);
    let dropResponse = true;
    const env = { DB: {
      prepare: db.prepare.bind(db),
      batch: async (statements: Parameters<D1Database['batch']>[0]) => {
        const result = await originalBatch(statements);
        if (dropResponse) {
          dropResponse = false;
          throw new Error('lost D1 response after commit');
        }
        return result;
      }
    } as D1Database } as Env;
    const first = await updateActiveDefinition(
      request('lost-response', null, entry.definitionDigest, 0), env, publisher, 'activate');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ activeDigest: entry.definitionDigest, revision: 1 });
    const replay = await updateActiveDefinition(
      request('lost-response', null, entry.definitionDigest, 0), env, publisher, 'activate');
    expect(replay.status).toBe(200);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM workflow_registry_actions')
      .first<{ count: number }>())?.count).toBe(1);
  });


  it('revalidates a revoked Connection before rolling back a previously approved version', async () => {
    const db = await store();
    if (!db) throw new Error('node:sqlite is required for real CAS validation');
    const connected = getWorkflowRegistry().find(item => item.metadata.id === 'raindrop-daily-snapshot')!;
    const connectionId = 'raindrop';
    const now = '2026-09-22T00:00:00.000Z';
    await db.prepare(
      'INSERT INTO connection_config_versions (connection_id, version, config_json, created_at) VALUES (?, 1, ?, ?)'
    ).bind(connectionId, '{}', now).run();
    await db.prepare(
      `INSERT INTO connection_controls
       (connection_id, current_version, revision, disabled, allowed_tools_json, updated_at)
       VALUES (?, 1, 1, 0, ?, ?)`
    ).bind(connectionId, JSON.stringify({ list_raindrops: ['read'] }), now).run();
    await db.prepare(
      `INSERT INTO workflow_definition_versions
       (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).bind(connected.definitionDigest, connected.metadata.id, JSON.stringify(connected.plan),
      connected.sourcePath, now).run();
    await db.prepare(
      `INSERT INTO definition_publications
       (publication_id, workflow_id, definition_digest, source_sha, repository_id,
        publisher_run_id, publisher_run_attempt, publisher_workflow_sha, policy_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind('stage-connected', connected.metadata.id, connected.definitionDigest,
      'b'.repeat(40), publisher.repositoryId, publisher.runId, publisher.runAttempt,
      publisher.workflowSha, now).run();

    const env = { DB: db, DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true' } as Env;
    const connectedRequest = (actionId: string, before: string | null,
      after: string | null, revision: number) =>
      new Request('https://example.invalid/admin/definitions/activate', {
        method: 'POST',
        body: JSON.stringify({
          actionId, workflowId: connected.metadata.id,
          expectedDigest: before, targetDigest: after, expectedRevision: revision
        })
      });
    expect((await updateActiveDefinition(
      connectedRequest('connected-first', null, connected.definitionDigest, 0),
      env, publisher, 'activate')).status).toBe(200);
    expect((await updateActiveDefinition(
      connectedRequest('connected-disable', connected.definitionDigest, null, 1),
      env, publisher, 'deactivate')).status).toBe(200);
    await db.prepare(
      'UPDATE connection_controls SET disabled = 1, revision = 2 WHERE connection_id = ?'
    ).bind(connectionId).run();
    await db.prepare(
      'UPDATE connection_policy_revision SET revision = revision + 1 WHERE singleton = 1'
    ).run();

    const denied = await updateActiveDefinition(
      connectedRequest('connected-rollback', null, connected.definitionDigest, 2),
      env, publisher, 'activate');
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ error: 'definition_not_approved' });
    expect((await db.prepare(
      'SELECT state, registry_revision FROM workflow_active_definitions WHERE workflow_id = ?'
    ).bind(connected.metadata.id).first<{ state: string; registry_revision: number }>())).toMatchObject({
      state: 'disabled', registry_revision: 2
    });
    expect((await db.prepare(
      'SELECT COUNT(*) AS count FROM workflow_registry_actions WHERE workflow_id = ?'
    ).bind(connected.metadata.id).first<{ count: number }>())?.count).toBe(2);
    expect(await listVisibleWorkflows(env)).toEqual([]);
  });

  it('rejects an unstaged target without creating a pointer or audit event', async () => {
    const db = await store();
    if (!db) throw new Error('node:sqlite is required for real CAS validation');
    const env = { DB: db } as Env;
    const response = await updateActiveDefinition(
      request('not-staged', null, 'f'.repeat(64), 0), env, publisher, 'activate');
    expect(response.status).toBe(422);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM workflow_active_definitions')
      .first<{ count: number }>())?.count).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM workflow_registry_actions')
      .first<{ count: number }>())?.count).toBe(0);
  });

});
