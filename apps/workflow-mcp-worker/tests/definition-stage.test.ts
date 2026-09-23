import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
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
  manifestVersion: 1,
  plan: entry.plan,
  metadata: entry.metadata
});

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}
async function envelopeForPlan(plan: unknown): Promise<ReturnType<typeof envelope>> {
  const normalized = plan as {
    triggers: Array<{ type: string }>;
    steps: Record<string, { uses: string }>;
  };
  const serialized = JSON.stringify(canonical(plan));
  const bytes = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(serialized)
  ));
  const definitionDigest = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    ...envelope(),
    plan,
    definitionDigest,
    metadata: {
      ...entry.metadata,
      definitionDigest,
      triggerTypes: normalized.triggers.map(trigger => trigger.type),
      stepCapabilities: [...new Set(Object.values(normalized.steps).map(step => step.uses))]
    }
  };
}

async function openStore(): Promise<D1Database | null> {
  let sqlite: DatabaseSync;
  try {
    const module = await import('node:sqlite');
    sqlite = new module.DatabaseSync(':memory:');
  } catch { return null; }
  sqlite.exec(readFileSync('migrations/0001_core.sql', 'utf8'));
  for (const migration of ['0002_scheduler.sql', '0003_mcp_dependencies.sql',
    '0004_remote_executor.sql', '0005_artifacts.sql', '0006_provenance.sql',
    '0007_connection_versions.sql', '0008_definition_publications.sql']) {
    sqlite.exec(readFileSync('migrations/' + migration, 'utf8'));
  }
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...params: unknown[]) => statement(sql, params),
    first: async () => sqlite.prepare(sql).get(...(args as Array<string | number | bigint | null>)) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as Array<string | number | bigint | null>)) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...(args as Array<string | number | bigint | null>)).changes } })
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
    expect((await stageDefinition(send({ ...envelope(), metadata: { ...entry.metadata, name: 'forged' } }), env, publisher)).status).toBe(422);
    expect((await stageDefinition(send({ ...envelope(), policyRevision: 100 }), env, publisher)).status).toBe(409);
    expect((await stageDefinition(send({ ...envelope(), manifestVersion: 99 }), env, publisher)).status).toBe(422);
    expect((await stageDefinition(send(envelope()), env, publisher)).status).toBe(200);
    const changed = { ...envelope(), sourceSha: 'b'.repeat(40) };
    expect((await stageDefinition(send(changed), env, publisher)).status).toBe(409);
    const persisted = await db.prepare(
      'SELECT normalized_plan_json FROM workflow_definition_versions WHERE definition_digest = ?'
    ).bind(entry.definitionDigest).first<{ normalized_plan_json: string }>();
    expect(JSON.parse(persisted!.normalized_plan_json)).toEqual(entry.plan);
  });


  it('does not persist an orphaned plan if the approval revision changes just before the atomic batch', async () => {
    const db = await openStore();
    if (!db) return;
    const intercepted = {
      prepare: db.prepare.bind(db),
      batch: async (commands: Parameters<D1Database['batch']>[0]) => {
        await db.prepare('UPDATE connection_policy_revision SET revision = revision + 1 WHERE singleton = 1').run();
        return db.batch(commands);
      }
    } as D1Database;
    const response = await stageDefinition(send(envelope()), { DB: intercepted } as Env, publisher);
    expect(response.status).toBe(409);
    const stored = await db.prepare(
      'SELECT COUNT(*) AS count FROM workflow_definition_versions'
    ).first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it('rejects a concurrent conflicting digest row during the D1 batch without publishing it', async () => {
    const db = await openStore();
    if (!db) return;
    const altered = {
      prepare: db.prepare.bind(db),
      batch: async (commands: Parameters<D1Database['batch']>[0]) => {
        // Competing writer commits after staging read but before its transaction.
        await db.prepare(
          `INSERT INTO workflow_definition_versions
           (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
           VALUES (?, ?, 1, ?, ?, ?)`
        ).bind(entry.definitionDigest, 'unrelated-workflow', JSON.stringify(entry.plan),
          entry.sourcePath, '2026-09-23').run();
        return db.batch(commands);
      }
    } as D1Database;
    const response = await stageDefinition(send(envelope()), { DB: altered } as Env, publisher);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'publication_conflict' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM definition_publications')
      .first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare(
      'SELECT workflow_id FROM workflow_definition_versions WHERE definition_digest = ?'
    ).bind(entry.definitionDigest).first<{ workflow_id: string }>()).toEqual({
      workflow_id: 'unrelated-workflow'
    });
  });

  it('rejects a concurrent same-workflow digest collision with altered plan during staging', async () => {
    const db = await openStore();
    if (!db) return;
    const injected = {
      prepare: db.prepare.bind(db),
      batch: async (commands: Parameters<D1Database['batch']>[0]) => {
        // A competing writer wins the digest with the right workflow ID but
        // different plan contents after the initial immutable-definition read.
        await db.prepare(
          `INSERT INTO workflow_definition_versions
           (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, created_at)
           VALUES (?, ?, 1, ?, ?, ?)`
        ).bind(entry.definitionDigest, entry.metadata.id,
          JSON.stringify({ ...entry.plan, name: 'unapproved racing plan' }),
          entry.sourcePath, '2026-09-23').run();
        return db.batch(commands);
      }
    } as D1Database;
    const response = await stageDefinition(send(envelope()), { DB: injected } as Env, publisher);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'publication_conflict' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM definition_publications')
      .first<{ count: number }>()).toEqual({ count: 0 });
  });

  it('rejects unknown capability, unsafe retry and unapproved webhook Secret with valid digests', async () => {
    const db = await openStore();
    if (!db) return;
    const env = { DB: db } as Env;
    const unsupported = JSON.parse(JSON.stringify(entry.plan)) as {
      steps: Record<string, { uses: string }>;
    };
    unsupported.steps.fetch!.uses = 'unknown.capability';
    const unknown = await stageDefinition(send(await envelopeForPlan(unsupported)), env, publisher);
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ error: 'unsupported_capability' });

    const unsafe = JSON.parse(JSON.stringify(entry.plan)) as {
      steps: Record<string, { retryMaxAttempts?: number }>;
    };
    unsafe.steps.fetch!.retryMaxAttempts = 10;
    const retry = await stageDefinition(send(await envelopeForPlan(unsafe)), env, publisher);
    expect(retry.status).toBe(422);
    expect(await retry.json()).toEqual({ error: 'unsafe_retry' });

    const webhook = JSON.parse(JSON.stringify(entry.plan)) as {
      triggers: Array<{ type: string; id?: string; secret?: string }>;
    };
    webhook.triggers.push({ type: 'webhook', id: 'unapproved', secret: 'ARBITRARY_SECRET' });
    const secret = await stageDefinition(send(await envelopeForPlan(webhook)), env, publisher);
    expect(secret.status).toBe(422);
    expect(await secret.json()).toEqual({ error: 'webhook_not_approved' });
    const count = await db.prepare('SELECT COUNT(*) AS count FROM definition_publications')
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});
