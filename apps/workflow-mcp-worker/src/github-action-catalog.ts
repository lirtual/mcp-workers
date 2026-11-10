import { discoverGitHubActions, type GitHubActionSource } from './github-action-discovery.ts';
import { reviewedGitHubAction } from './github-action-review.ts';
import { isDynamicMainAction,DYNAMIC_MAIN_REF } from './github-action-main.ts';
import { readWorkflowGitHubExecutor } from './workflow-github-executor.ts';

export type ActionCatalogEnv = {
  WORKFLOW_GITHUB_DISPATCH_TOKEN?: string;
  /** Release-generated identity, never set by a Workflow caller. */
  WORKFLOW_GITHUB_ACTION_IDENTITY?: string;
};

export function currentExecutorRepository(raw:unknown) {
  return readWorkflowGitHubExecutor(raw);
}

type Http=(request:Request)=>Promise<Response>;

async function describeSource(source:GitHubActionSource) {
  const reviewed=await reviewedGitHubAction(source);
  return {...reviewed,name:source.contract.name,inputs:source.contract.inputs,
    output_schema_status:'not_declared' as const,
    ref:DYNAMIC_MAIN_REF,can_publish:true as const,
    availability:'publishable_after_owner_approval' as const};
}

/** Only explicitly public Task/Session declarations from the one release-pinned main. */
export async function listAvailableGitHubActions(env:ActionCatalogEnv,http:Http=fetch){
  const grant=currentExecutorRepository(env.WORKFLOW_GITHUB_ACTION_IDENTITY);
  if(!grant)return {actions:[]};
  const token=env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  if(!token)throw Error('github_action_catalog_token_missing');
  const current=await discoverGitHubActions({...grant,token},http);
  const actions:Awaited<ReturnType<typeof describeSource>>[]=[];
  const seen=new Set<string>();
  for(const candidate of current){
    if(candidate.contract.publicMain!==true ||
       !isDynamicMainAction({...candidate,type:candidate.contract.type},DYNAMIC_MAIN_REF))continue;
    const name=candidate.workflowPath.split('/').at(-1)!.replace(/\.ya?ml$/,'');
    if(seen.has(name))throw Error('github_action_id_collision');
    seen.add(name);
    actions.push(await describeSource(candidate));
  }
  return {actions};
}
