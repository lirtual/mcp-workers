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
    if (!db) return;
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
  });

  it('rejects stale expected revision without changing pointer or recording misleading audit', async () => {
    const db = await store();
    if (!db) return;
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
});
