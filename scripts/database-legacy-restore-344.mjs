// Future separately approved recovery of the pinned legacy Worker; NEVER
// invoked by a standard release. No D1 writes, origin probes or secret edits.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLegacyRestoreReadiness } from './database-legacy-restore-preflight-344.mjs';

export const LEGACY_VERSION = 'eb3f4823-124b-4d76-abdc-42f85097bb5a';
const SCRIPT = 'database-mcp-worker';
const versionPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const fail = () => { throw Error('Database recovery blocked or requires read-only state reconciliation (details withheld)'); };

/** Owner-only, main-only, single known Worker and explicit current-version CAS intent. */
export function verifyRestoreIntent(env) {
  const expected = env.DATABASE_RESTORE_EXPECTED_VERSION;
  if (env.GITHUB_ACTOR !== 'lirtual' || env.GITHUB_REF !== 'refs/heads/main' ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ||
      !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') ||
      !env.CLOUDFLARE_API_TOKEN || env.DATABASE_RESTORE_APPROVED !== 'true' ||
      !versionPattern.test(expected ?? '') || expected === LEGACY_VERSION) fail();
  return expected;
}
function urlFor(env) {
  return `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${SCRIPT}/deployments`;
}
async function requestJson(url, env, request, body) {
  let result;
  try {
    result = await request(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(15000)
    });
  } catch { fail(); }
  if (!result?.ok) fail();
  let payload;
  try { payload = await result.json(); } catch { fail(); }
  if (payload?.success !== true || !payload.result) fail();
  return payload.result;
}
export function activeVersion(deployments) {
  const current = deployments?.deployments?.[0]?.versions;
  if (!Array.isArray(current) || current.length !== 1 ||
      current[0]?.percentage !== 100 || !versionPattern.test(current[0]?.version_id ?? '')) fail();
  return current[0].version_id;
}

/** Produces exactly one controlled POST, and never retries a lost acknowledgement. */
export async function restoreLegacyWorker(env = process.env, request = fetch,
  pause = ms => new Promise(done => setTimeout(done, ms))) {
  const expected = verifyRestoreIntent(env);
  const prior = await checkLegacyRestoreReadiness(env, request);
  if (!prior.ready || prior.activeLegacy || prior.legacyVersionId !== LEGACY_VERSION) fail();
  const endpoint = urlFor(env);
  if (activeVersion(await requestJson(endpoint, env, request)) !== expected) fail();
  // Never pass `force`: Cloudflare must reject obsolete versions when a Secret
  // or resource has changed. No automatic retry or rollback of D1.
  await requestJson(endpoint, env, request, {
    strategy: 'percentage', versions: [{ version_id: LEGACY_VERSION, percentage: 100 }],
    annotations: { 'workers/message': 'Spec 344 explicitly approved legacy Worker restore' }
  });
  let restored = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      if (activeVersion(await requestJson(endpoint, env, request)) === LEGACY_VERSION) {
        restored = true; break;
      }
    } catch { /* GET readback may lag; do not resubmit the POST. */ }
    if (attempt < 5) await pause(2000);
  }
  if (!restored) fail();
  const after = await checkLegacyRestoreReadiness(env, request);
  if (!after.ready || !after.activeLegacy) fail();
  return { restored: true, activeVersion: LEGACY_VERSION, d1Changed: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreLegacyWorker().then(() => {
    console.log('Approved legacy Worker version readback: PASS. Verify original live health independently.');
  }).catch(() => {
    console.error('Database recovery BLOCKED or state uncertain; inspect production read-only, never blindly retry.');
    process.exitCode = 1;
  });
}
