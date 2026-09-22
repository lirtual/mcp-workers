import { createHash } from 'node:crypto';
import { compileWorkflowText, type TrustedCompilePolicy } from './compiler.js';

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SOURCE = /^workflows\/[A-Za-z][A-Za-z0-9_-]{0,127}\.ya?ml$/;

export interface TrustedCatalogSource {
  repository: string;
  repositoryId: string;
  expectedRepository: string;
  expectedRepositoryId: string;
  requestedSha: string;
  checkedOutSha: string;
  sourcePath: string;
  yaml: string;
  policy: TrustedCompilePolicy;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Trusted ENGINE publisher input. The separate catalog supplies only YAML;
 * neither catalog workflows/scripts nor an author-supplied stage envelope are
 * executable or authoritative. The caller must verify checkout and repository
 * identity before passing the exact revision and approved policy snapshot.
 */
export function prepareCatalogPublication(source: TrustedCatalogSource) {
  if (!REPOSITORY.test(source.repository) ||
      source.repository !== source.expectedRepository ||
      !/^[1-9][0-9]*$/.test(source.repositoryId) ||
      source.repositoryId !== source.expectedRepositoryId) {
    throw new Error('Catalog repository identity is not approved.');
  }
  if (!COMMIT.test(source.requestedSha) ||
      source.checkedOutSha !== source.requestedSha) {
    throw new Error('Catalog checkout does not match the requested commit.');
  }
  if (!SOURCE.test(source.sourcePath) || source.sourcePath.includes('..')) {
    throw new Error('Catalog definition must use a bounded workflows/*.yaml path.');
  }
  if (!Number.isSafeInteger(source.policy.revision) || source.policy.revision < 1) {
    throw new Error('Trusted policy revision is invalid.');
  }
  const entry = compileWorkflowText(source.yaml, source.sourcePath, source.policy);
  if (!DIGEST.test(entry.definitionDigest)) throw new Error('Compiled digest is invalid.');
  const publicationId = 'pub_' + hash([
    source.repositoryId, source.requestedSha, source.sourcePath, entry.definitionDigest
  ]).slice(0,40);
  return {
    definitionDigest: entry.definitionDigest,
    manifestVersion: 1,
    metadata: entry.metadata,
    plan: entry.plan,
    policyRevision: source.policy.revision,
    publicationId,
    sourcePath: source.sourcePath,
    sourceSha: source.requestedSha,
    workflowId: entry.metadata.id
  };
}

export function prepareCatalogActivation(
  staged: ReturnType<typeof prepareCatalogPublication>,
  current: { activeDigest: string | null; revision: number }
) {
  if (!Number.isSafeInteger(current.revision) || current.revision < 0 ||
      (current.activeDigest !== null && !DIGEST.test(current.activeDigest))) {
    throw new Error('Current registry revision or digest is invalid.');
  }
  const actionId = 'act_' + hash([
    staged.publicationId, current.activeDigest, staged.definitionDigest, current.revision
  ]).slice(0,40);
  return {
    actionId, workflowId: staged.workflowId,
    expectedDigest: current.activeDigest, targetDigest: staged.definitionDigest,
    expectedRevision: current.revision
  };
}
