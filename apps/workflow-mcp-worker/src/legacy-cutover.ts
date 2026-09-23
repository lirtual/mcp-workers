import { LEGACY_DEFINITIONS } from './legacy-import.js';
import { getWorkflowRegistry } from './registry.js';

const HEX40 = /^[0-9a-f]{40}$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;

/**
 * Read-only release gate for a single v0.1 definition. Seeding immutable D1
 * rows is not authorization to activate them: the separately protected T09
 * publisher must have staged this exact source SHA/digest through its OIDC
 * route. This does not itself activate the definition or toggle a feature gate.
 */
export async function verifyLegacyPublicationReadiness(
  db: D1Database,
  options: {
    workflowId: keyof typeof LEGACY_DEFINITIONS;
    approvedSourceSha: string;
    trustedPublisherRepositoryId: string;
    expectedPolicyRevision: number;
  }
): Promise<{ workflowId: string; definitionDigest: string; publicationId: string; sourceSha: string }> {
  const expectedDigest = LEGACY_DEFINITIONS[options.workflowId];
  if (!expectedDigest || !HEX40.test(options.approvedSourceSha) ||
      !DECIMAL_ID.test(options.trustedPublisherRepositoryId) ||
      !Number.isSafeInteger(options.expectedPolicyRevision) || options.expectedPolicyRevision < 1) {
    throw new Error('Legacy publication requires a pinned, approved source and policy.');
  }
  const policy = await db.prepare(
    'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
  ).first<{ revision: number }>();
  if (!policy || policy.revision !== options.expectedPolicyRevision) {
    throw new Error('Legacy publication policy changed before cutover.');
  }
  const publication = await db.prepare(
    `SELECT p.publication_id AS publicationId, p.source_sha AS sourceSha,
            p.publisher_run_id AS publisherRunId,
            p.publisher_run_attempt AS publisherRunAttempt,
            p.publisher_workflow_sha AS publisherWorkflowSha,
            d.normalized_plan_json AS normalizedPlanJson
     FROM definition_publications p
     JOIN workflow_definition_versions d ON d.definition_digest = p.definition_digest
     WHERE p.workflow_id = ? AND p.definition_digest = ?
       AND p.source_sha = ? AND p.repository_id = ? AND p.policy_revision = ?
       AND d.workflow_id = ? AND d.dsl_version = 1 AND d.source_path = ?
     ORDER BY p.created_at DESC, p.publication_id DESC LIMIT 1`
  ).bind(options.workflowId, expectedDigest, options.approvedSourceSha,
    options.trustedPublisherRepositoryId, options.expectedPolicyRevision,
    options.workflowId, `workflows/${options.workflowId}.yaml`).first<{
      publicationId: string; sourceSha: string; publisherRunId: string;
      publisherRunAttempt: number; publisherWorkflowSha: string; normalizedPlanJson: string
    }>();
  if (!publication || !DECIMAL_ID.test(publication.publisherRunId) ||
      !Number.isSafeInteger(publication.publisherRunAttempt) || publication.publisherRunAttempt < 1 ||
      !HEX40.test(publication.publisherWorkflowSha)) {
    throw new Error('Legacy definition has no matching trusted publication.');
  }
  // The immutable seed itself cannot be used to forge a matching publication.
  // Every approved source must still be consistent with the original v0.1 plan.
  // This read-only guard compares the stored plan to the original bundled
  // Registry, but does not bypass the caller's authoritative D1 preflight.
  const entry = getWorkflowRegistry().find(value => value.metadata.id === options.workflowId);
  if (!entry || entry.definitionDigest !== expectedDigest ||
      JSON.stringify(canonical(JSON.parse(publication.normalizedPlanJson))) !==
        JSON.stringify(canonical(entry.plan))) {
    throw new Error('Legacy published definition differs from the original pinned plan.');
  }
  const after = await db.prepare(
    'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
  ).first<{ revision: number }>();
  if (!after || after.revision !== options.expectedPolicyRevision) {
    throw new Error('Legacy publication policy changed during cutover preflight.');
  }
  return {
    workflowId: options.workflowId,
    definitionDigest: expectedDigest,
    publicationId: publication.publicationId,
    sourceSha: publication.sourceSha
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
