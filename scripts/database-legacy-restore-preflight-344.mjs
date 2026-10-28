// Spec #344: read-only prepublication legacy Worker recovery-target attestation.
// This does not deploy, roll back, upload versions or mutate D1 or an origin.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const OLD_VERSION = 'eb3f4823-124b-4d76-abdc-42f85097bb5a';
const SCRIPT = 'database-mcp-worker';
const fail = () => { throw Error('Database legacy Worker recovery target unavailable or changed (details withheld)'); };

export function verifyLegacyRestoreTarget({ deployments, versions, oldVersion }) {
  if (!Array.isArray(deployments) || deployments.length < 1 ||
      !Array.isArray(versions) || !oldVersion || oldVersion.id !== OLD_VERSION ||
      !versions.some(x => x?.id === OLD_VERSION)) fail();
  const resourceBindings = oldVersion.resources?.bindings;
  if (!Array.isArray(resourceBindings)) fail();
  const bindings = new Map();
  for (const b of resourceBindings) {
    if (typeof b?.name !== 'string' || typeof b?.type !== 'string' || bindings.has(b.name)) fail();
    bindings.set(b.name, b.type);
  }
  for (const [name, type] of [
    ['DATABASE_CONFIG', 'secret_text'],
    ['MCP_ACCESS_TOKEN', 'secret_text'],
    ['RATE_LIMITER', 'ratelimit']
  ]) if (bindings.get(name) !== type) fail();
  if (bindings.has('DB')) fail();
  // Accept the known old version as either active, or still deployable after
  // the first cutover. Activation and rollback are independent decisions.
  const active = deployments[0]?.versions;
  if (!Array.isArray(active) || active.length < 1 ||
      active.some(v => typeof v?.percentage !== 'number' || v.percentage < 0 ||
        v.percentage > 100 || typeof v.version_id !== 'string') ||
      Math.abs(active.reduce((n, v) => n + v.percentage, 0) - 100) > 0.00001) fail();
  return {
    ready: true, legacyVersionId: OLD_VERSION,
    activeLegacy: active.length === 1 && active[0].version_id === OLD_VERSION &&
      active[0].percentage === 100
  };
}

async function getCloudflare(path, env, requestFetch) {
  const res = await requestFetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`,
    {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!res.ok) fail();
  const json = await res.json();
  if (json?.success !== true) fail();
  return json.result;
}

export async function checkLegacyRestoreReadiness(env = process.env, requestFetch = fetch) {
  if (env.GITHUB_ACTOR !== 'lirtual' || env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '') ||
      !/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') ||
      !env.CLOUDFLARE_API_TOKEN) fail();
  const prefix = `/workers/scripts/${SCRIPT}`;
  const [deploy, available, detail] = await Promise.all([
    getCloudflare(prefix + '/deployments', env, requestFetch),
    getCloudflare(prefix + '/versions?deployable=true&per_page=100', env, requestFetch),
    getCloudflare(prefix + '/versions/' + OLD_VERSION, env, requestFetch)
  ]);
  return verifyLegacyRestoreTarget({
    deployments: deploy?.deployments,
    versions: available?.items,
    oldVersion: detail
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkLegacyRestoreReadiness().then(result => {
    console.log('Database legacy recovery-target read-only check passed; old version deployable; current=' +
      (result.activeLegacy ? 'legacy' : 'not-legacy'));
  }).catch(() => {
    console.error('Database release blocked: legacy Worker recovery-target read-only check failed.');
    process.exitCode = 1;
  });
}
