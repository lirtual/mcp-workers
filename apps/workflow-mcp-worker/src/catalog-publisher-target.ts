/** Source-controlled target trust anchor: owner-approved live-test Worker only.
 * A configurable HTTPS URL is not a trust anchor: it could redirect a GitHub
 * OIDC bearer token to an arbitrary recipient before any admin verification.
 */
const APPROVED_LIVE_TEST_URL = 'https://workflow-mcp-worker.aiyaya.workers.dev';

export type CatalogPublisherMode = 'dry-run' | 'stage' | 'activate';

export function validateCatalogPublisherTarget(
  rawUrl: string,
  mode: CatalogPublisherMode,
  approval: { allowLiveTarget?: string; allowLiveMutations?: string }
): URL {
  // Exact origin, no credentials, alternate ports, redirects, path or query.
  if (rawUrl !== APPROVED_LIVE_TEST_URL && rawUrl !== APPROVED_LIVE_TEST_URL + '/') {
    throw new Error('Catalog publisher target is not a source-approved Worker.');
  }
  if (approval.allowLiveTarget !== 'true') {
    throw new Error('Live Worker testing requires explicit target approval.');
  }
  if (mode !== 'dry-run' && approval.allowLiveMutations !== 'true') {
    throw new Error('Live Worker stage/activate requires separate mutation approval.');
  }
  return new URL(APPROVED_LIVE_TEST_URL + '/');
}
