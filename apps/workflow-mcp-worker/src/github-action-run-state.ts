import type { ReviewedGitHubAction } from './github-action-review.ts';

/** GitHub REST data is untrusted until matched against the immutable published grant. */
export type GitHubPhysicalRun = {
  id?: unknown;
  workflow_id?: unknown;
  run_attempt?: unknown;
  repository?: { id?: unknown; full_name?: unknown };
  path?: unknown;
  head_sha?: unknown;
  head_branch?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
};

export type PhysicalRunState =
  | { state: 'queued' | 'running' | 'completed'; conclusion?: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'skipped' | 'action_required' | 'neutral' | 'stale' }
  | { state: 'identity_mismatch' | 'unknown' };

/**
 * ACK, callback and ready are not the physical GitHub result.
 * Identity or anomalous responses always fail closed and cannot release session quota.
 */
export function reconcileGitHubPhysicalRun(
  action: ReviewedGitHubAction,
  expectedRunId: number,
  expectedAttempt: number,
  run: GitHubPhysicalRun,
  expectedRef: string,
): PhysicalRunState {
  if (!Number.isSafeInteger(expectedRunId) || expectedRunId <= 0 ||
      !Number.isSafeInteger(expectedAttempt) || expectedAttempt <= 0 ||
      run.id !== expectedRunId || run.workflow_id !== action.workflowId ||
      run.run_attempt !== expectedAttempt ||
      run.repository?.id !== action.repositoryId ||
      run.repository?.full_name !== action.repository ||
      !/^refs\\/tags\\/[A-Za-z0-9][A-Za-z0-9._\\/-]{0,190}$/.test(expectedRef) ||
      expectedRef.includes('..') || expectedRef.includes('//') ||
      ![action.workflowPath+'@'+expectedRef,
        action.workflowPath+'@'+expectedRef.slice('refs/tags/'.length)].includes(run.path as string) ||
      run.head_sha !== action.commitSha ||
      run.event !== 'workflow_dispatch')
    return {state:'identity_mismatch'};
  if (run.status === 'queued' || run.status === 'pending' || run.status === 'waiting' ||
      run.status === 'requested') return {state:'queued'};
  if (run.status === 'in_progress') return {state:'running'};
  if (run.status !== 'completed') return {state:'unknown'};
  const conclusion = run.conclusion;
  if (conclusion === 'success' || conclusion === 'failure' ||
      conclusion === 'cancelled' || conclusion === 'timed_out' ||
      conclusion === 'skipped' || conclusion === 'action_required' ||
      conclusion === 'neutral' || conclusion === 'stale')
    return {state:'completed',conclusion};
  return {state:'unknown'};
}
