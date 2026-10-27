import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { prepareLegacyCatalog, insertLegacyCatalogAtomically } from '../../src/registry/import.js';
import { openConnectionConfig } from '../../src/registry/crypto.js';

const keys = { DATABASE_ENCRYPTION_KEY: btoa('q'.repeat(32)), DATABASE_KEY_ID: 'migration_v1' };
const mysql = 'mysql://fixture:sample@mysql.example.org:3306/acceptance';
const pg = 'postgresql://fixture:sample@pg.example.org:5432/acceptance';
const catalog = JSON.stringify({ source_mysql: mysql, source_pg: pg });
const opened: DatabaseSync[] = [];
afterEach(() => { for (const d of opened.splice(0)) d.close(); });

function localDb() {
  const sql = new DatabaseSync(':memory:'); opened.push(sql);
  sql.exec(readFileSync(new URL('../../migrations/0001_connections.sql', import.meta.url), 'utf8'));
  const prepare = (text: string, args: unknown[] = []) => ({
    bind(...next: unknown[]) { return prepare(text, next); },
    async run() { const result = sql.prepare(text).run(...args as []); return { meta: { changes: result.changes } }; }
  });
  return { sql, db: { prepare: (text: string) => prepare(text) } as unknown as D1Database };
}

describe('offline atomic legacy migration', () => {
  it('prepares encrypted records and roundtrips without a database network request', async () => {
    const rows = await prepareLegacyCatalog(keys, catalog, ['source_pg', 'source_mysql']);
    expect(rows.map(r => r.dialect)).toEqual(['mysql', 'postgres']);
    expect(JSON.stringify(rows)).not.toContain('fixture:sample');
    expect((await openConnectionConfig(keys, 'source_pg', 'postgres',
      { keyId: rows[1]!.keyId, ciphertext: rows[1]!.ciphertext })).url).toBe(pg);
  });
  it('imports atomically as disabled and refuses a replay', async () => {
    const { sql, db } = localDb();
    const rows = await prepareLegacyCatalog(keys, catalog, ['source_mysql', 'source_pg']);
    expect(await insertLegacyCatalogAtomically(db, rows)).toEqual({ inserted: 2 });
    const original = sql.prepare('SELECT id,status,revision,ciphertext FROM database_connections ORDER BY id').all();
    expect(original).toHaveLength(2);
    expect(original.every(r => r.status === 'disabled' && r.revision === 1)).toBe(true);
    await expect(insertLegacyCatalogAtomically(db, rows)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(sql.prepare('SELECT id,status,revision,ciphertext FROM database_connections ORDER BY id').all())
      .toEqual(original);
  });
  it('duplicate connection ID is atomic and does not overwrite', async () => {
    const { sql, db } = localDb();
    sql.prepare("INSERT INTO database_connections VALUES ('source_pg','postgres','disabled','opaque.value','v0',1,1,1)").run();
    const batch = await prepareLegacyCatalog(keys, catalog, ['source_pg', 'source_mysql']);
    await expect(insertLegacyCatalogAtomically(db, batch)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(sql.prepare('SELECT id,ciphertext FROM database_connections').all())
      .toEqual([{ id: 'source_pg', ciphertext: 'opaque.value' }]);
  });

  it('enforces the total 50-row cap in one write statement', async () => {
    const { sql, db } = localDb();
    const seed = sql.prepare("INSERT INTO database_connections VALUES (?, 'mysql','disabled','opaque.value','v0',1,1,1)");
    for (let i = 0; i < 49; i++) seed.run('existing_' + i);
    const batch = await prepareLegacyCatalog(keys, catalog, ['source_mysql','source_pg']);
    await expect(insertLegacyCatalogAtomically(db, batch)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((sql.prepare('SELECT COUNT(*) AS n FROM database_connections').get() as {n: number}).n).toBe(49);
    sql.prepare("DELETE FROM database_connections WHERE id='existing_48'").run();
    expect(await insertLegacyCatalogAtomically(db, batch)).toEqual({ inserted: 2 });
    expect((sql.prepare('SELECT COUNT(*) AS n FROM database_connections').get() as {n: number}).n).toBe(50);
  });

  it('rejects incomplete approval and obsolete transport before any insertion', async () => {
    await expect(prepareLegacyCatalog(keys, catalog, ['source_mysql']))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(prepareLegacyCatalog(keys, catalog, ['source_mysql','source_mysql']))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(prepareLegacyCatalog(keys, JSON.stringify({
      old_proxy: { hyperdrive: 'DB_PROXY', dialect: 'mysql' }
    }), ['old_proxy'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(prepareLegacyCatalog({ ...keys, DATABASE_ENCRYPTION_KEY: 'invalid' }, catalog,
      ['source_mysql','source_pg'])).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
  });

});
