import { Client as PgClient } from 'pg';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { parseConnectionCatalog, resolveConnection, resolveWriteConnection } from '../../src/config.js';
import { deleteRows, explainRead, insertRows, inspectSchema, queryRead, updateRows } from '../../src/db/index.js';
import type { EffectiveConnection, EffectiveWriteConnection, Env } from '../../src/types.js';

function directConnection(id: string, raw: string): EffectiveConnection {
  const secretName = 'TEST_DATABASE_URL';
  const env: Env = {
    CONNECTIONS_JSON: '[]',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    [secretName]: raw
  };
  const catalog = parseConnectionCatalog(JSON.stringify([
    {
      id,
      displayName: id,
      transport: 'direct',
      urlSecret: secretName,
      enabled: true
    }
  ]));
  return resolveConnection(env, catalog, id);
}

function directWritableConnection(
  id: string,
  readRaw: string,
  writeRaw: string,
  maxAffectedRows = 20
): { read: EffectiveConnection; write: EffectiveWriteConnection } {
  const env: Env = {
    CONNECTIONS_JSON: '[]',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    TEST_READ_URL: readRaw,
    TEST_WRITE_URL: writeRaw,
    MAX_WRITE_AFFECTED_ROWS: String(maxAffectedRows)
  };
  const catalog = parseConnectionCatalog(JSON.stringify([
    {
      id,
      displayName: id,
      transport: 'direct',
      urlSecret: 'TEST_READ_URL',
      enabled: true,
      write: {
        transport: 'direct',
        urlSecret: 'TEST_WRITE_URL'
      }
    }
  ]));
  return {
    read: resolveConnection(env, catalog, id),
    write: resolveWriteConnection(env, catalog, id)
  };
}

const pgReadUrl = process.env.TEST_POSTGRES_READ_URL;
const pgWriteUrl = process.env.TEST_POSTGRES_WRITE_URL;
const mysqlReadUrl = process.env.TEST_MYSQL_READ_URL;
const mysqlWriteUrl = process.env.TEST_MYSQL_WRITE_URL;
const describeReadIntegration = pgReadUrl && mysqlReadUrl ? describe : describe.skip;
const describeWriteIntegration = pgReadUrl && pgWriteUrl && mysqlReadUrl && mysqlWriteUrl ? describe : describe.skip;

describeReadIntegration('real database read-only integration', () => {
  const pg = directConnection('pg', pgReadUrl!);
  const mysql = directConnection('mysql', mysqlReadUrl!);

  it('resolves SQL URL Secrets into the expected direct dialects', () => {
    expect(pg).toMatchObject({ transport: 'direct', dialect: 'postgres' });
    expect(mysql).toMatchObject({ transport: 'direct', dialect: 'mysql' });
  });

  it('queries PostgreSQL through the direct read adapter and preserves RLS', async () => {
    const result = await queryRead(pg, 'SELECT id, tenant_id, email FROM public.users ORDER BY id', [], 10);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.[0]).toBe(1);
  });

  it('queries MySQL through the direct read adapter', async () => {
    const result = await queryRead(mysql, 'SELECT id, email FROM users ORDER BY id', [], 10);
    expect(result.rowCount).toBe(2);
  });

  it('inspects table metadata in both dialects', async () => {
    const pgSchema = await inspectSchema(pg, 'public', 'users');
    const mySchema = await inspectSchema(mysql, mysql.database, 'users');
    expect(pgSchema.columns?.some(column => column.name === 'email')).toBe(true);
    expect(mySchema.columns?.some(column => column.name === 'email')).toBe(true);
  });

  it('returns non-ANALYZE plans', async () => {
    expect(await explainRead(pg, 'SELECT * FROM public.users WHERE id = $1', [1])).toBeTruthy();
    expect(await explainRead(mysql, 'SELECT * FROM users WHERE id = ?', [1])).toBeTruthy();
  });

  it('database-native PostgreSQL reader permissions reject writes and side-effecting function execution', async () => {
    const client = new PgClient({ connectionString: pgReadUrl!, ssl: false });
    await client.connect();
    try {
      await expect(client.query("UPDATE public.users SET email = 'changed' WHERE id = 1")).rejects.toBeTruthy();
      await expect(client.query('SELECT public.dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await client.end();
    }
  });

  it('database-native MySQL reader permissions reject writes and stored routine execution', async () => {
    const url = new URL(mysqlReadUrl!);
    const client = await createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      disableEval: true
    });
    try {
      await expect(client.query("UPDATE users SET email = 'changed' WHERE id = 1")).rejects.toBeTruthy();
      await expect(client.query('CALL dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await client.end();
    }
  });
});

describeWriteIntegration('real database safe write integration', () => {
  const pg = directWritableConnection('pg_write', pgReadUrl!, pgWriteUrl!);
  const mysql = directWritableConnection('mysql_write', mysqlReadUrl!, mysqlWriteUrl!);

  it('resolves separate direct writer credentials for both dialects', () => {
    expect(pg.write).toMatchObject({ transport: 'direct', dialect: 'postgres', maxAffectedRows: 20 });
    expect(mysql.write).toMatchObject({ transport: 'direct', dialect: 'mysql', maxAffectedRows: 20 });
  });

  it('inserts multiple rows through one structured statement in both dialects', async () => {
    await expect(insertRows(pg.write, 'public', 'write_items', [
      { id: 101, value: 'pg-one' },
      { id: 102, value: 'pg-two' }
    ])).resolves.toEqual({ affectedRows: 2 });
    await expect(insertRows(mysql.write, undefined, 'write_items', [
      { id: 101, value: 'mysql-one' },
      { id: 102, value: 'mysql-two' }
    ])).resolves.toEqual({ affectedRows: 2 });

    const pgRows = await queryRead(pg.read, 'SELECT id, value FROM public.write_items WHERE id IN ($1, $2) ORDER BY id', [101, 102], 10);
    const mysqlRows = await queryRead(mysql.read, 'SELECT id, value FROM write_items WHERE id IN (?, ?) ORDER BY id', [101, 102], 10);
    expect(pgRows.rows).toEqual([[101, 'pg-one'], [102, 'pg-two']]);
    expect(mysqlRows.rows).toEqual([[101, 'mysql-one'], [102, 'mysql-two']]);
  });

  it('updates targeted rows in both dialects', async () => {
    await insertRows(pg.write, 'public', 'write_items', [{ id: 201, value: 'before' }]);
    await insertRows(mysql.write, undefined, 'write_items', [{ id: 201, value: 'before' }]);

    await expect(updateRows(pg.write, 'public', 'write_items', { value: 'after' }, { id: 201 })).resolves.toEqual({ affectedRows: 1 });
    await expect(updateRows(mysql.write, undefined, 'write_items', { value: 'after' }, { id: 201 })).resolves.toEqual({ affectedRows: 1 });

    expect((await queryRead(pg.read, 'SELECT value FROM public.write_items WHERE id = $1', [201], 10)).rows).toEqual([['after']]);
    expect((await queryRead(mysql.read, 'SELECT value FROM write_items WHERE id = ?', [201], 10)).rows).toEqual([['after']]);
  });

  it('deletes targeted rows in both dialects', async () => {
    await insertRows(pg.write, 'public', 'write_items', [{ id: 301, value: 'delete-me' }]);
    await insertRows(mysql.write, undefined, 'write_items', [{ id: 301, value: 'delete-me' }]);

    await expect(deleteRows(pg.write, 'public', 'write_items', { id: 301 })).resolves.toEqual({ affectedRows: 1 });
    await expect(deleteRows(mysql.write, undefined, 'write_items', { id: 301 })).resolves.toEqual({ affectedRows: 1 });

    expect((await queryRead(pg.read, 'SELECT id FROM public.write_items WHERE id = $1', [301], 10)).rowCount).toBe(0);
    expect((await queryRead(mysql.read, 'SELECT id FROM write_items WHERE id = ?', [301], 10)).rowCount).toBe(0);
  });

  it('rolls back PostgreSQL and MySQL mutations that exceed the affected-row limit', async () => {
    const guardedPg = directWritableConnection('pg_guarded', pgReadUrl!, pgWriteUrl!, 1);
    const guardedMysql = directWritableConnection('mysql_guarded', mysqlReadUrl!, mysqlWriteUrl!, 1);
    await insertRows(guardedPg.write, 'public', 'write_items', [
      { id: 401, value: 'before' },
      { id: 402, value: 'before' }
    ]);
    await insertRows(guardedMysql.write, undefined, 'write_items', [
      { id: 401, value: 'before' },
      { id: 402, value: 'before' }
    ]);

    await expect(updateRows(guardedPg.write, 'public', 'write_items', { value: 'blocked' }, { id: { in: [401, 402] } })).rejects.toMatchObject({ code: 'WRITE_LIMIT_EXCEEDED' });
    await expect(updateRows(guardedMysql.write, undefined, 'write_items', { value: 'blocked' }, { id: { in: [401, 402] } })).rejects.toMatchObject({ code: 'WRITE_LIMIT_EXCEEDED' });

    expect((await queryRead(guardedPg.read, 'SELECT value FROM public.write_items WHERE id IN ($1, $2) ORDER BY id', [401, 402], 10)).rows).toEqual([['before'], ['before']]);
    expect((await queryRead(guardedMysql.read, 'SELECT value FROM write_items WHERE id IN (?, ?) ORDER BY id', [401, 402], 10)).rows).toEqual([['before'], ['before']]);
  });

  it('preserves PostgreSQL RLS for the writer identity', async () => {
    await expect(updateRows(pg.write, 'public', 'users', { email: 'hidden-change@example.com' }, { id: 2 })).resolves.toEqual({ affectedRows: 0 });
    await expect(updateRows(pg.write, 'public', 'users', { email: 'visible-change@example.com' }, { id: 1 })).resolves.toEqual({ affectedRows: 1 });
    await expect(insertRows(pg.write, 'public', 'users', [{ id: 10, tenant_id: 2, email: 'blocked@example.com' }])).rejects.toBeTruthy();

    const visible = await queryRead(pg.read, 'SELECT id, email FROM public.users ORDER BY id', [], 10);
    expect(visible.rows).toContainEqual([1, 'visible-change@example.com']);
    expect(visible.rows.some(row => row[0] === 2 || row[0] === 10)).toBe(false);
  });

  it('writer identities still reject DDL and dangerous routine execution', async () => {
    const pgClient = new PgClient({ connectionString: pgWriteUrl!, ssl: false });
    await pgClient.connect();
    try {
      await expect(pgClient.query('CREATE TABLE public.forbidden_writer_table (id integer)')).rejects.toBeTruthy();
      await expect(pgClient.query('SELECT public.dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await pgClient.end();
    }

    const url = new URL(mysqlWriteUrl!);
    const mysqlClient = await createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      disableEval: true
    });
    try {
      await expect(mysqlClient.query('CREATE TABLE forbidden_writer_table (id INT)')).rejects.toBeTruthy();
      await expect(mysqlClient.query('CALL dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await mysqlClient.end();
    }
  });
});
