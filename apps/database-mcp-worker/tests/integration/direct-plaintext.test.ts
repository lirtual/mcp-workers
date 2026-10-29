import { describe, expect, it } from 'vitest';
import { deleteRows, healthCheck, insertRows, queryRead, updateRows } from '../../src/db/index.js';
import { createMysqlClient, createPostgresClient } from '../../src/db/clients.js';
import { parseDatabaseConfig } from '../helpers/catalog.js';
import { resolveConnection } from '../../src/config.js';
import type { Env } from '../../src/types.js';

const postgres = process.env.TEST_POSTGRES_READ_URL;
const mysql = process.env.TEST_MYSQL_READ_URL;
const enabled = postgres && mysql ? describe : describe.skip;
function connection(id: string, raw: string) {
  const env: Env = { RATE_LIMITER: { async limit() { return { success: true }; } } };
  return resolveConnection(env, parseDatabaseConfig(JSON.stringify({ [id]: raw })), id);
}
enabled('Direct plaintext fixture integration (NOT a deployed Workers acceptance)', () => {
  if (!postgres || !mysql) { it.skip('requires plaintext fixture URLs', () => {}); return; }
  const pg = connection('pg', postgres!);
  const my = connection('my', mysql!);
  it('runs both health checks without transport TLS', async () => {
    await expect(healthCheck(pg)).resolves.toHaveProperty('latencyMs');
    await expect(healthCheck(my)).resolves.toHaveProperty('latencyMs');
  });
  it('proves that PostgreSQL and MySQL sessions use plaintext', async () => {
    const p = createPostgresClient(pg);
    await p.connect();
    try {
      const r = await p.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      expect(r.rows[0]?.ssl).toBe(false);
    } finally { await p.end(); }
    const m = await createMysqlClient(my);
    try {
      const [rows] = await m.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      expect(Array.isArray(rows)).toBe(true);
      const first = (rows as unknown[])[0];
      const cipher = Array.isArray(first) ? first[1]
        : first && typeof first === 'object' ? (first as Record<string, unknown>).Value : undefined;
      expect(cipher).toBe('');
    } finally { await m.end(); }
  });
});

const writeMysql = process.env.TEST_MYSQL_WRITE_URL;
const hyperdriveAdapter = writeMysql ? describe : describe.skip;
hyperdriveAdapter('MySQL Hyperdrive adapter using local plaintext proxy SIMULATION (not real Cloudflare)', () => {
  if (!writeMysql) { it.skip('requires isolated MySQL proxy fixture URL', () => {}); return; }
  const local = connection('simulated_mysql_proxy', writeMysql!);
  const proxy = { ...local, transport: 'hyperdrive' as const };
  const writer = { ...proxy, maxAffectedRows: 20 };
  it('pins SQL mode then safely escapes quotes/backslashes and blocks injection', async () => {
    const id = 903344;
    const special = "A'B \\ Z \" Q";
    await expect(insertRows(writer, undefined, 'write_items', [{ id, value: special }]))
      .resolves.toEqual({ affectedRows: 1 });
    try {
      expect((await queryRead(proxy, 'SELECT value FROM write_items WHERE id = ?', [id], 5)).rows)
        .toEqual([[special]]);
      expect((await queryRead(proxy, 'SELECT id FROM write_items WHERE value = ?', ["' OR 1=1 -- "], 5)).rows)
        .toEqual([]);
    } finally {
      await deleteRows(writer, undefined, 'write_items', { id });
    }
  });
});


const readPostgres = process.env.TEST_POSTGRES_READ_URL;
const writePostgres = process.env.TEST_POSTGRES_WRITE_URL;
const postgresHyperdriveAdapter = readPostgres && writePostgres ? describe : describe.skip;
postgresHyperdriveAdapter('PostgreSQL Hyperdrive adapter over local plaintext proxy SIMULATION (not real Cloudflare)', () => {
  if (!readPostgres || !writePostgres) {
    it.skip('requires isolated PostgreSQL read and write fixture URLs', () => {});
    return;
  }
  const reader = { ...connection('simulated_pg_proxy_reader', readPostgres), transport: 'hyperdrive' as const };
  const writer = {
    ...connection('simulated_pg_proxy_writer', writePostgres),
    transport: 'hyperdrive' as const,
    maxAffectedRows: 1
  };
  const cleanupWriter = { ...writer, maxAffectedRows: 20 };

  it('performs a health check and parameterized reads while preserving PostgreSQL RLS', async () => {
    await expect(healthCheck(reader)).resolves.toMatchObject({ ok: true });
    expect((await queryRead(reader, 'SELECT id, tenant_id FROM public.users WHERE id = $1', [1], 5)).rows)
      .toEqual([[1, 1]]);
    expect((await queryRead(reader, 'SELECT id, tenant_id FROM public.users WHERE id = $1', [2], 5)).rows)
      .toEqual([]);
  });

  it('round-trips quotes, backslashes, Unicode, and SQL-like input through parameterized writes', async () => {
    const id = 933344;
    const original = "quote ' and backslash \\ 中文 ; --";
    const updated = "' OR TRUE -- ; DROP TABLE write_items; \\";
    await expect(insertRows(writer, 'public', 'write_items', [{ id, value: original }]))
      .resolves.toEqual({ affectedRows: 1 });
    try {
      expect((await queryRead(reader, 'SELECT value FROM public.write_items WHERE id = $1', [id], 5)).rows)
        .toEqual([[original]]);
      await expect(updateRows(writer, 'public', 'write_items', { value: updated }, { id }))
        .resolves.toEqual({ affectedRows: 1 });
      expect((await queryRead(reader, 'SELECT value FROM public.write_items WHERE id = $1', [id], 5)).rows)
        .toEqual([[updated]]);
    } finally {
      await deleteRows(cleanupWriter, 'public', 'write_items', { id });
    }
  });

  it('rolls back PostgreSQL UPDATE and DELETE exceeding the affected-row cap', async () => {
    const ids = [943344, 953344];
    await insertRows(cleanupWriter, 'public', 'write_items',
      ids.map(id => ({ id, value: 'before' })));
    try {
      await expect(updateRows(writer, 'public', 'write_items', { value: 'after' }, { id: { in: ids } }))
        .rejects.toMatchObject({ code: 'WRITE_LIMIT_EXCEEDED' });
      expect((await queryRead(reader,
        'SELECT id, value FROM public.write_items WHERE id IN ($1, $2) ORDER BY id', ids, 5)).rows)
        .toEqual(ids.map(id => [id, 'before']));

      await expect(deleteRows(writer, 'public', 'write_items', { id: { in: ids } }))
        .rejects.toMatchObject({ code: 'WRITE_LIMIT_EXCEEDED' });
      expect((await queryRead(reader,
        'SELECT id, value FROM public.write_items WHERE id IN ($1, $2) ORDER BY id', ids, 5)).rows)
        .toEqual(ids.map(id => [id, 'before']));
    } finally {
      await deleteRows(cleanupWriter, 'public', 'write_items', { id: { in: ids } });
    }
  });
});
