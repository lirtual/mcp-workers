import { Client as PgClient } from 'pg';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { parseDatabaseConfigWithAdmin, resolveAdminConnection } from '../../src/admin-config.js';
import {
  alterTable,
  createIndex,
  createTable,
  dropIndex,
  dropTable
} from '../../src/db/index.js';
import type { EffectiveAdminConnection, Env } from '../../src/types.js';

function env(): Env {
  return { RATE_LIMITER: { async limit() { return { success: true }; } } };
}

function limitedUrl(adminUrl: string, username: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

function adminConnection(id: string, readUrl: string, adminUrl: string): EffectiveAdminConnection {
  const catalog = parseDatabaseConfigWithAdmin(JSON.stringify({
    [id]: { read: readUrl, admin: adminUrl }
  }));
  return resolveAdminConnection(env(), catalog, id);
}

const pgRootUrl = process.env.TEST_POSTGRES_ADMIN_URL;
const pgReadUrl = process.env.TEST_POSTGRES_READ_URL;
const mysqlRootUrl = process.env.TEST_MYSQL_ADMIN_URL;
const mysqlReadUrl = process.env.TEST_MYSQL_READ_URL;
const enabled = pgRootUrl && pgReadUrl && mysqlRootUrl && mysqlReadUrl ? describe : describe.skip;

enabled('real database Safe Admin/DDL integration', () => {
  const pgAdminUrl = limitedUrl(pgRootUrl!, 'mcp_admin', 'admin');
  const mysqlAdminUrl = limitedUrl(mysqlRootUrl!, 'mcp_admin', 'admin');
  const pg = adminConnection('pg_admin', pgReadUrl!, pgAdminUrl);
  const mysql = adminConnection('mysql_admin', mysqlReadUrl!, mysqlAdminUrl);

  it('resolves dedicated ADMIN credentials without promoting read credentials', () => {
    expect(pg).toMatchObject({ dialect: 'postgres', user: 'mcp_admin', transport: 'direct' });
    expect(mysql).toMatchObject({ dialect: 'mysql', user: 'mcp_admin', transport: 'direct' });
  });

  it('runs the supported PostgreSQL structured DDL lifecycle', async () => {
    await createTable(pg, 'mcp_admin_test', 'admin_items', [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'name', type: 'varchar', length: 80, nullable: false }
    ]);
    await alterTable(pg, 'mcp_admin_test', 'admin_items', {
      action: 'add_column',
      column: { name: 'enabled', type: 'boolean', default: true }
    });
    await alterTable(pg, 'mcp_admin_test', 'admin_items', {
      action: 'rename_column', column: 'name', newName: 'label'
    });
    await createIndex(pg, 'mcp_admin_test', 'admin_items', ['label'], false, 'admin_items_label_idx');
    await dropIndex(pg, 'mcp_admin_test', 'admin_items', 'admin_items_label_idx');
    await alterTable(pg, 'mcp_admin_test', 'admin_items', { action: 'drop_column', column: 'enabled' });
    await alterTable(pg, 'mcp_admin_test', 'admin_items', { action: 'rename_table', newName: 'admin_items_renamed' });
    await expect(dropTable(pg, 'mcp_admin_test', 'admin_items_renamed')).resolves.toEqual({
      ok: true, operation: 'drop_table'
    });
  });

  it('runs the supported MySQL structured DDL lifecycle', async () => {
    await createTable(mysql, undefined, 'admin_items', [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'name', type: 'varchar', length: 80, nullable: false }
    ]);
    await alterTable(mysql, undefined, 'admin_items', {
      action: 'add_column', column: { name: 'enabled', type: 'boolean', default: true }
    });
    await alterTable(mysql, undefined, 'admin_items', {
      action: 'rename_column', column: 'name', newName: 'label'
    });
    await createIndex(mysql, undefined, 'admin_items', ['label'], false, 'admin_items_label_idx');
    await dropIndex(mysql, undefined, 'admin_items', 'admin_items_label_idx');
    await alterTable(mysql, undefined, 'admin_items', { action: 'drop_column', column: 'enabled' });
    await alterTable(mysql, undefined, 'admin_items', { action: 'rename_table', newName: 'admin_items_renamed' });
    await expect(dropTable(mysql, undefined, 'admin_items_renamed')).resolves.toEqual({
      ok: true, operation: 'drop_table'
    });
  });

  it('ADMIN identities cannot perform out-of-scope user/role administration', async () => {
    const pgClient = new PgClient({ connectionString: pgAdminUrl, ssl: false });
    await pgClient.connect();
    try {
      await expect(pgClient.query('CREATE ROLE forbidden_admin_role')).rejects.toBeTruthy();
    } finally {
      await pgClient.end();
    }

    const url = new URL(mysqlAdminUrl);
    const mysqlClient = await createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      disableEval: true
    });
    try {
      await expect(mysqlClient.query("CREATE USER 'forbidden_admin_user'@'%' IDENTIFIED BY 'x'")).rejects.toBeTruthy();
    } finally {
      await mysqlClient.end();
    }
  });
});
