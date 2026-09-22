import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { compileWorkflowText } from '../src/compiler.js';
import type { Env } from '../src/types.js';
import { registerApprovedWebhookScope } from '../src/webhook-scope-admin.js';

const compiled = compileWorkflowText(
  readFileSync('acceptance/workflows/trigger-http-smoke.yaml', 'utf8'),
  'acceptance/workflows/trigger-http-smoke.yaml'
);
const plan = compiled.plan as { id: string; triggers: Array<{type: string; id?: string; secret?: string}> };
const hook = plan.triggers.find(t => t.type === 'webhook')!;

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of [
    '0001_core.sql', '0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql',
    '0009_active_definitions.sql', '0010_webhook_secret_scopes.sql'
  ]) sqlite.exec(readFileSync('migrations/' + file, 'utf8'));
  sqlite.prepare(`INSERT INTO workflow_definition_versions
    (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
    VALUES (?, ?, 1, ?, 'trigger-http-smoke.yaml', '2026-01-01')`)
    .run(compiled.definitionDigest, plan.id, JSON.stringify(plan));
  const current = sqlite.prepare('SELECT revision FROM connection_policy_revision WHERE singleton = 1')
    .get() as {revision: number} | undefined;
  if (!current) sqlite.exec('INSERT INTO connection_policy_revision(singleton, revision) VALUES (1, 1)');
  const revision = current?.revision ?? 1;
  type Arg = string | number | bigint | null;
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => sqlite.prepare(sql).get(...(args as Arg[])) ?? null,
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...(args as Arg[])).changes } })
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{run(): Promise<{meta:{changes:number}}>}>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    }
  } as unknown as D1Database;
  const body = (actionId: string, overrides: Record<string, unknown> = {}) => ({
    actionId, workflowId: plan.id, triggerId: hook.id,
    definitionDigest: compiled.definitionDigest, secretName: hook.secret,
    expectedPolicyRevision: revision, ...overrides
  });
  const env = { DB: db, WEBHOOK_SECRET_ALLOWLIST: JSON.stringify([hook.secret]),
    [hook.secret!]: 'configured-hook-token' } as unknown as Env;
  const register = (value: Record<string, unknown>) =>
    registerApprovedWebhookScope(new Request('https://example/admin/webhooks/scopes/register', {
      method: 'POST', body: JSON.stringify(value)
    }), env);
  return { sqlite, env, body, register };
}

describe('T07 protected webhook secret registration', () => {
  it('persists one declared immutable scope with a durable idempotent action', async () => {
    const f = fixture();
    try {
      expect((await f.register(f.body('action-one'))).status).toBe(200);
      expect((await f.register(f.body('action-one'))).status).toBe(200);
      expect((await f.register(f.body('action-two'))).status).toBe(409);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM webhook_secret_scope_actions').get()).toEqual({n: 1});
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM workflow_webhook_secret_scopes').get()).toEqual({n: 1});
    } finally { f.sqlite.close(); }
  });
  it('recovers a committed registration when D1 loses its response', async () => {
    const f = fixture();
    try {
      const base = f.env.DB;
      let dropResponse = true;
      f.env.DB = {
        prepare: base.prepare.bind(base),
        batch: async (statements: Parameters<D1Database['batch']>[0]) => {
          const result = await base.batch(statements);
          if (dropResponse) {
            dropResponse = false;
            throw new Error('simulated response lost after commit');
          }
          return result;
        }
      } as D1Database;
      const recovered = await f.register(f.body('lost-response'));
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ registered: true });
      expect((await f.register(f.body('lost-response'))).status).toBe(200);
      expect((await f.register(f.body('different-action'))).status).toBe(409);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM webhook_secret_scope_actions').get())
        .toEqual({ n: 1 });
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM workflow_webhook_secret_scopes').get())
        .toEqual({ n: 1 });
    } finally { f.sqlite.close(); }
  });

  it('rolls back the action claim if the second D1 batch statement fails', async () => {
    const f = fixture();
    try {
      f.sqlite.exec(`CREATE TRIGGER reject_webhook_scope BEFORE INSERT ON workflow_webhook_secret_scopes
        BEGIN SELECT RAISE(ABORT, 'simulated scope storage failure'); END`);
      const failed = await f.register(f.body('atomic-failure'));
      expect(failed.status).toBe(503);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM webhook_secret_scope_actions').get())
        .toEqual({ n: 0 });
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM workflow_webhook_secret_scopes').get())
        .toEqual({ n: 0 });
      f.sqlite.exec('DROP TRIGGER reject_webhook_scope');
      expect((await f.register(f.body('atomic-failure'))).status).toBe(200);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM webhook_secret_scope_actions').get())
        .toEqual({ n: 1 });
    } finally { f.sqlite.close(); }
  });

  it('rejects a missing, malformed or unrelated owner binding allowlist', async () => {
    const f = fixture();
    try {
      delete f.env.WEBHOOK_SECRET_ALLOWLIST;
      expect((await f.register(f.body('missing-allowlist'))).status).toBe(400);
      f.env.WEBHOOK_SECRET_ALLOWLIST = 'not-json';
      expect((await f.register(f.body('malformed-allowlist'))).status).toBe(400);
      f.env.WEBHOOK_SECRET_ALLOWLIST = JSON.stringify(['OTHER_WEBHOOK_TOKEN']);
      expect((await f.register(f.body('unapproved-reference'))).status).toBe(400);
      f.env.WEBHOOK_SECRET_ALLOWLIST = JSON.stringify([hook.secret]);
      delete (f.env as unknown as Record<string, unknown>)[hook.secret!];
      expect((await f.register(f.body('unprovisioned-binding'))).status).toBe(400);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM webhook_secret_scope_actions').get())
        .toEqual({ n: 0 });
    } finally { f.sqlite.close(); }
  });
  it('can explicitly reapprove an enabled scope after unrelated policy revision changes', async () => {
    const f = fixture();
    try {
      expect((await f.register(f.body('initial'))).status).toBe(200);
      f.sqlite.exec('UPDATE connection_policy_revision SET revision = revision + 1 WHERE singleton = 1');
      expect((await f.register(f.body('initial'))).status).toBe(409);
      expect((await f.register(f.body('new-approval', { expectedPolicyRevision: 2 }))).status).toBe(200);
      expect(f.sqlite.prepare('SELECT policy_revision FROM workflow_webhook_secret_scopes').get())
        .toEqual({ policy_revision: 2 });
      expect((await f.register(f.body('initial'))).status).toBe(200);
      f.sqlite.exec('UPDATE workflow_webhook_secret_scopes SET enabled = 0');
      f.sqlite.exec('UPDATE connection_policy_revision SET revision = revision + 1 WHERE singleton = 1');
      expect((await f.register(f.body('revoked-approval', { expectedPolicyRevision: 3 }))).status)
        .toBe(409);
      expect(f.sqlite.prepare('SELECT enabled FROM workflow_webhook_secret_scopes').get())
        .toEqual({ enabled: 0 });
    } finally { f.sqlite.close(); }
  });

  it('does not report a revoked or stale scope as successfully replayed', async () => {
    const f = fixture();
    try {
      expect((await f.register(f.body('action-one'))).status).toBe(200);
      f.sqlite.exec('UPDATE workflow_webhook_secret_scopes SET enabled = 0');
      expect((await f.register(f.body('action-one'))).status).toBe(409);
    } finally { f.sqlite.close(); }
  });
  it('rejects undeclared or protected tokens, stale policy and conflicting action', async () => {
    const f = fixture();
    try {
      expect((await f.register(f.body('bad', {secretName:'MCP_ACCESS_TOKEN'}))).status).toBe(400);
      expect((await f.register(f.body('bad', {secretName:'ADMIN_PUBLISHER_WORKFLOW_SHA'}))).status).toBe(400);
      expect((await f.register(f.body('bad', {secretName:'OTHER_TOKEN'}))).status).toBe(400);
      expect((await f.register(f.body('stale', {expectedPolicyRevision:999}))).status).toBe(409);
      expect((await f.register(f.body('action-one'))).status).toBe(200);
      expect((await f.register(f.body('action-one', {secretName:'OTHER_TOKEN'}))).status).toBe(400);
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM workflow_webhook_secret_scopes').get()).toEqual({n: 1});
    } finally { f.sqlite.close(); }
  });
});
