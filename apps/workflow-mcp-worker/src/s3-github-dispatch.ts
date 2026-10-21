/**
 * S3 registered GitHub execution dispatch — isolated first slice only.
 *
 * This module does not connect the Workflow runner to GitHub yet. The caller
 * must use a reviewed, server-side executor config and a persisted logical
 * Attempt; no repo/workflow/ref/credential can come from a Draft or Run input.
 * The GitHub Actions management MCP's broad multi-PAT authority is not used.
 */
export type RegisteredDispatchConfig={
  repository:string;
  workflow:string;
  ref:string;
  dispatchToken:string;
  /** Strictly registered isolated CI fixture, never a product capability. */
  workerName?:string;
};
export type LogicalAttempt={
  attemptId:string;
  dispatchId:string;
  capabilityId:'heavy.github.echo';
};
export type DispatchOutcome=
  | {status:'confirmed';runId:number;runAttempt:1}
  | {status:'rejected'}
  | {status:'dispatch_unknown'};
export type ConfirmedCandidate={
  repository:string;
  workflowRef:string;
  ref:string;
  runId:number;
  runAttempt:number;
};
export type VerifiedGitHubClaims={
  repository?:unknown;
  workflow_ref?:unknown;
  ref?:unknown;
  run_id?:unknown;
  run_attempt?:unknown;
  event_name?:unknown;
};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO=/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const BRANCH=/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
function assertRegistered(config:RegisteredDispatchConfig,attempt:LogicalAttempt) {
  const isolated=config.workflow==='ci.yml';
  if((isolated
       ? (config.repository!=='lirtual/mcp-workers' ||
          config.ref!=='refs/heads/wip/workflow-s3-github-executor' ||
          !/^workflow-s3-oidc-[a-f0-9]{10}$/.test(config.workerName??''))
       : (config.workflow!=='workflow-s3-executor.yml' || config.workerName!==undefined)) ||
     !REPO.test(config.repository) || config.repository.includes('..') ||
     !BRANCH.test(config.ref) || config.ref.includes('..') ||
     config.ref.endsWith('/') || typeof config.dispatchToken!=='string' ||
     !config.dispatchToken.trim())
    throw new Error('github_executor_config_invalid');
  if(attempt.capabilityId!=='heavy.github.echo' ||
     !UUID.test(attempt.attemptId) || !UUID.test(attempt.dispatchId))
    throw new Error('github_executor_attempt_invalid');
}

/**
 * Exactly one POST. A missing/ambiguous ACK is NEVER retried here.
 * The physical Run ID returned by GitHub is evidence needed to authorize
 * a candidate later, not permission for that job to execute business work.
 */
export async function dispatchGithubAttempt(
  config:RegisteredDispatchConfig,
  attempt:LogicalAttempt,
  outbound:(request:Request)=>Promise<Response>=fetch,
):Promise<DispatchOutcome>{
  assertRegistered(config,attempt);
  const url='https://api.github.com/repos/'+config.repository+
    '/actions/workflows/'+config.workflow+'/dispatches';
  const request=new Request(url,{
    method:'POST',redirect:'manual',headers:{
      accept:'application/vnd.github+json',
      authorization:'Bearer '+config.dispatchToken,
      'content-type':'application/json',
      'x-github-api-version':'2026-03-10',
    },
    body:JSON.stringify({
      ref:config.ref.slice('refs/heads/'.length),
      return_run_details:true,
      inputs:{
        attempt_id:attempt.attemptId,
        dispatch_id:attempt.dispatchId,
        capability_id:attempt.capabilityId,
        ...(config.workflow==='ci.yml'?{
          worker_name:config.workerName,
          worker:'workflow-mcp-worker',
          s3_executor_worker:'true',
        }:{}),
      },
    }),
  });
  let response:Response;
  try {response=await outbound(request);}
  catch {return {status:'dispatch_unknown'};}
  // Documented 4xx rejection establishes no accepted dispatch. A timeout,
  // redirect, unexpected status, or malformed 200 can conceal acceptance.
  if([400,401,403,404,422].includes(response.status))return {status:'rejected'};
  if(response.status!==200)return {status:'dispatch_unknown'};
  try{
    const result=await response.json() as {workflow_run_id?:unknown};
    if(typeof result.workflow_run_id==='number'&&
       Number.isSafeInteger(result.workflow_run_id)&&result.workflow_run_id>0)
      return {status:'confirmed',runId:result.workflow_run_id,runAttempt:1};
  }catch{}
  return {status:'dispatch_unknown'};
}

/**
 * Only a *cryptographically verified* GitHub OIDC payload can be supplied to
 * this function. It checks physical candidate correlation, NOT JWT validity.
 * A signed claim from the same repository but a different run/attempt fails.
 */
export function matchCandidateIdentity(
  verified:VerifiedGitHubClaims,
  expected:ConfirmedCandidate,
):boolean{
  return typeof verified.repository==='string' &&
    verified.repository===expected.repository &&
    verified.workflow_ref===expected.workflowRef &&
    verified.ref===expected.ref &&
    verified.event_name==='workflow_dispatch' &&
    verified.run_id===String(expected.runId) &&
    verified.run_attempt===String(expected.runAttempt) &&
    Number.isSafeInteger(expected.runId) && expected.runId>0 &&
    Number.isSafeInteger(expected.runAttempt) && expected.runAttempt>0;
}
