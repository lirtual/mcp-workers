// One-time, Owner-scoped configuration of existing Aiven test services.
// Never print passwords, Cloudflare response bodies or CA certificate contents.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCloudflareHyperdriveConfig } from './verify-database-hyperdrive.mjs';

const CA_ID = 'c9a71de0-06b0-4ea2-b2e8-2dfc27fb0d7a';
const fixture = [
  { name: 'db344-aiven-mysql-test', dialect: 'mysql', host: 'mysql-zeroverse.d.aivencloud.com',
    database: 'database-mcp-test-mysql', binding: 'HYPERDRIVE_AIVEN_MYSQL', mode: 'VERIFY_IDENTITY', passwordEnv: 'DATABASE_TEST_MYSQL_PASSWORD' },
  { name: 'db344-aiven-postgres-test', dialect: 'postgres', host: 'postgresql-zeroverse.d.aivencloud.com',
    database: 'database-mcp-test-postgres', binding: 'HYPERDRIVE_AIVEN_POSTGRES', mode: 'verify-full', passwordEnv: 'DATABASE_TEST_POSTGRES_PASSWORD' }
];
const fail = () => { throw Error('Aiven Hyperdrive test provisioning rejected (details withheld)'); };

export async function prepareAivenHyperdrive(env = process.env, transport = fetch) {
  if (env.GITHUB_ACTOR !== 'lirtual' || env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/i.test(env.GITHUB_SHA ?? '') ||
      env.CLOUDFLARE_ACCOUNT_ID !== '8bb496011403552e785ea1b834daffdf' ||
      env.DATABASE_AIVEN_PROVISION_APPROVED !== 'true' ||
      !env.CLOUDFLARE_API_TOKEN || fixture.some(x => !env[x.passwordEnv])) fail();
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/hyperdrive/configs`;
  const headers = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, accept: 'application/json' };
  async function cloud(url, method = 'GET', body) {
    let response, result;
    try {
      response = await transport(url, { method,
        headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(55000) });
      result = await response.json();
    } catch { fail(); }
    if (!response.ok || result?.success !== true || result?.result == null) fail();
    return result.result;
  }
  // No blind repeated POST: recover any prior successful creation by exact name.
  const all = await cloud(base);
  if (!Array.isArray(all)) fail();
  const found = [];
  for (const item of fixture) {
    const matches = all.filter(x => x.name === item.name);
    if (matches.length > 1) fail();
    const password = env[item.passwordEnv];
    const b = { name: item.name,
      origin: { scheme: item.dialect, host: item.host, port: 18691, database: item.database, user: 'test', password },
      mtls: { ca_certificate_id: CA_ID, sslmode: item.mode },
      caching: { disabled: true }, origin_connection_limit: 5 };
    const created = matches.length === 1 ? matches[0] : await cloud(base, 'POST', b);
    if (!/^[a-f0-9-]{36}$/i.test(created?.id ?? '')) fail();
    const detail = await cloud(`${base}/${created.id}`);
    const expected = { binding: item.binding, id: created.id, dialect: item.dialect,
      origin_host: item.host, origin_port: 18691, origin_database: item.database,
      origin_user: 'test', ca_certificate_id: CA_ID };
    verifyCloudflareHyperdriveConfig(expected, detail);
    found.push({ dialect: item.dialect, binding: item.binding, id: created.id, tls: 'strict', cache: 'disabled' });
  }
  return found;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareAivenHyperdrive().then(result => {
    for (const item of result) process.stdout.write('AIVEN_HYPERDRIVE_PREPARED ' + JSON.stringify(item) + '\n');
  }).catch(() => { process.stderr.write('AIVEN_HYPERDRIVE_PREPARE_FAILED\n'); process.exitCode = 1; });
}
