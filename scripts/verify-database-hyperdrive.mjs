// Read-only Cloudflare Hyperdrive verification for Spec #344.
// Runs only in the existing protected GitHub Actions release, never in Worker
// request handlers. Never print API response bodies (may contain origin identity).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { readConfiguration, verifyDatabaseHyperdriveSource } from './manual-worker-release.mjs';

function requireVerified(value, reason) {
  if (!value) throw Error('Database Hyperdrive verification failed: ' + reason);
}
function isPublicDnsName(host) {
  return typeof host === 'string' && host.length > 3 && host.length <= 253 &&
    isIP(host) === 0 && host.toLowerCase() !== 'localhost' &&
    !host.toLowerCase().endsWith('.localhost') &&
    /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host);
}
/** All fields are nonsecret; password and CA PEM are intentionally absent. */
export function verifyCloudflareHyperdriveConfig(expected, observed) {
  requireVerified(expected && /^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(expected.binding??'') &&
    /^[a-zA-Z0-9-]{8,64}$/.test(expected.id??'') && ['mysql','postgres'].includes(expected.dialect), 'invalid approved binding metadata');
  requireVerified(observed?.id===expected.id, 'config ID differs from reviewed source');
  requireVerified(observed.caching?.disabled===true,'SQL response caching is not disabled');
  const mode=expected.dialect==='postgres'?'verify-full':'VERIFY_IDENTITY';
  requireVerified(observed.mtls?.sslmode===mode && typeof observed.mtls?.ca_certificate_id==='string' &&
    observed.mtls.ca_certificate_id.length>0,'strict origin TLS required');
  const origin=observed.origin;
  requireVerified(origin && (expected.dialect==='mysql'?origin.scheme==='mysql':['postgres','postgresql'].includes(origin.scheme)) &&
    isPublicDnsName(origin.host) && typeof origin.user==='string' && origin.user.length>0 && Number.isSafeInteger(origin.port) && origin.port>0 && origin.port<=65535 &&
    !origin.service_id && !origin.access_client_id &&
    (expected.dialect!=='mysql' || origin.database===expected.origin_database), 'origin dialect/schema or public endpoint is invalid');
  return true;
}
export async function verifyDatabaseHyperdriveCloudReadback({ source, manifest, accountId, token, request = fetch }) {
  verifyDatabaseHyperdriveSource(source, manifest);
  if (manifest.length === 0) return { verified: 0 };
  requireVerified(/^[a-f0-9]{32}$/i.test(accountId ?? '') &&
    typeof token === 'string' && token.length > 0, 'read-only Cloudflare account access is unavailable');
  for (const [index, expected] of manifest.entries()) {
    // Do not log non-2xx bodies: upstream errors can include origin details.
    let response;
    try {
      response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs/${expected.id}`,
        { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000) }
      );
    } catch {
      throw Error('Database Hyperdrive verification failed: Cloudflare read unavailable');
    }
    // Report a fixed HTTP class only; never emit Cloudflare response content.
    if (response?.ok !== true) {
      const status = response?.status;
      const httpClass = status === 401 || status === 403 || status === 404 || status === 429
        ? String(status) : Number.isSafeInteger(status) && status >= 500 && status <= 599 ? '5xx' : 'other';
      // Slot is an ordinal within reviewed source, not an origin/secret identifier.
      const slot = index === 0 ? '1' : index === 1 ? '2' : 'other';
      throw Error('Database Hyperdrive verification failed: Cloudflare configuration read rejected (' + httpClass + ', slot ' + slot + ')');
    }
    let envelope;
    try { envelope = await response.json(); }
    catch { throw Error('Database Hyperdrive verification failed: unreadable Cloudflare response'); }
    requireVerified(envelope?.success === true && envelope.result,
      'Cloudflare did not confirm the configuration');
    verifyCloudflareHyperdriveConfig(expected, envelope.result);
  }
  return { verified: manifest.length };
}
const APPROVED_ACCOUNT_ID = '8bb496011403552e785ea1b834daffdf';
export function verifyApprovedAccountScope(accountId) {
  requireVerified(accountId === APPROVED_ACCOUNT_ID, 'approved Cloudflare account mismatch');
  return true;
}
export async function main() {
  verifyApprovedAccountScope(process.env.CLOUDFLARE_ACCOUNT_ID);
  const source = readConfiguration('database-mcp-worker', await readFile(
    new URL('../apps/database-mcp-worker/wrangler.jsonc', import.meta.url), 'utf8'
  ));
  const manifest = JSON.parse(await readFile(
    new URL('../apps/database-mcp-worker/hyperdrive-bindings.json', import.meta.url), 'utf8'
  ));
  const result = await verifyDatabaseHyperdriveCloudReadback({
    source, manifest,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN
  });
  // No URL, username, account ID, CA or response body is written to CI logs.
  process.stdout.write(`Database Hyperdrive strict origin readback PASS; verified=${result.verified}\n`);
}
// Only these fixed, literal codes may reach CI logs. Never include upstream
// response content, origin metadata, tokens, URLs or arbitrary exception text.
const READBACK_CODES = new Map([
  ['Database Hyperdrive verification failed: invalid approved source metadata', 'source_metadata'],
  ['Database Hyperdrive verification failed: config ID differs from reviewed source', 'config_id_mismatch'],
  ['Database Hyperdrive verification failed: SQL response caching is not disabled', 'cache_mismatch'],
  ['Database Hyperdrive verification failed: CA/hostname verification is not strict or does not match reviewed CA', 'tls_mismatch'],
  ['Database Hyperdrive verification failed: origin identity differs from reviewed source', 'origin_mismatch'],
  ['Database Hyperdrive verification failed: read-only Cloudflare account access is unavailable', 'credentials_unavailable'],
  ['Database Hyperdrive verification failed: approved Cloudflare account mismatch', 'account_scope_mismatch'],
  ['Database Hyperdrive verification failed: Cloudflare configuration read rejected', 'cloudflare_read_rejected'],
  ...['401', '403', '404', '429', '5xx', 'other'].flatMap(status =>
    ['1', '2', 'other'].map(slot => [
      'Database Hyperdrive verification failed: Cloudflare configuration read rejected (' + status + ', slot ' + slot + ')',
      'cloudflare_read_' + status + '_slot_' + slot
    ])
  ),
  ['Database Hyperdrive verification failed: Cloudflare did not confirm the configuration', 'cloudflare_unconfirmed'],
  ['Database Hyperdrive verification failed: unreadable Cloudflare response', 'cloudflare_unreadable'],
  ['Database Hyperdrive verification failed: Cloudflare read unavailable', 'cloudflare_unavailable'],
  ['Database Hyperdrive manifest/source mismatch', 'manifest_mismatch'],
  ['Database Hyperdrive binding not uniquely represented in protected release manifest', 'manifest_binding_mismatch']
]);
export function safeReadbackFailureCode(error) {
  return READBACK_CODES.get(error instanceof Error ? error.message : '') ?? 'unknown';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write('Database Hyperdrive security readback: FAIL (' + safeReadbackFailureCode(error) + ')\n');
    process.exitCode = 1;
  });
}
