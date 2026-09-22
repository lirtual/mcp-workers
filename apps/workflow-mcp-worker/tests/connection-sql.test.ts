import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerApprovedConnection } from '../src/connection-admin.js';

/**
 * SQLite-backed D1 contract: this deliberately uses a real SQL engine rather
 * than assuming mocked D1 batch change counts prove CAS or rollback behavior.
 * GitHub Actions uses Node 24; older local Node installations may lack
 * node:sqlite and skip this additional integration check.
 */
async function openDatabase(): Promise<D1Database | null> {
  let DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number };
    };
    close(): void;
  };
  try {
    const name = 'node:sqlite';
    ({ DatabaseSync } = await import(name));
  } catch {
    return null;
  }
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY);');
  sqlite.exec(readFileSync('migrations/0007_connection_versions.sql', 'utf8'));
  const statement = (sql: string, args: unknown[] = []) => {
    const next = sqlite.prepare(sql);
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      first: async () => (next.get(...args) ?? null),
      all: async () => ({ results: next.all(...args) }),
      run: async () => ({ meta: { changes: next.run(...args).changes } })
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const command of statements) results.push(await command.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  } as unknown as D1Database;
}

describe('real SQLite Connection approval transaction', () => {
  it('applies additive migration and enforces an approved CAS registration', async () => {
    const db = await openDatabase();
    if (!db) return;
    const request = (actionId: string, expectedRevision: number) =>
      new Request('https://example.invalid/admin/connections/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId, expectedRevision, connectionId: 'raindrop', tools: ['list_raindrops'] })
      });
    const created = await registerApprovedConnection(request('first', 0), db);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ version: 1, revision: 1 });
    const control = await db.prepare(
      'SELECT current_version, revision, disabled FROM connection_controls WHERE connection_id = ?'
    ).bind('raindrop').first<{ current_version: number; revision: number; disabled: number }>();
    expect(control).toMatchObject({ current_version: 1, revision: 1, disabled: 0 });
    const revision = await db.prepare(
      'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
    ).first<{ revision: number }>();
    expect(revision?.revision).toBe(2);

    const duplicate = await registerApprovedConnection(request('first', 0), db);
    expect(duplicate.status).toBe(200);
    const stale = await registerApprovedConnection(request('stale', 0), db);
    expect(stale.status).toBe(409);
    const count = await db.prepare(
      'SELECT COUNT(*) AS count FROM connection_admin_actions'
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
    const latest = await db.prepare(
      'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
    ).first<{ revision: number }>();
    expect(latest?.revision).toBe(2);
  });
});
