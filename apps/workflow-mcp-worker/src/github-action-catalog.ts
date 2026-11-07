import { discoverGitHubActions, type GitHubActionSource } from './github-action-discovery.ts';
import { reviewedGitHubAction } from './github-action-review.ts';
import {isDynamicMainAction,DYNAMIC_MAIN_REF} from './github-action-main.ts';

export type ActionCatalogEnv = {
  WORKFLOW_GITHUB_DISPATCH_TOKEN?: string;
  WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES?: string;
};
export type ApprovedRepository = {
  repository: string;
  repositoryId: number;
};
type Http=(request:Request)=>Promise<Response>;
const sha = /^[a-f0-9]{40}$/i;
const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The repository allowlist is owned by the server, never by an MCP request. */
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
    if (!['repository,repositoryId', 'commitSha,repository,repositoryId'].includes(Object.keys(entry).sort().join(',')) ||
        typeof entry.repository !== 'string' || !repoName.test(entry.repository) ||
        entry.repository.includes('..') ||
        (entry.commitSha !== undefined && (typeof entry.commitSha !== 'string' || !sha.test(entry.commitSha))) ||
        typeof entry.repositoryId !== 'number' ||
        !Number.isSafeInteger(entry.repositoryId) || entry.repositoryId <= 0 ||
        seen.has(entry.repository.toLowerCase()))
      throw Error('github_action_catalog_invalid');
    seen.add(entry.repository.toLowerCase());
    // An obsolete commitSha config entry never grants or pins discovery.
    result.push({repository: entry.repository, repositoryId: entry.repositoryId});
  }
  return result;
}

async function describeSource(source:GitHubActionSource) {
  const reviewed=await reviewedGitHubAction(source);
  return {...reviewed,name:source.contract.name,inputs:source.contract.inputs,
    output_schema_status:'not_declared' as const,
    ref:DYNAMIC_MAIN_REF,can_publish:true as const,
    availability:'publishable_after_owner_approval' as const};
}

/** Only explicitly public Task/Session declarations in the trusted main. */
export async function listAvailableGitHubActions(env:ActionCatalogEnv,http:Http=fetch){
  const grants=approvedActionRepositories(env.WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES);
  if(!grants.length)return {actions:[]};
  const token=env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  if(!token)throw Error('github_action_catalog_token_missing');
  const actions:Awaited<ReturnType<typeof describeSource>>[]=[];
  const seen=new Set<string>();
  for(const grant of grants){
    const current=await discoverGitHubActions({...grant,token},http);
    for(const candidate of current){
      if(candidate.contract.publicMain!==true ||
         !isDynamicMainAction({...candidate,type:candidate.contract.type},DYNAMIC_MAIN_REF))continue;
      const name=candidate.workflowPath.split('/').at(-1)!.replace(/\.ya?ml$/,'');
      if(seen.has(name))throw Error('github_action_id_collision');
      seen.add(name);
      actions.push(await describeSource(candidate));
    }
  }
  return {actions};
}
