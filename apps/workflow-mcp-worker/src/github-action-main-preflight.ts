import {discoverGitHubActions} from './github-action-discovery.ts';
import {reviewedGitHubAction,type ReviewedGitHubAction} from './github-action-review.ts';
import {isDynamicMainAction,DYNAMIC_MAIN_REF} from './github-action-main.ts';
import {verifyActionDispatchRef} from './github-action-dispatch-ref.ts';

type Http=(request:Request)=>Promise<Response>;
const REPO='lirtual/github-actions';
const CI_ID=394262523;
const LIMIT=128*1024;
const SHA=/^[0-9a-f]{40}$/;

/** Select main HEAD; independently check the approved Action contract, exact
 * success of its main-push CI, then recheck the branch before allowing a POST.
 * Every error is pre-dispatch denial; there is no fallback to an older commit. */
export async function resolveApprovedMainAction(
  baseline:ReviewedGitHubAction,token:string,http:Http=fetch,
):Promise<ReviewedGitHubAction> {
  if(!isDynamicMainAction(baseline,DYNAMIC_MAIN_REF)||!token?.trim())
    throw Error('github_action_main_not_allowed');
  const source=(await discoverGitHubActions({
    repository:REPO,repositoryId:baseline.repositoryId,token,
  },http)).find(s=>s.workflowId===baseline.workflowId&&
     s.workflowPath===baseline.workflowPath);
  if(!source||source.contract.publicMain!==true||!SHA.test(source.commitSha))
    throw Error('github_action_main_unverified');
  const current=await reviewedGitHubAction(source);
  if(current.repository!==baseline.repository||
     current.repositoryId!==baseline.repositoryId||
     current.workflowId!==baseline.workflowId||
     current.workflowPath!==baseline.workflowPath||
     current.type!==baseline.type||
     current.contractDigest!==baseline.contractDigest)
    throw Error('github_action_main_contract_changed');

  const url='https://api.github.com/repos/'+REPO+
    '/actions/workflows/ci.yml/runs?event=push&head_sha='+current.commitSha+
    '&per_page=20';
  let response:Response;
  try{
    response=await http(new Request(url,{redirect:'manual',headers:{
      accept:'application/vnd.github+json',authorization:'Bearer '+token,
      'x-github-api-version':'2026-03-10',
      'user-agent':'workflow-mcp-main-ci-check',
    }}));
  }catch{throw Error('github_action_main_ci_unavailable');}
  if(response.status!==200)throw Error('github_action_main_ci_unavailable');
  let parsed:unknown;
  try{
    const body=await response.text();
    if(body.length>LIMIT)throw Error('oversized');
    parsed=JSON.parse(body);
  }catch{throw Error('github_action_main_ci_unavailable');}
  const results=(parsed as {workflow_runs?:unknown})?.workflow_runs;
  if(!Array.isArray(results)||results.length>20||!results.some(run=>{
    const r=run as Record<string,unknown>;
    const repo=r.repository as {id?:unknown}|undefined;
    const headRepo=r.head_repository as {id?:unknown}|undefined;
    return r.workflow_id===CI_ID&&r.event==='push'&&
      r.head_branch==='main'&&r.head_sha===current.commitSha&&
      r.status==='completed'&&r.conclusion==='success'&&
      r.path==='.github/workflows/ci.yml'&&
      repo?.id===baseline.repositoryId&&headRepo?.id===baseline.repositoryId&&
      Number.isSafeInteger(r.id)&&Number(r.id)>0;
  }))throw Error('github_action_main_ci_not_successful');
  await verifyActionDispatchRef(current,DYNAMIC_MAIN_REF,token,http);
  return current;
}
