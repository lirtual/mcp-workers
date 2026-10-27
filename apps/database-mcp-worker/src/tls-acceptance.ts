import { createMysqlClient, createPostgresClient } from './db/clients.js';
import type { EffectiveConnection, Dialect } from './types.js';

// Disposable Aiven-only Cloudflare Workers proof. Never deploy as the production Worker.
interface ProbeEnv {
  PROBE_TOKEN: string;
  PG_PASSWORD: string;
  MYSQL_PASSWORD: string;
  PG_CA?: string;
  MYSQL_CA?: string;
}
function connection(dialect: Dialect, env: ProbeEnv): EffectiveConnection {
  const postgres = dialect === 'postgres';
  const host = postgres ? 'postgresql-zeroverse.d.aivencloud.com' : 'mysql-zeroverse.d.aivencloud.com';
  const database = postgres ? 'database-mcp-test-postgres' : 'database-mcp-test-mysql';
  const url = (postgres ? 'postgres:' : 'mysql:') + '//test@' + host + ':18691/' + database;
  return {
    config: { id: 'spec344-disposable-' + dialect, transport: 'direct', url },
    transport: 'direct', dialect, connectionString: url, host, port: 18691,
    user: 'test', password: postgres ? env.PG_PASSWORD : env.MYSQL_PASSWORD,
    database, ...(postgres ? (env.PG_CA ? { ca: env.PG_CA } : {}) : (env.MYSQL_CA ? { ca: env.MYSQL_CA } : {})),
    limits: { maxRows: 10, maxResultBytes: 10000, maxSchemaBytes: 10000, queryTimeoutMs: 15000 }
  };
}
async function prove(dialect: Dialect, env: ProbeEnv) {
  const c = connection(dialect, env);
  const table = 'spec344_tls_probe';
  if (dialect === 'postgres') {
    const client = createPostgresClient(c);
    try {
      await client.connect();
      const tls = await client.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
      if (tls.rows[0]?.ssl !== true) throw Error('tls_not_established');
      await client.query('SELECT 1');
      await client.query('CREATE TABLE IF NOT EXISTS ' + table + ' (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
      try {
        await client.query('DELETE FROM ' + table + ' WHERE id=344');
        await client.query('INSERT INTO ' + table + ' (id,value) VALUES ($1,$2)', [344, 1]);
        await client.query('UPDATE ' + table + ' SET value=$1 WHERE id=$2', [2,344]);
        const rows = await client.query('SELECT value FROM ' + table + ' WHERE id=$1', [344]);
        if (rows.rows[0]?.value !== 2) throw Error('incorrect_select');
        await client.query('ALTER TABLE ' + table + ' ADD COLUMN IF NOT EXISTS note TEXT');
        await client.query('DELETE FROM ' + table + ' WHERE id=$1', [344]);
      } finally { await client.query('DROP TABLE IF EXISTS ' + table); }
    } finally { await client.end().catch(() => undefined); }
  } else {
    const client = await createMysqlClient(c);
    try {
      const [tls] = await client.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      const cipher = (tls as Array<{Value: string}>)[0]?.Value;
      if (!cipher) throw Error('tls_not_established');
      await client.query('SELECT 1');
      await client.query('CREATE TABLE IF NOT EXISTS ' + table + ' (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
      try {
        await client.query('DELETE FROM ' + table + ' WHERE id=?', [344]);
        await client.query('INSERT INTO ' + table + ' (id,value) VALUES (?,?)', [344, 1]);
        await client.query('UPDATE ' + table + ' SET value=? WHERE id=?', [2,344]);
        const [rows] = await client.query('SELECT value FROM ' + table + ' WHERE id=?', [344]);
        if ((rows as Array<{value:number}>)[0]?.value !== 2) throw Error('incorrect_select');
        await client.query('ALTER TABLE ' + table + ' ADD COLUMN note TEXT');
        await client.query('DELETE FROM ' + table + ' WHERE id=?', [344]);
      } finally { await client.query('DROP TABLE IF EXISTS ' + table); }
    } finally { await client.end().catch(() => undefined); }
  }
  return { dialect, tls: 'verified_by_driver_and_server', health: true, read: true, write: true, ddl: true };
}
export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/run') return new Response('Not found', {status:404});
    if (!env.PROBE_TOKEN || request.headers.get('authorization') !== 'Bearer ' + env.PROBE_TOKEN) return new Response('Forbidden', {status:403});
    const results = [];
    for (const dialect of ['postgres','mysql'] as const) {
      try { results.push(await prove(dialect, env)); }
      catch (error) {
        // No exception text, stack, connection URL, database credentials or CA material.
        results.push({dialect, ok:false, failure:'runtime_failure', code: typeof error === 'object' && error !== null && 'code' in error ? String((error as {code?:unknown}).code).slice(0,50) : 'unknown'});
      }
    }
    return Response.json({runtime:'cloudflare-workers', results}, {headers:{'Cache-Control':'no-store'}});
  }
};
