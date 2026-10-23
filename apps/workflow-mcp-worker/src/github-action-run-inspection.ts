import { reconcileGitHubPhysicalRun, type PhysicalRunState } from './github-action-run-state.ts';
import type { ReviewedGitHubAction } from './github-action-review.ts';

type Http = (request: Request) => Promise<Response>;
const LIMIT=64*1024;

/** One bounded, read-only API call. No retries when GitHub's response is uncertain. */
export async function inspectGitHubActionRun(
  action: ReviewedGitHubAction,runId:number,runAttempt:number,token:string,
  http:Http=fetch,
):Promise<PhysicalRunState>{
  if(!Number.isSafeInteger(runId)||runId<=0||
     !Number.isSafeInteger(runAttempt)||runAttempt<=0||
     !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.repository)||
     !token?.trim())throw Error('github_run_inspection_invalid');
  const url='https://api.github.com/repos/'+action.repository+'/actions/runs/'+runId;
  let response:Response;
  try{
    response=await http(new Request(url,{redirect:'manual',headers:{
      accept:'application/vnd.github+json',
      authorization:'Bearer '+token,
      'x-github-api-version':'2026-03-10',
      'user-agent':'workflow-mcp-physical-run-inspection',
    }}));
  }catch{return {state:'unknown'};}
  if(response.status!==200)return {state:'unknown'};
  try{
    const body=await response.text();
    if(body.length>LIMIT)return {state:'unknown'};
    const parsed=JSON.parse(body);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {state:'unknown'};
    return reconcileGitHubPhysicalRun(action,runId,runAttempt,parsed);
  }catch{return {state:'unknown'};}
}
