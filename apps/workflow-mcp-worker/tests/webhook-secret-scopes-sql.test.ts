import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    for (const migration of [
      '0001_core.sql', '0002_scheduler.sql', '0003_mcp_dependencies.sql',
      '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
      '0007_connection_versions.sql', '0008_definition_publications.sql',
      '0009_active_definitions.sql', '0010_webhook_secret_scopes.sql'
    ]) {
      db.exec(readFileSync('migrations/' + migration, 'utf8'));
    }
    db.prepare(`INSERT INTO workflow_definition_versions
      (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
      VALUES (?, ?, 1, '{}', 'test.yaml', '2026-01-01T00:00:00Z')`)
      .run('a'.repeat(64), 'example');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function approve(db: DatabaseSync, trigger: string, name: string, digest = 'a'.repeat(64)) {
  db.prepare(`INSERT INTO workflow_webhook_secret_scopes
    (workflow_id, trigger_id, definition_digest, secret_name, policy_revision, approved_at)
    VALUES ('example', ?, ?, ?, 1, '2026-01-01T00:00:00Z')`)
    .run(trigger, digest, name);
}

describe('T07 approved webhook secret scope schema', () => {
  it('allows independent trigger bindings for one immutable version', () => {
    const db = fixture();
    try {
      approve(db, 'incoming', 'EXAMPLE_WEBHOOK_TOKEN');
      approve(db, 'retry', 'EXAMPLE_RETRY_TOKEN');
      const rows = db.prepare(`SELECT trigger_id, secret_name FROM workflow_webhook_secret_scopes
        WHERE workflow_id = 'example' ORDER BY trigger_id`).all();
      expect(rows).toEqual([
        { trigger_id: 'incoming', secret_name: 'EXAMPLE_WEBHOOK_TOKEN' },
        { trigger_id: 'retry', secret_name: 'EXAMPLE_RETRY_TOKEN' }
      ]);
      expect(() => approve(db, 'incoming', 'OTHER_TOKEN')).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects reserved platform secrets and an unknown definition digest', () => {
    const db = fixture();
    try {
      for (const reserved of [
        'MCP_ACCESS_TOKEN', 'EXECUTOR_LEASE_SECRET', 'GITHUB_ACTIONS_TOKEN',
        'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
        'ADMIN_PUBLISHER_WORKFLOW_SHA', 'GITHUB_REPOSITORY_ID',
        'DYNAMIC_WORKFLOW_ADMISSION_ENABLED', 'CF_VERSION_METADATA',
        'WEBHOOK_SECRET_ALLOWLIST'
      ]) {
        expect(() => approve(db, 'incoming', reserved)).toThrow();
      }
      expect(() => approve(db, 'incoming', 'EXAMPLE_TOKEN', 'b'.repeat(64))).toThrow();
      expect(db.prepare('SELECT count(*) AS count FROM workflow_webhook_secret_scopes')
        .get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('requires an approved positive policy revision and explicit enabled status', () => {
    const db = fixture();
    try {
      approve(db, 'incoming', 'EXAMPLE_TOKEN');
      expect(() => db.prepare(`UPDATE workflow_webhook_secret_scopes
        SET policy_revision = 0 WHERE trigger_id = 'incoming'`).run()).toThrow();
      expect(() => db.prepare(`UPDATE workflow_webhook_secret_scopes
        SET enabled = 2 WHERE trigger_id = 'incoming'`).run()).toThrow();
    } finally {
      db.close();
    }
  });
});
