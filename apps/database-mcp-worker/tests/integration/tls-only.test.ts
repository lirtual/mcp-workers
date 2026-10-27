import { describe, expect, it } from 'vitest';
import { healthCheck } from '../../src/db/index.js';
import { parseDatabaseConfig, resolveConnection } from '../../src/config.js';
import type { Env } from '../../src/types.js';

const postgres = process.env.TEST_POSTGRES_READ_URL;
const mysql = process.env.TEST_MYSQL_READ_URL;
const enabled = postgres && mysql ? describe : describe.skip;
function connection(id: string, raw: string) {
  const env: Env = { RATE_LIMITER: { async limit() { return { success: true }; } } };
  return resolveConnection(env, parseDatabaseConfig(JSON.stringify({ [id]: raw })), id);
}
enabled('certificate-enforced Node integration (NOT deployed Workers P0)', () => {
  const pg = connection('pg', postgres!);
  const my = connection('my', mysql!);
  it('performs both health checks over verified TLS', async () => {
    await expect(healthCheck(pg)).resolves.toHaveProperty('latencyMs');
    await expect(healthCheck(my)).resolves.toHaveProperty('latencyMs');
  });
  it('rejects trusted-CA certificates whose SAN does not match the requested hostname', async () => {
    await expect(healthCheck({ ...pg, host: 'postgres-wrong.db-ci.test' }))
      .rejects.toMatchObject({ code: 'TLS_VERIFICATION_FAILED' });
    await expect(healthCheck({ ...my, host: 'mysql-wrong.db-ci.test' }))
      .rejects.toMatchObject({ code: 'TLS_VERIFICATION_FAILED' });
  });
});
