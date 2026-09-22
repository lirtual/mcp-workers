import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { admitManualWorkflow, admitVersionedWebhookWorkflow } from '../src/admission.js';
import { registerWorkflowTools } from '../src/mcp.js';
import { handleWebhookTrigger } from '../src/triggers.js';
import type { PublicWorkflowError } from '../src/admission.js';
import { getWorkflowRegistry } from '../src/registry.js';
import type { Env } from '../src/types.js';

const original = getWorkflowRegistry().find(item => item.metadata.id === 'local-http-smoke')!;

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_core.sql', '0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql', '0009_active_definitions.sql',
    '0010_webhook_secret_scopes.sql']) {
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
  let uncertainLookup = false;
  let uncertainStatus = false;
  const instances = new Set<string>();
  const env = {
    DB: db,
    DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true',
    DYNAMIC_WORKFLOW_ADMISSION_ENABLED: 'true',
    WORKFLOW: {
      get: async (id: string) => {
        if (uncertainLookup) throw new Error('simulated upstream timeout');
        if (!instances.has(id)) throw Object.assign(new Error('Instance does not exist'), {
          code: 'instance.not_found'
        });
        return {
          id,
          status: async () => {
            if (uncertainStatus) throw new Error('simulated status RPC timeout');
            return { status: 'queued' };
          }
        };
      },
      createBatch: async (batch: Array<{ id: string; params: { runId: string } }>) => {
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
    loseInstance: (id: string) => { instances.delete(id); },
    failLookup: (fail: boolean) => { uncertainLookup = fail; },
    failStatus: (fail: boolean) => { uncertainStatus = fail; }
  };
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

describe('T07 transactional webhook authorization', () => {
  it('rotates to the new trigger credential without granting it the previous Run', async () => {
    const f = fixture();
    try {
      const firstPlan = JSON.parse(JSON.stringify(original.plan)) as {
        triggers: Array<Record<string, unknown>>
      };
      firstPlan.triggers.push({ type: 'webhook', id: 'incoming', secret: 'OLD_HOOK_TOKEN' });
      const secondPlan = JSON.parse(JSON.stringify(firstPlan)) as typeof firstPlan;
      secondPlan.triggers[secondPlan.triggers.length - 1]!.secret = 'NEW_HOOK_TOKEN';
      const firstDigest = 'd'.repeat(64);
      const secondDigest = 'e'.repeat(64);
      f.save(firstDigest, firstPlan);
      f.save(secondDigest, secondPlan);
      const policy = (f.sqlite.prepare(
        'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
      ).get() as { revision: number }).revision;
      for (const [digest, secret] of [
        [firstDigest, 'OLD_HOOK_TOKEN'], [secondDigest, 'NEW_HOOK_TOKEN']
      ] as const) {
        f.sqlite.prepare(`INSERT INTO workflow_webhook_secret_scopes
          (workflow_id, trigger_id, definition_digest, secret_name, policy_revision, enabled, approved_at)
          VALUES (?, 'incoming', ?, ?, ?, 1, '2026-09-22')`)
          .run(original.metadata.id, digest, secret, policy);
      }
      const env = {
        ...f.env, OLD_HOOK_TOKEN: 'old-token', NEW_HOOK_TOKEN: 'new-token'
      } as Env;
      const request = (token: string, key: string) => new Request(
        `https://workflow.example/hooks/${original.metadata.id}/incoming`, {
          method: 'POST', headers: {
            Authorization: `Bearer ${token}`, 'X-Workflow-Event-Key': key
          }, body: JSON.stringify({ input })
        }
      );
      const invoke = (token: string, key: string) =>
        handleWebhookTrigger(request(token, key), env, original.metadata.id, 'incoming');
      f.change(firstDigest, 2);
      const initial = await invoke('old-token', 'original-event');
      expect(initial.status).toBe(202);
      const originalResponse = await initial.json() as { runId: string };
      f.change(secondDigest, 3);
      expect((await invoke('old-token', 'fresh-event')).status).toBe(401);
      const rotated = await invoke('new-token', 'fresh-event');
      expect(rotated.status).toBe(202);
      expect(await rotated.json()).toMatchObject({
        definitionDigest: secondDigest, alreadyAdmitted: false
      });
      expect((await invoke('new-token', 'original-event')).status).toBe(401);
      const historical = await invoke('old-token', 'original-event');
      expect(historical.status).toBe(202);
      expect(await historical.json()).toMatchObject({
        runId: originalResponse.runId, definitionDigest: firstDigest, alreadyAdmitted: true
      });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(2);
      expect(f.starts()).toBe(2);
    } finally { f.sqlite.close(); }
  });

  it('pins the authenticated digest and fails closed after deactivation or scope revocation', async () => {
    const f = fixture();
    try {
      const plan = JSON.parse(JSON.stringify(original.plan)) as {
        triggers: Array<Record<string, unknown>>
      };
      plan.triggers.push({ type: 'webhook', id: 'incoming', secret: 'TEST_WEBHOOK_TOKEN' });
      const digest = 'c'.repeat(64);
      f.save(digest, plan);
      f.change(digest, 2);
      const revision = (f.sqlite.prepare(
        'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
      ).get() as { revision: number }).revision;
      f.sqlite.prepare(`INSERT INTO workflow_webhook_secret_scopes
        (workflow_id, trigger_id, definition_digest, secret_name, policy_revision, enabled, approved_at)
        VALUES (?, 'incoming', ?, 'TEST_WEBHOOK_TOKEN', ?, 1, '2026-09-22')`)
        .run(original.metadata.id, digest, revision);
      const selected = { definitionDigest: digest, registryRevision: 2, secretName: 'TEST_WEBHOOK_TOKEN' };
      const run = (key: string, env = f.env) =>
        admitVersionedWebhookWorkflow(env, original.metadata.id, 'incoming', input, key, selected);
      const hookEnv = { ...f.env, TEST_WEBHOOK_TOKEN: 'valid-token' } as Env;
      const request = (token: string, eventKey: string) => new Request(
        `https://workflow.example/hooks/${original.metadata.id}/incoming`, {
          method: 'POST', headers: {
            Authorization: `Bearer ${token}`, 'X-Workflow-Event-Key': eventKey
          }, body: JSON.stringify({ input })
        }
      );
      const invalid = await handleWebhookTrigger(
        request('wrong-token', 'invalid-1'), hookEnv, original.metadata.id, 'incoming'
      );
      expect(invalid.status).toBe(401);
      const accepted = await handleWebhookTrigger(
        request('valid-token', 'http-event'), hookEnv, original.metadata.id, 'incoming'
      );
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({ definitionDigest: digest, alreadyAdmitted: false });
      const first = await run('event-1');
      expect(first).toMatchObject({ definitionDigest: digest, alreadyAdmitted: false });
      expect(await run('event-1')).toMatchObject({ runId: first.runId, alreadyAdmitted: true });
      // Even with the same event key, a token validated for a different
      // digest cannot learn or recover an earlier credential's Run.
      await expect(admitVersionedWebhookWorkflow(
        f.env, original.metadata.id, 'incoming', input, 'event-1',
        { ...selected, definitionDigest: 'd'.repeat(64) }
      )).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' });
      // The signed token was already validated, but the trusted scope can be
      // revoked before D1's admission transaction. No stale authorization.
      const baseBatch = f.db.batch.bind(f.db);
      let revokeAtCommit = true;
      const racingDb = {
        prepare: f.db.prepare.bind(f.db),
        batch: async (commands: Parameters<D1Database['batch']>[0]) => {
          if (revokeAtCommit) {
            revokeAtCommit = false;
            f.sqlite.exec("UPDATE workflow_webhook_secret_scopes SET enabled = 0");
          }
          return baseBatch(commands);
        }
      } as D1Database;
      await expect(run('event-race', { ...f.env, DB: racingDb })).rejects
        .toMatchObject({ code: 'REGISTRY_CONFLICT' });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(2);
      f.sqlite.exec("UPDATE workflow_webhook_secret_scopes SET enabled = 1");
      // A concurrent activation that changes only the registry revision must
      // also invalidate the already authenticated version before Run insert.
      let activationAtCommit = true;
      const activationDb = {
        prepare: f.db.prepare.bind(f.db),
        batch: async (commands: Parameters<D1Database['batch']>[0]) => {
          if (activationAtCommit) {
            activationAtCommit = false;
            f.change(digest, 3);
          }
          return baseBatch(commands);
        }
      } as D1Database;
      await expect(run('event-activation-race', { ...f.env, DB: activationDb }))
        .rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' });
      f.change(digest, 2);
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(2);
      f.sqlite.exec("UPDATE workflow_webhook_secret_scopes SET enabled = 0");
      await expect(run('event-2')).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' });
      f.sqlite.exec("UPDATE workflow_webhook_secret_scopes SET enabled = 1");
      f.change(null, 3);
      await expect(run('event-3')).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
      const deniedReplay = await handleWebhookTrigger(
        request('wrong-token', 'http-event'), hookEnv, original.metadata.id, 'incoming'
      );
      expect(deniedReplay.status).toBe(401);
      const historical = await handleWebhookTrigger(
        request('valid-token', 'http-event'), hookEnv, original.metadata.id, 'incoming'
      );
      expect(historical.status).toBe(202);
      expect(await historical.json()).toMatchObject({
        definitionDigest: digest, alreadyAdmitted: true
      });
      // Historical results remain durable, but their webhook token loses
      // authorization immediately when the original scope is revoked.
      f.sqlite.exec("UPDATE workflow_webhook_secret_scopes SET enabled = 0");
      const revokedReplay = await handleWebhookTrigger(
        request('valid-token', 'http-event'), hookEnv, original.metadata.id, 'incoming'
      );
      expect(revokedReplay.status).toBe(503);
      await expect(revokedReplay.json()).resolves.toMatchObject({
        error: { code: 'TRIGGER_AUTH_NOT_CONFIGURED' }
      });
      expect((f.sqlite.prepare('SELECT COUNT(*) AS count FROM workflow_runs')
        .get() as { count: number }).count).toBe(2);
      expect(f.starts()).toBe(2);
    } finally { f.sqlite.close(); }
  });
});
