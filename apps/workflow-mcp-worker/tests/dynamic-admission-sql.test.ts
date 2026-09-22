import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { admitManualWorkflow } from '../src/admission.js';
import type { PublicWorkflowError } from '../src/admission.js';
import { getWorkflowRegistry } from '../src/registry.js';
import type { Env } from '../src/types.js';

const original = getWorkflowRegistry().find(item => item.metadata.id === 'local-http-smoke')!;

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_core.sql', '0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql', '0009_active_definitions.sql']) {
    sqlite.exec(readFileSync('migrations/' + migration, 'utf8'));
  }
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...(args as Array<string | number | bigint | null>)) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as Array<string | number | bigint | null>)) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...(args as Array<string | number | bigint | null>)).changes } })
  });
  const db = {
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
  let starts = 0;
  let lostResponse = false;
  const env = {
    DB: db,
    DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true',
    DYNAMIC_WORKFLOW_ADMISSION_ENABLED: 'true',
    WORKFLOW: {
      createBatch: async (_instances: Array<{ id: string; params: { runId: string } }>) => {
        starts++;
        if (lostResponse) {
          lostResponse = false;
          throw new Error('simulated lost createBatch response');
        }
      }
    }
  } as unknown as Env;
  const save = (digest: string, plan: unknown) => {
    const now = '2026-09-22';
    sqlite.prepare(
      `INSERT INTO workflow_definition_versions
       (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
       VALUES (?, ?, 1, ?, ?, ?)`
    ).run(digest, original.metadata.id, JSON.stringify(plan), original.sourcePath, now);
    sqlite.prepare(
      `INSERT INTO definition_publications
       (publication_id, workflow_id, definition_digest, source_sha, repository_id,
        publisher_run_id, publisher_run_attempt, publisher_workflow_sha, policy_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?)`
    ).run('pub-' + digest.slice(0, 16), original.metadata.id, digest,
      digest.slice(0, 40), '1371085786', '1234', 'trusted', now);
  };
  save(original.definitionDigest, original.plan);
  sqlite.prepare(
    `INSERT INTO workflow_active_definitions
     (workflow_id, active_digest, registry_revision, state, activated_at, updated_at)
     VALUES (?, ?, 1, 'enabled', ?, ?)`
  ).run(original.metadata.id, original.definitionDigest, '2026-09-22', '2026-09-22');
  const change = (digest: string | null, revision: number) => {
    sqlite.prepare(
      'UPDATE workflow_active_definitions SET active_digest = ?, registry_revision = ?, state = ? WHERE workflow_id = ?'
    ).run(digest, revision, digest ? 'enabled' : 'disabled', original.metadata.id);
  };
  return { sqlite, db, env, save, change, starts: () => starts, loseNextResponse: () => { lostResponse = true; } };
}

const input = { url: 'https://example.test/' };

describe('T06 gated, immutable D1 manual admission', () => {
  it('returns original Run and digest on the same key after an update, disable and rollback', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'repeat-1');
      expect(first).toMatchObject({
        alreadyAdmitted: false, definitionDigest: original.definitionDigest, state: 'queued'
      });
      const alternative = JSON.parse(JSON.stringify(original.plan)) as Record<string, unknown>;
      alternative.name = 'Second approved revision';
      const digest = 'a'.repeat(64);
      f.save(digest, alternative);
      f.change(digest, 2);
      const updated = await admitManualWorkflow(f.env, original.metadata.id, input, 'repeat-1');
      expect(updated).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      f.change(null, 3);
      const disabled = await admitManualWorkflow(f.env, original.metadata.id, input, 'repeat-1');
      expect(disabled).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      await expect(admitManualWorkflow(f.env, original.metadata.id, input, 'new-key'))
        .rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' } satisfies Partial<PublicWorkflowError>);
      f.change(original.definitionDigest, 4);
      const rolledBack = await admitManualWorkflow(f.env, original.metadata.id, input, 'repeat-1');
      expect(rolledBack.runId).toBe(first.runId);
      const count = f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get() as { count: number };
      expect(count.count).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('returns terminal historical Run without another Workflow start after deactivation', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'terminal-key');
      f.sqlite.prepare(
        "UPDATE workflow_runs SET state = 'succeeded', output_json = ? WHERE run_id = ?"
      ).run(JSON.stringify({ answer: 42 }), first.runId);
      f.change(null, 2);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'terminal-key');
      expect(replay).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest,
        alreadyAdmitted: true, state: 'succeeded'
      });
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('rejects an activation race without writing an admission or starting an instance', async () => {
    const f = fixture();
    try {
      const baseBatch = f.db.batch.bind(f.db);
      const racingDb = {
        prepare: f.db.prepare.bind(f.db),
        batch: async (commands: Parameters<D1Database['batch']>[0]) => {
          f.change(null, 2);
          return baseBatch(commands);
        }
      } as D1Database;
      await expect(admitManualWorkflow({ ...f.env, DB: racingDb }, original.metadata.id,
        input, 'racing-key')).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get() as { count: number }).count)
        .toBe(0);
      expect(f.starts()).toBe(0);
    } finally { f.sqlite.close(); }
  });

  it('reuses the durable original Run after an uncertain external create response', async () => {
    const f = fixture();
    try {
      f.loseNextResponse();
      await expect(admitManualWorkflow(f.env, original.metadata.id, input, 'lost-start'))
        .rejects.toThrow('simulated lost createBatch response');
      const existing = f.sqlite.prepare(
        'SELECT run_id, definition_digest FROM workflow_runs'
      ).get() as { run_id: string; definition_digest: string };
      f.change(null, 2);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'lost-start');
      expect(replay).toMatchObject({
        runId: existing.run_id, definitionDigest: existing.definition_digest, alreadyAdmitted: true
      });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get() as { count: number }).count)
        .toBe(1);
      expect(f.starts()).toBe(2);
    } finally { f.sqlite.close(); }
  });
});
