import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { admitManualWorkflow, admitScheduledWorkflow } from '../src/admission.js';
import { runSchedulerTick } from '../src/scheduler.js';
import { registerWorkflowTools } from '../src/mcp.js';
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
  let failBeforeCreate = false;
  let uncertainLookup = false;
  let uncertainStatus = false;
  let missingOnStatus = false;
  let restShapedMissing = false;
  const instances = new Set<string>();
  const env = {
    DB: db,
    DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true',
    DYNAMIC_WORKFLOW_ADMISSION_ENABLED: 'true',
    WORKFLOW: {
      get: async (id: string) => {
        if (uncertainLookup) throw new Error('simulated upstream timeout');
        if (restShapedMissing && !instances.has(id)) {
          throw Object.assign(new Error('workflows.api.error.instance.not_found'), { code: 10400 });
        }
        if (!instances.has(id) && !missingOnStatus) throw Object.assign(new Error('Instance does not exist'), {
          code: 'instance.not_found'
        });
        return {
          id,
          status: async () => {
            if (uncertainStatus) throw new Error('simulated status RPC timeout');
            if (missingOnStatus) {
              throw Object.assign(new Error('Instance missing on status'), {
                code: 'instance.not_found'
              });
            }
            return { status: 'queued' };
          }
        };
      },
      createBatch: async (batch: Array<{ id: string; params: { runId: string } }>) => {
        if (failBeforeCreate) {
          failBeforeCreate = false;
          throw new Error('simulated createBatch failure before persistence');
        }
        for (const instance of batch) {
          if (!instances.has(instance.id)) {
            instances.add(instance.id);
            starts++;
          }
        }
        if (lostResponse) {
          lostResponse = false;
          throw new Error('simulated lost createBatch response');
        }
        return [];
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
  return {
    sqlite, db, env, save, change, starts: () => starts,
    loseNextResponse: () => { lostResponse = true; },
    failNextCreateBeforePersistence: () => { failBeforeCreate = true; },
    loseInstance: (id: string) => { instances.delete(id); },
    failLookup: (fail: boolean) => { uncertainLookup = fail; },
    failStatus: (fail: boolean) => { uncertainStatus = fail; },
    missOnStatus: (missing: boolean) => { missingOnStatus = missing; },
    useRestShapedMissing: (enabled: boolean) => { restShapedMissing = enabled; }
  };
}

const input = { url: 'https://example.test/' };

describe('T08 dynamic scheduler runtime', () => {
  it('fails closed for schedule overflow or registry outage but continues maintenance', async () => {
    const f = fixture();
    try {
      const plan = JSON.parse(JSON.stringify(original.plan)) as Record<string, unknown>;
      plan.inputs = {};
      plan.triggers = [
        { type: 'manual' },
        { type: 'schedule', id: 'minute', cron: '* * * * *', timezone: 'UTC', misfire: 'latest' }
      ];
      const digest = 'b'.repeat(64);
      f.save(digest, plan);
      f.change(digest, 2);
      const capped = await runSchedulerTick(f.env, Date.now(),
        { maxSchedules: 0, maintenanceLimit: 1 });
      expect(capped).toEqual({
        evaluatedSchedules: 0, admittedRuns: 0, maintenanceProcessed: 0, errors: 1
      });
      const base = f.env.DB;
      const unavailable = {
        prepare: (sql: string) => {
          if (sql.includes('FROM workflow_active_definitions a')) throw new Error('registry unavailable');
          return base.prepare(sql);
        },
        batch: base.batch.bind(base)
      } as D1Database;
      const degraded = await runSchedulerTick({ ...f.env, DB: unavailable }, Date.now(),
        { maintenanceLimit: 1 });
      expect(degraded).toEqual({
        evaluatedSchedules: 0, admittedRuns: 0, maintenanceProcessed: 0, errors: 1
      });
      const dangling = {
        prepare: (sql: string) => {
          if (sql.includes('LEFT JOIN workflow_definition_versions')) {
            return { all: async () => ({ results: [{
              workflow_id: original.metadata.id, active_digest: digest,
              registry_revision: 2, normalized_plan_json: null
            }] }) };
          }
          return base.prepare(sql);
        },
        batch: base.batch.bind(base)
      } as unknown as D1Database;
      const missing = await runSchedulerTick({ ...f.env, DB: dangling }, Date.now(),
        { maintenanceLimit: 1 });
      expect(missing).toEqual({
        evaluatedSchedules: 0, admittedRuns: 0, maintenanceProcessed: 0, errors: 1
      });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(0);
    } finally { f.sqlite.close(); }
  });

  it('recovers a queued original Run after a failed external start without another admission', async () => {
    const f = fixture();
    try {
      const plan = JSON.parse(JSON.stringify(original.plan)) as Record<string, unknown>;
      plan.inputs = {};
      plan.triggers = [
        { type: 'manual' },
        { type: 'schedule', id: 'minute', cron: '* * * * *', timezone: 'UTC', misfire: 'latest' }
      ];
      const digest = 'f'.repeat(64);
      f.save(digest, plan);
      f.change(digest, 2);
      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      const key = original.metadata.id + ':minute';
      f.sqlite.prepare('INSERT INTO scheduler_state (schedule_key, last_evaluated_at) VALUES (?, ?)')
        .run(key, minute - 60_000);
      f.failNextCreateBeforePersistence();
      const failed = await runSchedulerTick(f.env, minute, { maintenanceLimit: 1 });
      expect(failed).toMatchObject({ evaluatedSchedules: 1, admittedRuns: 0, errors: 1 });
      expect(f.starts()).toBe(0);
      const admitted = f.sqlite.prepare(
        'SELECT run_id, definition_digest FROM workflow_runs'
      ).get() as { run_id: string; definition_digest: string };
      expect(admitted.definition_digest).toBe(digest);
      const recovered = await runSchedulerTick(f.env, minute, { maintenanceLimit: 1 });
      expect(recovered).toMatchObject({ evaluatedSchedules: 1, admittedRuns: 0, errors: 0 });
      expect(f.starts()).toBe(1);
      expect((f.sqlite.prepare('SELECT run_id FROM workflow_runs')
        .all() as Array<{ run_id: string }>)).toEqual([{ run_id: admitted.run_id }]);
      expect((f.sqlite.prepare(
        "SELECT COUNT(*) AS total FROM workflow_events WHERE event_type = 'run.admitted'"
      ).get() as { total: number }).total).toBe(1);
    } finally { f.sqlite.close(); }
  });
});

describe('T08 schedule edit, removal and rollback', () => {
  it('does not replay a previous cron or trigger after activation and re-addition', async () => {
    const f = fixture();
    try {
      const plan = JSON.parse(JSON.stringify(original.plan)) as Record<string, unknown>;
      plan.inputs = {};
      plan.triggers = [
        { type: 'manual' },
        { type: 'schedule', id: 'minute', cron: '* * * * *', timezone: 'UTC', misfire: 'latest' }
      ];
      const oldDigest = '1'.repeat(64);
      const newDigest = '2'.repeat(64);
      const manualDigest = '3'.repeat(64);
      f.save(oldDigest, plan);
      const edited = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
      edited.triggers = [
        { type: 'manual' },
        { type: 'schedule', id: 'minute', cron: '* * * * *',
          timezone: 'Asia/Shanghai', misfire: 'latest' }
      ];
      f.save(newDigest, edited);
      const manual = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
      manual.triggers = [{ type: 'manual' }];
      f.save(manualDigest, manual);

      const minute = Math.floor(Date.now() / 60_000) * 60_000;
      const key = original.metadata.id + ':minute';
      f.change(oldDigest, 2);
      f.sqlite.prepare('INSERT INTO scheduler_state (schedule_key, last_evaluated_at) VALUES (?, ?)')
        .run(key, minute - 2 * 60_000);
      const first = await runSchedulerTick(f.env, minute - 60_000, { maintenanceLimit: 1 });
      expect(first).toMatchObject({ admittedRuns: 1, errors: 0 });

      // A new timezone is activated at the current minute. An already-due
      // occurrence from the old version cannot be evaluated under the new one.
      f.change(newDigest, 3);
      f.sqlite.prepare('UPDATE scheduler_state SET last_evaluated_at = ? WHERE schedule_key = ?')
        .run(minute, key);
      const sameMinute = await runSchedulerTick(f.env, minute, { maintenanceLimit: 1 });
      expect(sameMinute).toMatchObject({ admittedRuns: 0, errors: 0 });
      const next = await runSchedulerTick(f.env, minute + 60_000, { maintenanceLimit: 1 });
      expect(next).toMatchObject({ admittedRuns: 1, errors: 0 });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(2);
      const replay = await runSchedulerTick(f.env, minute + 60_000, { maintenanceLimit: 1 });
      expect(replay).toMatchObject({ admittedRuns: 0, errors: 0 });

      // Removing the trigger stops new starts but retains its durable cursor.
      f.change(manualDigest, 4);
      const removed = await runSchedulerTick(f.env, minute + 2 * 60_000,
        { maintenanceLimit: 1 });
      expect(removed).toMatchObject({ evaluatedSchedules: 0, admittedRuns: 0, errors: 0 });

      // Re-add/rollback starts strictly after the new activation minute.
      f.change(oldDigest, 5);
      f.sqlite.prepare('UPDATE scheduler_state SET last_evaluated_at = ? WHERE schedule_key = ?')
        .run(minute + 2 * 60_000, key);
      const restored = await runSchedulerTick(f.env, minute + 2 * 60_000,
        { maintenanceLimit: 1 });
      expect(restored).toMatchObject({ admittedRuns: 0, errors: 0 });
      const later = await runSchedulerTick(f.env, minute + 3 * 60_000,
        { maintenanceLimit: 1 });
      expect(later).toMatchObject({ admittedRuns: 1, errors: 0 });
      const rows = f.sqlite.prepare(
        "SELECT source_key, definition_digest FROM workflow_runs ORDER BY CAST(json_extract(trigger_json, '$.scheduledTime') AS INTEGER)"
      ).all() as Array<{ source_key: string; definition_digest: string }>;
      expect(rows).toEqual([
        { source_key: String(minute - 60_000), definition_digest: oldDigest },
        { source_key: String(minute + 60_000), definition_digest: newDigest },
        { source_key: String(minute + 3 * 60_000), definition_digest: oldDigest }
      ]);
      expect(f.starts()).toBe(3);
    } finally { f.sqlite.close(); }
  });
});

describe('T08 atomic versioned schedule admission', () => {
  it('claims one occurrence in D1 and never admits a stale activation version', async () => {
    const f = fixture();
    try {
      const plan = JSON.parse(JSON.stringify(original.plan)) as Record<string, unknown>;
      plan.inputs = {};
      plan.triggers = [
        { type: 'manual' },
        { type: 'schedule', id: 'minute', cron: '* * * * *', timezone: 'UTC', misfire: 'latest' }
      ];
      const digest = 'd'.repeat(64);
      f.save(digest, plan);
      f.change(digest, 2);
      const scheduledTime = Math.floor(Date.now() / 60_000) * 60_000;
      const key = original.metadata.id + ':minute';
      f.sqlite.prepare(
        `INSERT INTO scheduler_state
         (schedule_key, last_evaluated_at, last_admitted_scheduled_time)
         VALUES (?, ?, NULL)`
      ).run(key, scheduledTime - 60_000);
      const select = { definitionDigest: digest, registryRevision: 2 };
      const first = await admitScheduledWorkflow(f.env, original.metadata.id, 'minute', scheduledTime, select);
      expect(first).toMatchObject({ definitionDigest: digest, alreadyAdmitted: false });
      expect((f.sqlite.prepare(
        'SELECT last_admitted_scheduled_time FROM scheduler_state WHERE schedule_key = ?'
      ).get(key) as { last_admitted_scheduled_time: number }).last_admitted_scheduled_time)
        .toBe(scheduledTime);
      const replay = await admitScheduledWorkflow(f.env, original.metadata.id, 'minute', scheduledTime, select);
      expect(replay).toMatchObject({ runId: first.runId, alreadyAdmitted: true });
      expect(f.starts()).toBe(1);

      f.change(null, 3);
      const historical = await admitScheduledWorkflow(f.env, original.metadata.id, 'minute', scheduledTime, select);
      expect(historical).toMatchObject({
        runId: first.runId, definitionDigest: digest, alreadyAdmitted: true
      });
      await expect(admitScheduledWorkflow(f.env, original.metadata.id, 'minute',
        scheduledTime + 60_000, select)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS total FROM workflow_runs')
        .get() as { total: number }).total).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('rejects a stale tick when activation moves the cursor before its D1 batch', async () => {
    const f = fixture();
    try {
      const plan = JSON.parse(JSON.stringify(original.plan)) as Record<string, unknown>;
      plan.inputs = {};
      plan.triggers = [
        { type: 'manual' },
        { type: 'schedule', id: 'minute', cron: '* * * * *', timezone: 'UTC', misfire: 'latest' }
      ];
      const digest = 'e'.repeat(64);
      f.save(digest, plan);
      f.change(digest, 2);
      const scheduledTime = Math.floor(Date.now() / 60_000) * 60_000;
      const key = original.metadata.id + ':minute';
      f.sqlite.prepare(
        'INSERT INTO scheduler_state (schedule_key, last_evaluated_at) VALUES (?, ?)'
      ).run(key, scheduledTime - 60_000);
      const baseBatch = f.db.batch.bind(f.db);
      let cutover = false;
      const racing = {
        prepare: f.db.prepare.bind(f.db),
        batch: async (commands: Parameters<D1Database['batch']>[0]) => {
          if (!cutover) {
            cutover = true;
            f.sqlite.prepare(
              'UPDATE scheduler_state SET last_evaluated_at = ? WHERE schedule_key = ?'
            ).run(scheduledTime, key);
          }
          return baseBatch(commands);
        }
      } as D1Database;
      await expect(admitScheduledWorkflow({ ...f.env, DB: racing },
        original.metadata.id, 'minute', scheduledTime, {
          definitionDigest: digest, registryRevision: 2
        })).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS total FROM run_admissions')
        .get() as { total: number }).total).toBe(0);
      expect(f.starts()).toBe(0);
    } finally { f.sqlite.close(); }
  });
});

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
      const admittedEvents = f.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM workflow_events WHERE run_id = ? AND event_type = 'run.admitted'"
      ).get(first.runId) as { count: number };
      expect(admittedEvents.count).toBe(1);
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

  it('keeps the seven-tool MCP surface and pins workflow_run to D1 digest', async () => {
    const f = fixture();
    try {
      type Reply = { structuredContent?: unknown; isError?: boolean };
      const handlers = new Map<string, (args: unknown) => Promise<Reply>>();
      const server = { registerTool: (name: string, _config: unknown,
        handler: (args: unknown) => Promise<Reply>) => { handlers.set(name, handler); } };
      registerWorkflowTools(server as unknown as Parameters<typeof registerWorkflowTools>[0], f.env);
      expect([...handlers.keys()].sort()).toEqual([
        'workflow_cancel', 'workflow_get', 'workflow_list', 'workflow_logs',
        'workflow_result', 'workflow_run', 'workflow_status'
      ]);
      const call = (name: string, args: unknown) => handlers.get(name)!(args);
      const first = await call('workflow_run', {
        workflow: original.metadata.id, input, idempotencyKey: 'mcp-pinned-1'
      });
      expect(first.isError).not.toBe(true);
      const data = first.structuredContent as { runId: string; definitionDigest: string; alreadyAdmitted: boolean };
      expect(data).toMatchObject({ definitionDigest: original.definitionDigest, alreadyAdmitted: false });
      f.change(null, 2);
      const repeated = await call('workflow_run', {
        workflow: original.metadata.id, input, idempotencyKey: 'mcp-pinned-1'
      });
      expect(repeated.structuredContent).toMatchObject({
        runId: data.runId, definitionDigest: data.definitionDigest, alreadyAdmitted: true
      });
      expect((await call('workflow_status', { runId: data.runId })).structuredContent)
        .toMatchObject({ runId: data.runId, definitionDigest: data.definitionDigest });
      expect((await call('workflow_list', {})).structuredContent).toEqual({ workflows: [] });
      expect((await call('workflow_get', { workflow: original.metadata.id })).isError).toBe(true);
      expect((await call('workflow_logs', { runId: data.runId })).isError).not.toBe(true);
    } finally { f.sqlite.close(); }
  });

  it('rejects a stale Connection policy revision before any new admission side effect', async () => {
    const f = fixture();
    try {
      const baseBatch = f.db.batch.bind(f.db);
      let changed = false;
      const racingDb = {
        prepare: f.db.prepare.bind(f.db),
        batch: async (commands: Parameters<D1Database['batch']>[0]) => {
          if (!changed) {
            changed = true;
            f.sqlite.prepare(
              'UPDATE connection_policy_revision SET revision = revision + 1 WHERE singleton = 1'
            ).run();
          }
          return baseBatch(commands);
        }
      } as D1Database;
      await expect(admitManualWorkflow({ ...f.env, DB: racingDb },
        original.metadata.id, input, 'stale-policy')).rejects.toMatchObject({
        code: 'REGISTRY_CONFLICT'
      });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM run_admissions')
        .get() as { count: number }).count).toBe(0);
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(0);
      expect(f.starts()).toBe(0);
      const retry = await admitManualWorkflow(f.env, original.metadata.id, input, 'stale-policy');
      expect(retry).toMatchObject({
        definitionDigest: original.definitionDigest, alreadyAdmitted: false
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

  it('pins the winning revision during an activate/admit interleaving and retries cleanly', async () => {
    const f = fixture();
    try {
      const second = JSON.parse(JSON.stringify(original.plan)) as Record<string, unknown>;
      second.name = 'Later approved definition';
      const nextDigest = 'b'.repeat(64);
      f.save(nextDigest, second);
      const baseBatch = f.db.batch.bind(f.db);
      let switched = false;
      const racingDb = {
        prepare: f.db.prepare.bind(f.db),
        batch: async (commands: Parameters<D1Database['batch']>[0]) => {
          if (!switched) {
            switched = true;
            f.change(nextDigest, 2);
          }
          return baseBatch(commands);
        }
      } as D1Database;
      await expect(admitManualWorkflow({ ...f.env, DB: racingDb }, original.metadata.id,
        input, 'stale-revision')).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' });
      const accepted = await admitManualWorkflow(f.env, original.metadata.id, input, 'new-revision');
      expect(accepted).toMatchObject({ definitionDigest: nextDigest, alreadyAdmitted: false });
      const rows = f.sqlite.prepare(
        'SELECT definition_digest, input_json FROM workflow_runs'
      ).all() as Array<{ definition_digest: string; input_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.definition_digest).toBe(nextDigest);
      expect(JSON.parse(rows[0]!.input_json)).toEqual(input);
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('resolves the original Run when a same-key rival wins between lookup and insert', async () => {
    const f = fixture();
    try {
      const baseBatch = f.db.batch.bind(f.db);
      let winner: Awaited<ReturnType<typeof admitManualWorkflow>> | undefined;
      let raced = false;
      const racingDb = {
        prepare: f.db.prepare.bind(f.db),
        batch: async (commands: Parameters<D1Database['batch']>[0]) => {
          if (!raced) {
            raced = true;
            winner = await admitManualWorkflow(f.env, original.metadata.id, input, 'shared-race');
            f.change(null, 2);
          }
          return baseBatch(commands);
        }
      } as D1Database;
      const loser = await admitManualWorkflow({ ...f.env, DB: racingDb },
        original.metadata.id, input, 'shared-race');
      expect(loser).toMatchObject({
        runId: winner!.runId, definitionDigest: winner!.definitionDigest, alreadyAdmitted: true
      });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(1);
      expect((f.sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_events WHERE event_type = 'run.admitted'")
        .get() as { count: number }).count).toBe(1);
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('returns a same-key winner if activation is disabled after the initial lookup', async () => {
    const f = fixture();
    try {
      let winner: Awaited<ReturnType<typeof admitManualWorkflow>> | undefined;
      let raced = false;
      const racingDb = {
        prepare: (sql: string) => {
          const stmt = f.db.prepare(sql);
          if (!sql.includes('SELECT a.active_digest')) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: async () => {
                  if (!raced) {
                    raced = true;
                    winner = await admitManualWorkflow(f.env, original.metadata.id,
                      input, 'deactivate-race');
                    f.change(null, 2);
                  }
                  return bound.first();
                }
              };
            }
          };
        },
        batch: f.db.batch.bind(f.db)
      } as unknown as D1Database;
      const loser = await admitManualWorkflow({ ...f.env, DB: racingDb },
        original.metadata.id, input, 'deactivate-race');
      expect(loser).toMatchObject({
        runId: winner!.runId, definitionDigest: winner!.definitionDigest,
        alreadyAdmitted: true
      });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(1);
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('repairs only a confirmed missing queued instance using the original ID', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'missing-instance');
      f.loseInstance(first.runId);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'missing-instance');
      expect(replay).toMatchObject({ runId: first.runId, alreadyAdmitted: true });
      expect(f.starts()).toBe(2);
      const rows = f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number };
      expect(rows.count).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('keeps the original Run when repair creates an instance but its response is lost', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'repair-lost-response');
      f.loseInstance(first.runId);
      f.loseNextResponse();
      const repaired = await admitManualWorkflow(f.env, original.metadata.id, input, 'repair-lost-response');
      expect(repaired).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'repair-lost-response');
      expect(replay.runId).toBe(first.runId);
      expect(f.starts()).toBe(2);
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(1);
      expect((f.sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_events WHERE event_type = 'run.admitted'")
        .get() as { count: number }).count).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('does not recreate a stale queued Run after external retention may have expired', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'expired-recovery');
      f.sqlite.prepare('UPDATE workflow_runs SET created_at = ? WHERE run_id = ?')
        .run('2020-01-01T00:00:00.000Z', first.runId);
      f.loseInstance(first.runId);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'expired-recovery');
      expect(replay).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('returns an old admitted Run if its original external instance still exists', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'old-existing');
      f.sqlite.prepare('UPDATE workflow_runs SET created_at = ? WHERE run_id = ?')
        .run('2020-01-01T00:00:00.000Z', first.runId);
      f.change(null, 2);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'old-existing');
      expect(replay).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('reuses the original ID when the handle exists but status confirms missing instance', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'status-missing');
      f.loseInstance(first.runId);
      // A binding may return a handle from get() and report absence at status().
      // Only the positively identified not-found status permits same-ID repair.
      f.missOnStatus(true);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'status-missing');
      expect(replay).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      expect(f.starts()).toBe(2);
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('does not mistake REST API 10400 for verified Workflow binding absence', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'rest-10400');
      f.loseInstance(first.runId);
      f.useRestShapedMissing(true);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'rest-10400');
      expect(replay).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      // REST evidence alone must not authorize recreation of an external instance.
      expect(f.starts()).toBe(1);
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('returns original Run on uncertain instance lookup without another external start', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'uncertain-lookup');
      f.failLookup(true);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'uncertain-lookup');
      expect(replay).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      expect(f.starts()).toBe(1);
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(1);
      expect(first.alreadyAdmitted).toBe(false);
    } finally { f.sqlite.close(); }
  });

  it('does not recreate when an existing handle has an uncertain status RPC', async () => {
    const f = fixture();
    try {
      const first = await admitManualWorkflow(f.env, original.metadata.id, input, 'status-rpc');
      f.failStatus(true);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'status-rpc');
      expect(replay).toMatchObject({
        runId: first.runId, definitionDigest: first.definitionDigest, alreadyAdmitted: true
      });
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });

  it('repairs an admitted but never-created instance using the original Run ID', async () => {
    const f = fixture();
    try {
      f.failNextCreateBeforePersistence();
      await expect(admitManualWorkflow(f.env, original.metadata.id, input, 'never-created'))
        .rejects.toThrow('simulated createBatch failure before persistence');
      expect(f.starts()).toBe(0);
      const recorded = f.sqlite.prepare(
        'SELECT run_id, definition_digest FROM workflow_runs'
      ).get() as { run_id: string; definition_digest: string };
      f.change(null, 2);
      const replay = await admitManualWorkflow(f.env, original.metadata.id, input, 'never-created');
      expect(replay).toMatchObject({
        runId: recorded.run_id, definitionDigest: recorded.definition_digest, alreadyAdmitted: true
      });
      expect(f.starts()).toBe(1);
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(1);
      expect((f.sqlite.prepare("SELECT COUNT(*) AS count FROM workflow_events WHERE event_type = 'run.admitted'")
        .get() as { count: number }).count).toBe(1);
      const repeated = await admitManualWorkflow(f.env, original.metadata.id, input, 'never-created');
      expect(repeated.runId).toBe(recorded.run_id);
      expect(f.starts()).toBe(1);
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
      expect(f.starts()).toBe(1);
    } finally { f.sqlite.close(); }
  });
});
