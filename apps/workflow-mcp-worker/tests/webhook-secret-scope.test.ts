import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { resolveApprovedWebhookSecret } from '../src/webhook-secret-scope.js';
import type { Env } from '../src/types.js';

const DIGEST = 'a'.repeat(64);
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const migration of [
    '0001_core.sql', '0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql',
    '0009_active_definitions.sql', '0010_webhook_secret_scopes.sql'
  ]) sqlite.exec(readFileSync('migrations/' + migration, 'utf8'));
  sqlite.prepare(`INSERT INTO workflow_definition_versions
    (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
    VALUES (?, 'sample', 1, '{}', 'test.yaml', '2026-01-01')`).run(DIGEST);
  const revision = sqlite.prepare('SELECT revision FROM connection_policy_revision WHERE singleton = 1')
    .get() as { revision: number } | undefined;
  const current = revision?.revision ?? 1;
  if (!revision) sqlite.prepare(
    'INSERT INTO connection_policy_revision(singleton, revision) VALUES (1, 1)'
  ).run();
  const env = {
    SAMPLE_HOOK: 'authorized-token', OTHER_HOOK: 'other-token',
    MCP_ACCESS_TOKEN: 'platform-token',
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: Array<string | number>) => ({
          first: async () => sqlite.prepare(sql).get(...args) ?? null
        })
      })
    }
  } as unknown as Env;
  const approve = (secret: string, enabled = 1) => sqlite.prepare(`INSERT INTO workflow_webhook_secret_scopes
    (workflow_id, trigger_id, definition_digest, secret_name, policy_revision, enabled, approved_at)
    VALUES ('sample', 'incoming', ?, ?, ?, ?, '2026-01-01')`)
    .run(DIGEST, secret, current, enabled);
  return { sqlite, env, approve };
}

describe('T07 approved webhook secret resolution', () => {
  it('resolves only the approved exact workflow, trigger, digest and declared reference', async () => {
    const f = fixture();
    try {
      f.approve('SAMPLE_HOOK');
      expect(await resolveApprovedWebhookSecret(f.env, 'sample', 'incoming', DIGEST, 'SAMPLE_HOOK'))
        .toBe('authorized-token');
      for (const [workflow, trigger, digest, secret] of [
        ['other', 'incoming', DIGEST, 'SAMPLE_HOOK'],
        ['sample', 'other', DIGEST, 'SAMPLE_HOOK'],
        ['sample', 'incoming', 'b'.repeat(64), 'SAMPLE_HOOK'],
        ['sample', 'incoming', DIGEST, 'OTHER_HOOK'],
        ['sample', 'incoming', DIGEST, 'MCP_ACCESS_TOKEN'],
        ['sample', 'incoming', DIGEST, 'ADMIN_PUBLISHER_WORKFLOW_SHA']
      ]) {
        expect(await resolveApprovedWebhookSecret(f.env, workflow!, trigger!, digest!, secret!))
          .toBeNull();
      }
    } finally { f.sqlite.close(); }
  });

  it('fails closed on disabled, stale policy and missing configured binding', async () => {
    const f = fixture();
    try {
      f.approve('SAMPLE_HOOK', 0);
      const resolve = () => resolveApprovedWebhookSecret(f.env, 'sample', 'incoming', DIGEST, 'SAMPLE_HOOK');
      expect(await resolve()).toBeNull();
      f.sqlite.exec(`UPDATE workflow_webhook_secret_scopes SET enabled = 1`);
      expect(await resolve()).toBe('authorized-token');
      f.sqlite.exec(`UPDATE connection_policy_revision SET revision = revision + 1 WHERE singleton = 1`);
      expect(await resolve()).toBeNull();
      f.sqlite.exec(`UPDATE workflow_webhook_secret_scopes SET policy_revision =
        (SELECT revision FROM connection_policy_revision WHERE singleton = 1)`);
      delete (f.env as unknown as Record<string, unknown>).SAMPLE_HOOK;
      expect(await resolve()).toBeNull();
    } finally { f.sqlite.close(); }
  });
});
