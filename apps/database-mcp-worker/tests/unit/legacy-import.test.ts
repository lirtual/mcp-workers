import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { prepareLegacyCatalog, insertLegacyCatalogAtomically, verifyLegacyCatalogReadback } from '../../src/registry/import.js';
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
    async run() { const result = sql.prepare(text).run(...args as []); return { meta: { changes: result.changes } }; },
    async first<T>() { return (sql.prepare(text).get(...args as []) as T) ?? null; }
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


  it('authenticates each imported D1 row against the frozen catalog without upstream calls', async () => {
    const { sql, db } = localDb();
    const ids = ['source_mysql', 'source_pg'];
    const rows = await prepareLegacyCatalog(keys, catalog, ids);
    await insertLegacyCatalogAtomically(db, rows);
    expect(await verifyLegacyCatalogReadback(db, keys, catalog, ids)).toEqual({ verified: 2 });
    sql.prepare("UPDATE database_connections SET status='active' WHERE id='source_pg'").run();
    expect(await verifyLegacyCatalogReadback(db, keys, catalog, ids)).toEqual({ verified: 2 });
  });
  it('rejects missing rows, swapped encrypted records and invalid credentials without disclosure', async () => {
    const ids = ['source_mysql', 'source_pg'];
    const { sql, db } = localDb();
    const rows = await prepareLegacyCatalog(keys, catalog, ids);
    const verify = () => verifyLegacyCatalogReadback(db, keys, catalog, ids);
    await expect(verify()).rejects.toMatchObject({
      code: 'CONFIGURATION_UNAVAILABLE', message: 'Migration readback verification failed.'
    });
    await insertLegacyCatalogAtomically(db, rows);
    const a = sql.prepare('SELECT ciphertext FROM database_connections WHERE id=?').get('source_mysql') as { ciphertext: string };
    const b = sql.prepare('SELECT ciphertext FROM database_connections WHERE id=?').get('source_pg') as { ciphertext: string };
    sql.prepare('UPDATE database_connections SET ciphertext=? WHERE id=?').run(b.ciphertext, 'source_mysql');
    sql.prepare('UPDATE database_connections SET ciphertext=? WHERE id=?').run(a.ciphertext, 'source_pg');
    await expect(verify()).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    sql.prepare('UPDATE database_connections SET ciphertext=? WHERE id=?').run(a.ciphertext, 'source_mysql');
    sql.prepare('UPDATE database_connections SET ciphertext=? WHERE id=?').run(b.ciphertext, 'source_pg');
    sql.prepare("UPDATE database_connections SET ciphertext='invalid' WHERE id='source_pg'").run();
    await expect(verify()).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    sql.prepare('UPDATE database_connections SET ciphertext=? WHERE id=?').run(b.ciphertext, 'source_pg');
    await expect(verifyLegacyCatalogReadback(db, {
      DATABASE_ENCRYPTION_KEY: btoa('z'.repeat(32)), DATABASE_KEY_ID: 'migration_v1'
    }, catalog, ids)).rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
    expect(await verify()).toEqual({ verified: 2 });
  });
  it('rejects changed URLs even when D1 ciphertext remains authentically encrypted', async () => {
    const { sql, db } = localDb();
    const ids = ['source_mysql', 'source_pg'];
    const rows = await prepareLegacyCatalog(keys, catalog, ids);
    await insertLegacyCatalogAtomically(db, rows);
    const different = await prepareLegacyCatalog(keys, JSON.stringify({
      source_mysql: 'mysql://fixture:other@mysql.example.org:3306/acceptance', source_pg: pg
    }), ids);
    sql.prepare('UPDATE database_connections SET ciphertext=? WHERE id=?')
      .run(different[0]!.ciphertext, 'source_mysql');
    await expect(verifyLegacyCatalogReadback(db, keys, catalog, ids))
      .rejects.toMatchObject({ code: 'CONFIGURATION_UNAVAILABLE' });
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
