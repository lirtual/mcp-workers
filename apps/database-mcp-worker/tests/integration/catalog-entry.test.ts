import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type * as DatabaseClients from '../../src/db/clients.js';
import type { EffectiveConnection, Env } from '../../src/types.js';
import worker from '../../src/index.js';

// Only the TCP destination is routed to isolated local fixtures. The real
// catalog, public-address admission, MCP handlers, SQL guards and DB drivers run.
// This is not a production networking waiver or a mocked SQL result.
vi.mock('../../src/db/clients.js', async original => {
  const clients = await original<typeof DatabaseClients>();
  function fixtureDial(connection: EffectiveConnection): EffectiveConnection {
    if (connection.transport !== 'direct' || connection.dialHost !== '8.8.8.8') {
      throw new Error('Expected the synthetic public endpoint admitted by the real guard');
    }
    const fixture = new URL(connection.dialect === 'mysql'
      ? process.env.TEST_MYSQL_READ_URL! : process.env.TEST_POSTGRES_READ_URL!);
    if (fixture.hostname !== '127.0.0.1' || connection.port !== Number(fixture.port)) {
      throw new Error('Integration routing is restricted to the isolated local fixture');
    }
    return { ...connection, dialHost: fixture.hostname };
  }
  return {
    createMysqlClient: (connection: EffectiveConnection, rowsAsArray?: boolean) =>
      clients.createMysqlClient(fixtureDial(connection), rowsAsArray),
    createPostgresClient: (connection: EffectiveConnection) =>
      clients.createPostgresClient(fixtureDial(connection))
  };
});

const postgres = process.env.TEST_POSTGRES_READ_URL;
const mysql = process.env.TEST_MYSQL_READ_URL;
const integration = postgres && mysql ? describe : describe.skip;

integration('DATABASE_CONNECTIONS to authenticated MCP to real SQL', () => {
  for (const [id, dialect, raw, secretName] of [
    ['mysql', 'mysql', mysql, 'DATABASE_B2B_PASSWORD'],
    ['postgres', 'postgresql', postgres, 'DATABASE_SCRAPE_RELAY_PASSWORD']
  ] as const) {
    it(`${id}: resolves named credentials, checks health and executes bounded SELECT 1`, async () => {
      const fixture = new URL(raw!);
      const passwordReference = '${' + secretName + '}';
      const template = `${dialect}://${fixture.username}:${passwordReference}@#{DB_HOST}:${fixture.port}${fixture.pathname}`;
      const env: Env = {
        DATABASE_CONNECTIONS: JSON.stringify({ [id]: template }),
        [secretName]: decodeURIComponent(fixture.password),
        DB_HOST: '8.8.8.8', MCP_ACCESS_TOKEN: 'synthetic-integration-token',
        RATE_LIMITER: { limit: async () => ({ success: true }) }
      };
      const client = new Client({ name: 'real-catalog-integration', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL('https://fixture.invalid/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer synthetic-integration-token' } },
        fetch: async (input, init) => worker.fetch(new Request(input, init), env, {} as ExecutionContext)
      });
      try {
        await client.connect(transport);
        const health = await client.callTool({ name: 'health_check', arguments: { connection: id } });
        expect(health.isError).not.toBe(true);
        expect(health.structuredContent).toMatchObject({ ok: true });
        const read = await client.callTool({ name: 'query_read', arguments: {
          connection: id, sql: 'SELECT 1 AS value', rowLimit: 1
        } });
        expect(read.isError).not.toBe(true);
        expect(read.structuredContent).toMatchObject({ rows: [[1]], rowCount: 1 });
        // The driver must authenticate with the newly resolved Secret, not fixture defaults or a cached admission.
        env[secretName] = 'synthetic-wrong-password';
        const wrong = await client.callTool({ name: 'health_check', arguments: { connection: id } });
        expect(wrong.isError).toBe(true);
        expect(JSON.stringify(wrong)).toMatch(/ACCESS_DENIED|DATABASE_ERROR/);
        // Removing the referenced Secret must fail rather than reusing the last admission.
        delete env[secretName];
        const missing = await client.callTool({ name: 'health_check', arguments: { connection: id } });
        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing)).toContain('CONFIGURATION_UNAVAILABLE');
      } finally { await client.close(); }
    });
  }
});
