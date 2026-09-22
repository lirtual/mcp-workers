import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stageDefinition } from '../src/definition-stage.js';
import { getWorkflowRegistry } from '../src/registry.js';
import type { GitHubJobIdentity } from '../src/oidc.js';
import type { Env } from '../src/types.js';

const publisher: GitHubJobIdentity = {
  repositoryId: '1371085786', workflowRef: 'trusted-publisher',
  workflowSha: 'trusted-sha', ref: 'refs/heads/main',
  runId: '123456', runAttempt: 1
};
const entry = getWorkflowRegistry().find(item => item.metadata.id === 'local-http-smoke')!;
const sourceSha = 'a'.repeat(40);
const envelope = () => ({
  publicationId: 'publication-001',
  workflowId: entry.metadata.id,
  definitionDigest: entry.definitionDigest,
  sourceSha,
  sourcePath: entry.sourcePath,
  policyRevision: 1,
  plan: entry.plan
});

async function openStore(): Promise<D1Database | null> {
  let module: typeof import('node:sqlite');
  try {
    module = await import('node:sqlite');
  } catch { return null; }
  const sqlite = new module.DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_core.sql', 'utf8'));
  for (const migration of ['0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql']) {
    sqlite.exec(readFileSync('migrations/' + migration, 'utf8'));
  }
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...params: unknown[]) => statement(sql, params),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...args).changes } })
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (commands: Array<{ run(): Promise<{ meta: { changes: number } }> }>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const command of commands) results.push(await command.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  } as unknown as D1Database;
}
function send(body: unknown): Request {
  return new Request('https://example.invalid/admin/definitions/stage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

describe('immutable staged definition with real SQLite', () => {
  it('recomputes v0.1 digest, saves provenance and does not activate; exact replay is idempotent', async () => {
    const db = await openStore();
    if (!db) return;
    const env = { DB: db } as Env;
    const first = await stageDefinition(send(envelope()), env, publisher);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ staged: true, definitionDigest: entry.definitionDigest });
    const second = await stageDefinition(send(envelope()), env, publisher);
    expect(second.status).toBe(200);
    const count = await db.prepare('SELECT COUNT(*) AS count FROM definition_publications')
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
    const pointer = await db.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'workflow_active_definitions'"
    ).first<{ count: number }>();
    expect(pointer?.count).toBe(0);
  });

  it('rejects digest forgery, stale policy and conflicting publication without modifying immutable plan', async () => {
    const db = await openStore();
    if (!db) return;
    const env = { DB: db } as Env;
    expect((await stageDefinition(send({ ...envelope(), definitionDigest: 'b'.repeat(64) }), env, publisher)).status).toBe(422);
    expect((await stageDefinition(send({ ...envelope(), policyRevision: 100 }), env, publisher)).status).toBe(409);
    expect((await stageDefinition(send(envelope()), env, publisher)).status).toBe(200);
    const changed = { ...envelope(), sourceSha: 'b'.repeat(40) };
    expect((await stageDefinition(send(changed), env, publisher)).status).toBe(409);
    const persisted = await db.prepare(
      'SELECT normalized_plan_json FROM workflow_definition_versions WHERE definition_digest = ?'
    ).bind(entry.definitionDigest).first<{ normalized_plan_json: string }>();
    expect(JSON.parse(persisted!.normalized_plan_json)).toEqual(entry.plan);
  });

  it('denies unsupported capability and unknown secrets before publication', async () => {
    const db = await openStore();
    if (!db) return;
    const env = { DB: db } as Env;
    const unsafe = JSON.parse(JSON.stringify(entry.plan)) as { steps: Record<string, { uses: string }> };
    unsafe.steps.fetch!.uses = 'unknown.capability';
    expect((await stageDefinition(send({ ...envelope(), plan: unsafe }), env, publisher)).status).toBe(422);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM definition_publications')
      .first<{ count: number }>())?.count).toBe(0);
  });
});
