import { discoverGitHubActions, type GitHubActionSource } from './github-action-discovery.ts';
import { verifyActionDispatchRef } from './github-action-dispatch-ref.ts';
import { reviewedGitHubAction } from './github-action-review.ts';

export type ActionCatalogEnv = {
  WORKFLOW_GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_ACTION_APPROVED_REPOSITORIES?: string;
};
export type ApprovedRepository = {
  repository: string;
  repositoryId: number;
};
type Http=(request:Request)=>Promise<Response>;
const sha = /^[a-f0-9]{40}$/i;
const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const tagName = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,190}$/;

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

async function latestConfirmedTag(repository:string,token:string,http:Http):
  Promise<{ref:string;sha:string}|undefined> {
  const response=await http(new Request(
    'https://api.github.com/repos/'+repository+'/tags?per_page=20',
    {headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,
      'user-agent':'workflow-mcp-action-catalog','x-github-api-version':'2026-03-10'},
     redirect:'manual'}));
  if(!response.ok)throw Error('github_action_tag_discovery_unavailable');
  const body=await response.text();
  if(body.length>256*1024)throw Error('github_action_tag_discovery_oversized');
  let tags:unknown;
  try{tags=JSON.parse(body);}catch{throw Error('github_action_tag_discovery_invalid');}
  if(!Array.isArray(tags)||tags.length>20)throw Error('github_action_tag_discovery_invalid');
  for(const candidate of tags){
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))continue;
    const tag=candidate as {name?:unknown;commit?:{sha?:unknown}};
    if(typeof tag.name!=='string'||!tagName.test(tag.name)||
       tag.name.includes('..')||tag.name.includes('//')||tag.name.endsWith('/')||
       !sha.test(String(tag.commit?.sha)))continue;
    const ref='refs/tags/'+tag.name;
    // Tags returned by /tags are not sufficient evidence: the real dispatch
    // verifier must confirm a direct commit ref. Annotated tags are not
    // advertised until the dispatch verifier explicitly supports peeling.
    const action={repository,commitSha:tag.commit!.sha as string};
    try{
      await verifyActionDispatchRef(action,ref,token,http);
      return {ref,sha:action.commitSha};
    }catch{
      // A moved or unsupported tag is never offered as executable.
    }
  }
  return undefined;
}

async function describeSource(source:GitHubActionSource,ref?:string) {
  const reviewed=await reviewedGitHubAction(source);
  return {...reviewed,name:source.contract.name,inputs:source.contract.inputs,
    output_schema_status:'not_declared' as const,
    ...(ref?{ref,can_publish:true as const,availability:'publishable_after_owner_approval' as const}:
      {can_publish:false as const,availability:'unavailable' as const,
       reason:'no_verified_published_tag_for_revision'})};
}

/**
 * Discover current HEAD and one recent verified immutable release revision.
 * Neither discovery nor a published Tag is an execution grant. Publish and
 * dispatch independently re-verify exact ref, commit and contract identities.
 */
export async function listAvailableGitHubActions(env:ActionCatalogEnv,http:Http=fetch){
  const grants=approvedActionRepositories(env.GITHUB_ACTION_APPROVED_REPOSITORIES);
  if(!grants.length)return {actions:[]};
  const token=env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  if(!token)throw Error('github_action_catalog_token_missing');
  const actions:Awaited<ReturnType<typeof describeSource>>[]=[];
  for(const grant of grants){
    const current=await discoverGitHubActions({...grant,token},http);
    const currentSha=current[0]?.commitSha;
    if(!currentSha)continue;
    const published=await latestConfirmedTag(grant.repository,token,http);
    if(!published){
      for(const candidate of current)actions.push(await describeSource(candidate));
      continue;
    }
    const source=published.sha===currentSha
      ?current
      :await discoverGitHubActions({...grant,token,commitSha:published.sha},http);
    for(const candidate of source)actions.push(await describeSource(candidate,published.ref));
    if(published.sha!==currentSha)
      for(const candidate of current)actions.push(await describeSource(candidate));
  }
  return {actions};
}
