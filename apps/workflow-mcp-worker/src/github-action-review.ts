import type { GitHubActionSource } from './github-action-discovery.ts';
import { approvedActionRepositories } from './github-action-catalog.ts';
import { validateGitHubActionInputs } from './github-action-inputs.ts';

export type ReviewedGitHubAction = {
  repository: string;
  repositoryId: number;
  workflowId: number;
  workflowPath: string;
  commitSha: string;
  type: 'task' | 'session';
  contractDigest: string;
};

const hash = async (text: string) => {
  const value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, canonical(inner)]));
  return value;
}

/**
 * A publication candidate pins the source identity AND the native inputs.
 * It is evidence for owner review, not a grant or a dispatched execution.
 */
export async function reviewedGitHubAction(source: GitHubActionSource): Promise<ReviewedGitHubAction> {
  return {
    repository: source.repository,
    repositoryId: source.repositoryId,
    workflowId: source.workflowId,
    workflowPath: source.workflowPath,
    commitSha: source.commitSha,
    type: source.contract.type,
    contractDigest: await hash(JSON.stringify(canonical(source.contract))),
  };
}

/** Recheck the exact reviewed candidate against a freshly read pinned revision. */
export async function assertReviewedGitHubAction(
  reviewed: ReviewedGitHubAction,
  discovered: GitHubActionSource,
  approvedRepositories: string | undefined,
  suppliedInputs: Record<string, unknown>,
): Promise<Record<string, string>> {
  const repositories = approvedActionRepositories(approvedRepositories);
  if (!repositories.some(x => x.repository === reviewed.repository &&
      x.repositoryId === reviewed.repositoryId && x.commitSha === reviewed.commitSha))
    throw Error('github_action_repository_not_approved');
  const actual = await reviewedGitHubAction(discovered);
  if (Object.keys(reviewed).length !== Object.keys(actual).length ||
      Object.entries(actual).some(([key, value]) => reviewed[key as keyof ReviewedGitHubAction] !== value))
    throw Error('github_action_review_changed');
  return validateGitHubActionInputs(discovered.contract, suppliedInputs);
}

/**
 * Check immutable publication authorization at the runner seam.
 * An approval assertion supplied with Publish is not sufficient unless its
 * exact reviewed source is persisted in the version being executed.
 */
export function isPublishedGitHubActionApproved(
  approved: readonly ReviewedGitHubAction[] | undefined,
  requested: ReviewedGitHubAction,
): boolean {
  if (!approved || Object.keys(requested).length !== 7) return false;
  return approved.some(entry =>
    Object.keys(entry).length === 7 &&
    entry.repository === requested.repository &&
    entry.repositoryId === requested.repositoryId &&
    entry.workflowId === requested.workflowId &&
    entry.workflowPath === requested.workflowPath &&
    entry.commitSha === requested.commitSha &&
    entry.type === requested.type &&
    entry.contractDigest === requested.contractDigest);
}
