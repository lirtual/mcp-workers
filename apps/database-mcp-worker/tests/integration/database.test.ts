import { Client as PgClient } from 'pg';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { parseConnectionCatalog, resolveConnection, resolveWriteConnection } from '../../src/config.js';
import { deleteRows, explainRead, insertRows, inspectSchema, queryRead, updateRows } from '../../src/db/index.js';
import type { EffectiveConnection, EffectiveWriteConnection, Env } from '../../src/types.js';

interface ConnectionPair {
  read: EffectiveConnection;
  write: EffectiveWriteConnection;
}

function directConnections(
  id: string,
  readUrl: string,
  writeUrl: string,
  maxAffectedRows = 20
): ConnectionPair {
  const readSecret = 'TEST_READ_DATABASE_URL';
  const writeSecret = 'TEST_WRITE_DATABASE_URL';
  const env: Env = {
    CONNECTIONS_JSON: '[]',
    RATE_LIMITER: { async limit() { return { success: true }; } },
    [readSecret]: readUrl,
    [writeSecret]: writeUrl
  };
  const catalog = parseConnectionCatalog(JSON.stringify([
    {
      id,
      displayName: id,
      transport: 'direct',
      urlSecret: readSecret,
      enabled: true,
      write: { transport: 'direct', urlSecret: writeSecret, maxAffectedRows }
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
const describeIntegration = pgReadUrl && pgWriteUrl && mysqlReadUrl && mysqlWriteUrl ? describe : describe.skip;

describeIntegration('real database safe read/write integration', () => {
  const pg = directConnections('pg', pgReadUrl!, pgWriteUrl!);
  const mysql = directConnections('mysql', mysqlReadUrl!, mysqlWriteUrl!);

  it('resolves separate read and write SQL URL Secrets for both dialects', () => {
    expect(pg.read).toMatchObject({ transport: 'direct', dialect: 'postgres', user: 'mcp_reader' });
    expect(pg.write).toMatchObject({ transport: 'direct', dialect: 'postgres', user: 'mcp_writer' });
    expect(mysql.read).toMatchObject({ transport: 'direct', dialect: 'mysql', user: 'mcp_reader' });
    expect(mysql.write).toMatchObject({ transport: 'direct', dialect: 'mysql', user: 'mcp_writer' });
  });

  it('queries PostgreSQL through the read adapter and preserves RLS', async () => {
    const result = await queryRead(pg.read, 'SELECT id, tenant_id, email FROM public.users ORDER BY id', [], 10);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.[0]).toBe(1);
  });

  it('queries MySQL through the read adapter', async () => {
    const result = await queryRead(mysql.read, 'SELECT id, email FROM users ORDER BY id', [], 10);
    expect(result.rowCount).toBe(2);
  });

  it('inspects table metadata in both dialects', async () => {
    const pgSchema = await inspectSchema(pg.read, 'public', 'users');
    const mySchema = await inspectSchema(mysql.read, mysql.read.database, 'users');
    expect(pgSchema.columns?.some(column => column.name === 'email')).toBe(true);
    expect(mySchema.columns?.some(column => column.name === 'email')).toBe(true);
  });

  it('returns non-ANALYZE plans', async () => {
    expect(await explainRead(pg.read, 'SELECT * FROM public.users WHERE id = $1', [1])).toBeTruthy();
    expect(await explainRead(mysql.read, 'SELECT * FROM users WHERE id = ?', [1])).toBeTruthy();
  });

  it('inserts rows through separate PostgreSQL and MySQL writer credentials', async () => {
    await expect(insertRows(pg.write, 'public', 'write_items', [
      { id: 201, tenant_id: 1, value: 'inserted', note: null }
    ])).resolves.toMatchObject({ affectedRows: 1 });
    await expect(insertRows(mysql.write, 'testdb', 'write_items', [
      { id: 201, tenant_id: 1, value: 'inserted', note: null }
    ])).resolves.toMatchObject({ affectedRows: 1 });

    const pgRead = await queryRead(pg.read, 'SELECT value FROM public.write_items WHERE id = $1', [201], 5);
    const myRead = await queryRead(mysql.read, 'SELECT value FROM write_items WHERE id = ?', [201], 5);
    expect(pgRead.rows[0]?.[0]).toBe('inserted');
    expect(myRead.rows[0]?.[0]).toBe('inserted');
  });

  it('updates targeted rows in both dialects', async () => {
    await expect(updateRows(pg.write, 'public', 'write_items', { value: 'updated' }, { id: 103 })).resolves.toEqual({
      affectedRows: 1
    });
    await expect(updateRows(mysql.write, 'testdb', 'write_items', { value: 'updated' }, { id: 103 })).resolves.toEqual({
      affectedRows: 1
    });

    const pgRead = await queryRead(pg.read, 'SELECT value FROM public.write_items WHERE id = $1', [103], 5);
    const myRead = await queryRead(mysql.read, 'SELECT value FROM write_items WHERE id = ?', [103], 5);
    expect(pgRead.rows[0]?.[0]).toBe('updated');
    expect(myRead.rows[0]?.[0]).toBe('updated');
  });

  it('deletes targeted rows in both dialects', async () => {
    await expect(deleteRows(pg.write, 'public', 'write_items', { id: 104 })).resolves.toEqual({ affectedRows: 1 });
    await expect(deleteRows(mysql.write, 'testdb', 'write_items', { id: 104 })).resolves.toEqual({ affectedRows: 1 });

    expect((await queryRead(pg.read, 'SELECT id FROM public.write_items WHERE id = $1', [104], 5)).rowCount).toBe(0);
    expect((await queryRead(mysql.read, 'SELECT id FROM write_items WHERE id = ?', [104], 5)).rowCount).toBe(0);
  });

  it('rolls back UPDATE when the affected-row limit is exceeded', async () => {
    const lowPg = directConnections('pg-low-update', pgReadUrl!, pgWriteUrl!, 1);
    const lowMysql = directConnections('mysql-low-update', mysqlReadUrl!, mysqlWriteUrl!, 1);

    await expect(updateRows(lowPg.write, 'public', 'write_items', { note: 'changed' }, { value: 'bulk' })).rejects.toMatchObject({
      code: 'WRITE_LIMIT_EXCEEDED'
    });
    await expect(updateRows(lowMysql.write, 'testdb', 'write_items', { note: 'changed' }, { value: 'bulk' })).rejects.toMatchObject({
      code: 'WRITE_LIMIT_EXCEEDED'
    });

    const pgCount = await queryRead(pg.read, "SELECT count(*) FROM public.write_items WHERE value = 'bulk' AND note IS NULL", [], 5);
    const myCount = await queryRead(mysql.read, "SELECT count(*) FROM write_items WHERE value = 'bulk' AND note IS NULL", [], 5);
    expect(String(pgCount.rows[0]?.[0])).toBe('2');
    expect(String(myCount.rows[0]?.[0])).toBe('2');
  });

  it('rolls back DELETE when the affected-row limit is exceeded', async () => {
    const lowPg = directConnections('pg-low-delete', pgReadUrl!, pgWriteUrl!, 1);
    const lowMysql = directConnections('mysql-low-delete', mysqlReadUrl!, mysqlWriteUrl!, 1);

    await expect(deleteRows(lowPg.write, 'public', 'write_items', { value: 'delete-bulk' })).rejects.toMatchObject({
      code: 'WRITE_LIMIT_EXCEEDED'
    });
    await expect(deleteRows(lowMysql.write, 'testdb', 'write_items', { value: 'delete-bulk' })).rejects.toMatchObject({
      code: 'WRITE_LIMIT_EXCEEDED'
    });

    const pgCount = await queryRead(pg.read, "SELECT count(*) FROM public.write_items WHERE value = 'delete-bulk'", [], 5);
    const myCount = await queryRead(mysql.read, "SELECT count(*) FROM write_items WHERE value = 'delete-bulk'", [], 5);
    expect(String(pgCount.rows[0]?.[0])).toBe('2');
    expect(String(myCount.rows[0]?.[0])).toBe('2');
  });

  it('preserves PostgreSQL writer RLS', async () => {
    await expect(insertRows(pg.write, 'public', 'write_items', [
      { id: 205, tenant_id: 2, value: 'blocked', note: null }
    ])).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('database-native read credentials still reject writes and side-effecting routines', async () => {
    const pgClient = new PgClient({ connectionString: pgReadUrl!, ssl: false });
    await pgClient.connect();
    try {
      await expect(pgClient.query("UPDATE public.users SET email = 'changed' WHERE id = 1")).rejects.toBeTruthy();
      await expect(pgClient.query('SELECT public.dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await pgClient.end();
    }

    const url = new URL(mysqlReadUrl!);
    const mysqlClient = await createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      disableEval: true
    });
    try {
      await expect(mysqlClient.query("UPDATE users SET email = 'changed' WHERE id = 1")).rejects.toBeTruthy();
      await expect(mysqlClient.query('CALL dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await mysqlClient.end();
    }
  });

  it('database-native writer credentials reject DDL and arbitrary routines', async () => {
    const pgClient = new PgClient({ connectionString: pgWriteUrl!, ssl: false });
    await pgClient.connect();
    try {
      await expect(pgClient.query('DROP TABLE public.users')).rejects.toBeTruthy();
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
      database: url.pathname.slice(1),
      disableEval: true
    });
    try {
      await expect(mysqlClient.query('DROP TABLE users')).rejects.toBeTruthy();
      await expect(mysqlClient.query('CALL dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await mysqlClient.end();
    }
  });
});
