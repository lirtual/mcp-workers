import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { seedLegacyDefinitions } from '../src/legacy-import-storage.js';
import { prepareLegacyImport, type LegacyImportState } from '../src/legacy-import.js';
import { verifyLegacyPublicationReadiness } from '../src/legacy-cutover.js';

const scheduleKey = 'raindrop-daily-snapshot:daily-nine';
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_core.sql', '0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql', '0009_active_definitions.sql']) {
    sqlite.exec(readFileSync('migrations/' + migration, 'utf8'));
  }
  sqlite.prepare(
    `INSERT INTO scheduler_state
     (schedule_key, last_evaluated_at, last_admitted_scheduled_time, next_due_occurrence)
     VALUES (?, ?, ?, ?)`
  ).run(scheduleKey, 1_790_000_000_000, 1_789_999_940_000, 1_790_000_060_000);
  sqlite.prepare(
    'INSERT INTO connection_config_versions (connection_id, version, config_json, created_at) VALUES (?, 1, ?, ?)'
  ).run('raindrop', '{}', '2026-09-23');
  sqlite.prepare(
    `INSERT INTO connection_controls
     (connection_id, current_version, revision, disabled, allowed_tools_json, updated_at)
     VALUES (?, 1, 1, 0, ?, ?)`
  ).run('raindrop', JSON.stringify({ list_raindrops: ['read'] }), '2026-09-23');
  type Arg = string | number | bigint | null;
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...(args as Arg[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as Arg[])) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...(args as Arg[])).changes } })
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (queries: Array<{ run(): Promise<{ meta: { changes: number } }> }>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const query of queries) results.push(await query.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  } as unknown as D1Database;
  const state: LegacyImportState = {
    definitions: [], active: [],
    scheduler: [{
      scheduleKey, lastEvaluatedAt: 1_790_000_000_000,
      lastAdmittedScheduledTime: 1_789_999_940_000,
      nextDueOccurrence: 1_790_000_060_000
    }],
    nonterminal: [],
    // Only raindrop has a matching enabled connection_controls row in this D1.
    approvedConnectionIds: ['raindrop']
  };
  return { sqlite, db, state };
}

describe('T10 additive isolated D1 legacy definition seeding', () => {
  it('imports once, verifies original digests, and leaves active, Run and scheduler data untouched', async () => {
    const { sqlite, db, state } = fixture();
    try {
      expect(await seedLegacyDefinitions(db, state, 1)).toEqual({
        definitionsVerified: 4, inserted: 4,
        preservedScheduleKey: scheduleKey, readerGateChanged: false
      });
      expect(await seedLegacyDefinitions(db, {
        ...state,
        definitions: sqlite.prepare(
          'SELECT definition_digest AS definitionDigest, workflow_id AS workflowId, dsl_version AS dslVersion, normalized_plan_json AS normalizedPlanJson, source_path AS sourcePath FROM workflow_definition_versions'
        ).all() as unknown as LegacyImportState['definitions']
      }, 1)).toMatchObject({ inserted: 0, definitionsVerified: 4 });
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_active_definitions')
        .get() as { count: number }).count).toBe(0);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(0);
      expect(sqlite.prepare('SELECT * FROM scheduler_state').all()).toEqual([{
        schedule_key: scheduleKey, last_evaluated_at: 1_790_000_000_000,
        last_admitted_scheduled_time: 1_789_999_940_000,
        next_due_occurrence: 1_790_000_060_000
      }]);
    } finally { sqlite.close(); }
  });

  it('does not change an existing nonterminal Run pinned to the original legacy definition', async () => {
    const { sqlite, db, state } = fixture();
    try {
      const original = prepareLegacyImport(state).definitions.find(
        row => row.workflowId === 'local-http-smoke')!;
      sqlite.prepare(
        `INSERT INTO workflow_definition_versions
         (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(original.definitionDigest, original.workflowId, original.dslVersion,
        original.normalizedPlanJson, original.sourcePath, '2026-09-21');
      sqlite.prepare(
        `INSERT INTO workflow_runs
         (run_id, workflow_id, definition_digest, input_json, trigger_json, state,
          engine_version, cf_workflow_instance_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`
      ).run('run_legacy_waiting', original.workflowId, original.definitionDigest,
        JSON.stringify({ url: 'https://example.com/' }), JSON.stringify({ type: 'manual' }),
        'old-worker-version', 'run_legacy_waiting', '2026-09-21');
      const before = sqlite.prepare('SELECT * FROM workflow_runs WHERE run_id = ?')
        .get('run_legacy_waiting');
      const imported = await seedLegacyDefinitions(db, {
        ...state,
        definitions: [{
          definitionDigest: original.definitionDigest, workflowId: original.workflowId,
          dslVersion: original.dslVersion, normalizedPlanJson: original.normalizedPlanJson,
          sourcePath: original.sourcePath
        }],
        nonterminal: [{
          runId: 'run_legacy_waiting', definitionDigest: original.definitionDigest,
          dslVersion: 1, normalizedPlanJson: original.normalizedPlanJson,
          manifestVersions: [], hasInvalidManifest: false
        }]
      }, 1);
      expect(imported).toMatchObject({ definitionsVerified: 4, inserted: 3, readerGateChanged: false });
      expect(sqlite.prepare('SELECT * FROM workflow_runs WHERE run_id = ?')
        .get('run_legacy_waiting')).toEqual(before);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_events')
        .get() as { count: number }).count).toBe(0);
    } finally { sqlite.close(); }
  });

  it('blocks activation until an exact trusted source SHA is published at the approved revision', async () => {
    const { sqlite, db, state } = fixture();
    try {
      await seedLegacyDefinitions(db, state, 1);
      const options = {
        workflowId: 'local-http-smoke' as const,
        approvedSourceSha: 'a'.repeat(40),
        trustedPublisherRepositoryId: '123456789',
        expectedPolicyRevision: 1
      };
      await expect(verifyLegacyPublicationReadiness(db, options))
        .rejects.toThrow(/no matching trusted publication/);
      const original = prepareLegacyImport(state).definitions.find(row =>
        row.workflowId === options.workflowId)!;
      // This row simulates an already independently verified T09 OIDC stage:
      // no production or real GitHub publisher authority is exercised here.
      sqlite.prepare(
        `INSERT INTO definition_publications
         (publication_id, workflow_id, definition_digest, source_sha, repository_id,
          publisher_run_id, publisher_run_attempt, publisher_workflow_sha, policy_revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('legacy-published', options.workflowId, original.definitionDigest,
        options.approvedSourceSha, options.trustedPublisherRepositoryId,
        '10001', 1, 'b'.repeat(40), 1, '2026-09-23');
      expect(await verifyLegacyPublicationReadiness(db, options)).toEqual({
        workflowId: options.workflowId, definitionDigest: original.definitionDigest,
        publicationId: 'legacy-published', sourceSha: options.approvedSourceSha
      });
      await expect(verifyLegacyPublicationReadiness(db, {
        ...options, approvedSourceSha: 'c'.repeat(40)
      })).rejects.toThrow(/no matching trusted publication/);
      await expect(verifyLegacyPublicationReadiness(db, {
        ...options, trustedPublisherRepositoryId: '987654321'
      })).rejects.toThrow(/no matching trusted publication/);
      await expect(verifyLegacyPublicationReadiness(db, {
        ...options, expectedPolicyRevision: 2
      })).rejects.toThrow(/policy changed/);
      // A matching digest alone cannot rescue a stored plan that was modified.
      sqlite.prepare(
        'UPDATE workflow_definition_versions SET normalized_plan_json = ? WHERE definition_digest = ?'
      ).run('{}', original.definitionDigest);
      await expect(verifyLegacyPublicationReadiness(db, options))
        .rejects.toThrow(/differs from the original pinned plan/);
    } finally { sqlite.close(); }
  });

  it('rejects changed policy or cursor before any import', async () => {
    const { sqlite, db, state } = fixture();
    try {
      await expect(seedLegacyDefinitions(db, state, 2)).rejects.toThrow(/policy changed/);
      sqlite.prepare('UPDATE scheduler_state SET last_evaluated_at = last_evaluated_at + 60000')
        .run();
      await expect(seedLegacyDefinitions(db, state, 1)).rejects.toThrow(/schedule changed/);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_definition_versions')
        .get() as { count: number }).count).toBe(0);
    } finally { sqlite.close(); }
  });

  it('requires the real D1-approved connection policy, not merely a claimed snapshot', async () => {
    const { sqlite, db, state } = fixture();
    try {
      sqlite.prepare('UPDATE connection_controls SET disabled = 1 WHERE connection_id = ?')
        .run('raindrop');
      await expect(seedLegacyDefinitions(db, state, 1))
        .rejects.toThrow(/approval is missing or disabled/);
      sqlite.prepare('UPDATE connection_controls SET disabled = 0, allowed_tools_json = ? WHERE connection_id = ?')
        .run(JSON.stringify({ list_raindrops: ['unsafe_write'] }), 'raindrop');
      await expect(seedLegacyDefinitions(db, state, 1))
        .rejects.toThrow(/tool is not approved/);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_definition_versions')
        .get() as { count: number }).count).toBe(0);
    } finally { sqlite.close(); }
  });

  it('rejects a caller snapshot that hides existing nonterminal Runs', async () => {
    const { sqlite, db, state } = fixture();
    try {
      await seedLegacyDefinitions(db, state, 1);
      const definitions = sqlite.prepare(
        'SELECT definition_digest AS definitionDigest, workflow_id AS workflowId, dsl_version AS dslVersion, normalized_plan_json AS normalizedPlanJson, source_path AS sourcePath FROM workflow_definition_versions'
      ).all() as unknown as LegacyImportState['definitions'];
      const stored = definitions.find(row => row.workflowId === 'local-http-smoke')!;
      sqlite.prepare(
        `INSERT INTO workflow_runs (run_id, workflow_id, definition_digest, input_json,
         trigger_json, state, cf_workflow_instance_id, created_at)
         VALUES ('still-running', 'local-http-smoke', ?, '{}', '{"type":"manual"}',
                 'waiting', 'still-running', '2026-09-23')`
      ).run(stored.definitionDigest);
      const falseEmpty: LegacyImportState = { ...state, definitions, nonterminal: [] };
      await expect(seedLegacyDefinitions(db, falseEmpty, 1))
        .rejects.toThrow(/snapshot differs/);
      expect((sqlite.prepare(
        "SELECT state FROM workflow_runs WHERE run_id = 'still-running'"
      ).get() as { state: string }).state).toBe('waiting');
    } finally { sqlite.close(); }
  });

  it('rejects a caller snapshot that hides an existing active pointer', async () => {
    const { sqlite, db, state } = fixture();
    try {
      await seedLegacyDefinitions(db, state, 1);
      const definitions = sqlite.prepare(
        'SELECT definition_digest AS definitionDigest, workflow_id AS workflowId, dsl_version AS dslVersion, normalized_plan_json AS normalizedPlanJson, source_path AS sourcePath FROM workflow_definition_versions'
      ).all() as unknown as LegacyImportState['definitions'];
      const digest = definitions.find(row => row.workflowId === 'local-http-smoke')!.definitionDigest;
      sqlite.prepare(
        `INSERT INTO workflow_active_definitions
         (workflow_id, active_digest, registry_revision, state, activated_at, updated_at)
         VALUES ('local-http-smoke', ?, 1, 'enabled', '2026-09-23', '2026-09-23')`
      ).run(digest);
      await expect(seedLegacyDefinitions(db, { ...state, definitions, active: [] }, 1))
        .rejects.toThrow(/snapshot differs/);
      expect((sqlite.prepare(
        "SELECT active_digest FROM workflow_active_definitions WHERE workflow_id = 'local-http-smoke'"
      ).get() as { active_digest: string }).active_digest).toBe(digest);
    } finally { sqlite.close(); }
  });

  it('detects revision-only and state-only Registry changes with the same baseline', async () => {
    const { sqlite, db, state } = fixture();
    try {
      await seedLegacyDefinitions(db, state, 1);
      const definitions = sqlite.prepare(
        'SELECT definition_digest AS definitionDigest, workflow_id AS workflowId, dsl_version AS dslVersion, normalized_plan_json AS normalizedPlanJson, source_path AS sourcePath FROM workflow_definition_versions'
      ).all() as unknown as LegacyImportState['definitions'];
      const digest = definitions.find(row => row.workflowId === 'local-http-smoke')!.definitionDigest;
      sqlite.prepare(
        `INSERT INTO workflow_active_definitions
          (workflow_id, active_digest, registry_revision, state, activated_at, updated_at)
          VALUES ('local-http-smoke', ?, 1, 'enabled', '2026-09-23', '2026-09-23')`
      ).run(digest);
      const claimed: LegacyImportState = {
        ...state, definitions,
        active: [{ workflowId: 'local-http-smoke', activeDigest: digest,
          registryRevision: 1, state: 'enabled' }]
      };
      sqlite.prepare(
        "UPDATE workflow_active_definitions SET registry_revision = 2 WHERE workflow_id = 'local-http-smoke'"
      ).run();
      await expect(seedLegacyDefinitions(db, claimed, 1))
        .rejects.toThrow(/snapshot differs/);
      sqlite.prepare(
        "UPDATE workflow_active_definitions SET registry_revision = 1, active_digest = NULL, state = 'disabled' WHERE workflow_id = 'local-http-smoke'"
      ).run();
      await expect(seedLegacyDefinitions(db, claimed, 1))
        .rejects.toThrow(/snapshot differs/);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(0);
    } finally { sqlite.close(); }
  });

  it('does not claim successful cutover evidence when the Cron cursor changes during the seed', async () => {
    const { sqlite, db, state } = fixture();
    try {
      const underlyingBatch = db.batch.bind(db);
      const racing = {
        prepare: db.prepare.bind(db),
        batch: async (queries: Parameters<D1Database['batch']>[0]) => {
          const results = await underlyingBatch(queries);
          // A separate tick advances the durable cursor just after the seed
          // transaction commits; the reader still has not been enabled.
          sqlite.prepare(
            'UPDATE scheduler_state SET last_evaluated_at = last_evaluated_at + 60000 WHERE schedule_key = ?'
          ).run(scheduleKey);
          return results;
        }
      } as D1Database;
      await expect(seedLegacyDefinitions(racing, state, 1))
        .rejects.toThrow(/snapshot differs/);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_active_definitions')
        .get() as { count: number }).count).toBe(0);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_definition_versions')
        .get() as { count: number }).count).toBe(4);
    } finally { sqlite.close(); }
  });

  it('detects a concurrent immutable digest collision rather than accepting INSERT OR IGNORE', async () => {
    const { sqlite, db, state } = fixture();
    try {
      const digest = '567b8d64800fe0ff53f5b85e83fbb6e57dbc679e09f9ed77e7b717330ee0a522';
      sqlite.prepare(
        `INSERT INTO workflow_definition_versions
         (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
         VALUES (?, ?, 1, '{}', 'workflows/forged.yaml', ?)`
      ).run(digest, 'local-http-smoke', '2026-09-23');
      await expect(seedLegacyDefinitions(db, state, 1))
        .rejects.toThrow(/snapshot differs/);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_active_definitions')
        .get() as { count: number }).count).toBe(0);
    } finally { sqlite.close(); }
  });
});
