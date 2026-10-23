import { discoverGitHubActions } from './github-action-discovery.ts';

export type ActionCatalogEnv = {
  WORKFLOW_EXECUTOR_GITHUB_TOKEN?: string;
  GITHUB_ACTION_APPROVED_REPOSITORIES?: string;
};
export type ApprovedRepository = {
  repository: string;
  repositoryId: number;
  commitSha: string;
};
const sha = /^[a-f0-9]{40}$/i;
const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Explicit, server-owned discovery scope. The configuration is not supplied
 * by MCP requests or GitHub Workflow YAML and grants no execution privileges.
 */
export function approvedActionRepositories(raw: string | undefined): ApprovedRepository[] {
  if (!raw) return [];
  if (raw.length > 8192) throw Error('github_action_catalog_invalid');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw Error('github_action_catalog_invalid'); }
  if (!Array.isArray(value) || value.length > 16) throw Error('github_action_catalog_invalid');
  const seen = new Set<string>();
  const result: ApprovedRepository[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw Error('github_action_catalog_invalid');
    const entry = candidate as Record<string, unknown>;
    if (Object.keys(entry).sort().join(',') !== 'commitSha,repository,repositoryId' ||
        typeof entry.repository !== 'string' || !repoName.test(entry.repository) ||
        entry.repository.includes('..') || typeof entry.commitSha !== 'string' ||
        !sha.test(entry.commitSha) || typeof entry.repositoryId !== 'number' ||
        !Number.isSafeInteger(entry.repositoryId) || entry.repositoryId <= 0 ||
        seen.has(entry.repository.toLowerCase()))
      throw Error('github_action_catalog_invalid');
    seen.add(entry.repository.toLowerCase());
    result.push({repository: entry.repository, repositoryId: entry.repositoryId, commitSha: entry.commitSha});
  }
  return result;
}

/** List only explicitly approved repository revisions. Never dispatches. */
export async function listAvailableGitHubActions(env: ActionCatalogEnv) {
  const grants = approvedActionRepositories(env.GITHUB_ACTION_APPROVED_REPOSITORIES);
  if (!grants.length) return { actions: [] };
  const token = env.WORKFLOW_EXECUTOR_GITHUB_TOKEN;
  if (!token) throw Error('github_action_catalog_token_missing');
  const actions = [];
  for (const grant of grants) {
    const discovered = await discoverGitHubActions({...grant, token});
    actions.push(...discovered.map(({contract, ...source}) => ({
      ...source, name: contract.name, type: contract.type, inputs: contract.inputs,
      availability: 'discovered_not_authorized' as const,
    })));
  }
  return {actions};
}
