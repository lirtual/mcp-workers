import { Client as PgClient } from 'pg';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { explainRead, inspectSchema, queryRead } from '../../src/db/index.js';
import type { Dialect, EffectiveConnection } from '../../src/types.js';

function directConnection(id: string, dialect: Dialect, raw: string): EffectiveConnection {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.slice(1));
  return {
    config: {
      id,
      displayName: id,
      transport: 'direct',
      urlSecret: 'TEST_DATABASE_URL',
      enabled: true,
      defaultSchema: dialect === 'postgres' ? 'public' : database
    },
    transport: 'direct',
    dialect,
    connectionString: raw,
    host: url.hostname,
    port: Number(url.port || (dialect === 'postgres' ? 5432 : 3306)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    limits: { maxRows: 50, maxResultBytes: 256_000, maxSchemaBytes: 256_000, queryTimeoutMs: 2_000 }
  };
}

const pgReadUrl = process.env.TEST_POSTGRES_READ_URL;
const mysqlReadUrl = process.env.TEST_MYSQL_READ_URL;
const describeIntegration = pgReadUrl && mysqlReadUrl ? describe : describe.skip;

describeIntegration('real database read-only integration', () => {
  const pg = directConnection('pg', 'postgres', pgReadUrl!);
  const mysql = directConnection('mysql', 'mysql', mysqlReadUrl!);

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

  it('database-native PostgreSQL permissions reject writes and side-effecting function execution', async () => {
    const client = new PgClient({ connectionString: pgReadUrl!, ssl: false });
    await client.connect();
    try {
      await expect(client.query("UPDATE public.users SET email = 'changed' WHERE id = 1")).rejects.toBeTruthy();
      await expect(client.query('SELECT public.dangerous_bump()')).rejects.toBeTruthy();
    } finally {
      await client.end();
    }
  });

  it('database-native MySQL permissions reject writes and stored routine execution', async () => {
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
