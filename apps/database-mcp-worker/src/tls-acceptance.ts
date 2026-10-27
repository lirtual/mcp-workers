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
async function prove(dialect: Dialect, env: ProbeEnv, progress: { stage: string }) {
  const c = connection(dialect, env);
  const table = 'spec344_tls_probe';
  if (dialect === 'postgres') {
    progress.stage = 'postgres_client_construction';
    const client = createPostgresClient(c);
    try {
      progress.stage = 'postgres_connect';
      await client.connect();
      progress.stage = 'postgres_tls_session_check';
      const tls = await client.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
      if (tls.rows[0]?.ssl !== true) throw Error('tls_not_established');
      progress.stage = 'read';
      await client.query('SELECT 1');
      progress.stage = 'ddl_create';
      await client.query('CREATE TABLE IF NOT EXISTS ' + table + ' (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
      try {
        await client.query('DELETE FROM ' + table + ' WHERE id=344');
        progress.stage = 'write';
        await client.query('INSERT INTO ' + table + ' (id,value) VALUES ($1,$2)', [344, 1]);
        await client.query('UPDATE ' + table + ' SET value=$1 WHERE id=$2', [2,344]);
        const rows = await client.query('SELECT value FROM ' + table + ' WHERE id=$1', [344]);
        if (rows.rows[0]?.value !== 2) throw Error('incorrect_select');
        await client.query('ALTER TABLE ' + table + ' ADD COLUMN IF NOT EXISTS note TEXT');
        await client.query('DELETE FROM ' + table + ' WHERE id=$1', [344]);
      } finally { await client.query('DROP TABLE IF EXISTS ' + table); }
    } finally { await client.end().catch(() => undefined); }
  } else {
    progress.stage = 'mysql_connect';
    const client = await createMysqlClient(c);
    try {
      progress.stage = 'mysql_tls_session_check';
      const [tls] = await client.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
      const cipher = (tls as Array<{Value: string}>)[0]?.Value;
      if (!cipher) throw Error('tls_not_established');
      progress.stage = 'read';
      await client.query('SELECT 1');
      progress.stage = 'ddl_create';
      await client.query('CREATE TABLE IF NOT EXISTS ' + table + ' (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
      try {
        await client.query('DELETE FROM ' + table + ' WHERE id=?', [344]);
        progress.stage = 'write';
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
      const progress = { stage: 'initialization' };
      try { results.push(await prove(dialect, env, progress)); }
      catch (error) {
        // Static stage/category only. Never return raw message, stack or secret values.
        const msg = error instanceof Error ? error.message : '';
        const rawCode = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
        const code = /^[A-Z][A-Z0-9_]{1,60}$/.test(rawCode) ? rawCode : 'unknown';
        const kind = /not implemented|unsupported|checkServerIdentity/i.test(msg) ? 'unsupported_api' :
          /certificate|issuer|self.signed|verify|untrusted|authority/i.test(msg) ? 'certificate_validation' :
          /password|auth|SCRAM|permission/i.test(msg) ? 'authentication' :
          /timed? ?out|timeout/i.test(msg) ? 'timeout' :
          /socket|closed|disconnect|terminated/i.test(msg) ? 'connection_terminated' :
          /ssl|tls/i.test(msg) ? 'tls_negotiation' : 'unknown';
        const errorType = error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'non_error';
        results.push({ dialect, ok:false, failure:'runtime_failure', stage:progress.stage, errorType, kind, code });
      }
    }
    return Response.json({runtime:'cloudflare-workers', results}, {headers:{'Cache-Control':'no-store'}});
  }
};
