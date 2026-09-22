import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { seedLegacyDefinitions } from '../src/legacy-import-storage.js';
import type { LegacyImportState } from '../src/legacy-import.js';

const scheduleKey = 'raindrop-daily-snapshot:daily-nine';
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_core.sql', '0002_scheduler.sql', '0007_connection_versions.sql']) {
    sqlite.exec(readFileSync('migrations/' + migration, 'utf8'));
  }
  sqlite.prepare(
    `INSERT INTO scheduler_state
     (schedule_key, last_evaluated_at, last_admitted_scheduled_time, next_due_occurrence)
     VALUES (?, ?, ?, ?)`
  ).run(scheduleKey, 1_790_000_000_000, 1_789_999_940_000, 1_790_000_060_000);
  type Arg = string | number | bigint | null;
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...(args as Arg[])) ?? null,
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
    approvedConnectionIds: ['raindrop', 'workflow-self']
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
        .rejects.toThrow(/immutable definition verification/);
      expect((sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_active_definitions')
        .get() as { count: number }).count).toBe(0);
    } finally { sqlite.close(); }
  });
});
