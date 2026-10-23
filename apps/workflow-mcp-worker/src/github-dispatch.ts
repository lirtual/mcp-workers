/**
 * GitHub registered GitHub execution dispatch for the fixed Workflow CI verification capability.
 *
 * WorkflowRunner calls this with a reviewed server-side executor config and
 * a persisted logical Attempt; no repository, workflow, ref or credential
 * can come from a Draft or Run input.
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
  capabilityId:'github.workflow.check';
};
export type DispatchOutcome=
  | {status:'confirmed';runId:number;runAttempt:1}
  | {status:'rejected';httpStatus:400|401|403|404|422;
      reason:'integration_scope'|'rate_limit'|'workflow_trigger'|'policy'|'unknown'}
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
          config.ref!=='refs/heads/wip/workflow-github-executor' ||
          !/^workflow-github-(?:oidc|plan)-[a-f0-9]{10}$/.test(config.workerName??''))
       : (config.workflow!=='workflow-github-executor.yml' || config.workerName!==undefined)) ||
     !REPO.test(config.repository) || config.repository.includes('..') ||
     !BRANCH.test(config.ref) || config.ref.includes('..') ||
     config.ref.endsWith('/') || typeof config.dispatchToken!=='string' ||
     !config.dispatchToken.trim())
    throw new Error('github_executor_config_invalid');
  if(attempt.capabilityId!=='github.workflow.check' ||
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
      // GitHub REST requires a valid User-Agent; unlike Node, Workers fetch
      // must not rely on the runtime injecting one implicitly.
      'user-agent':'mcp-workers-workflow-executor',
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
          github_executor_worker:'true',
        }:{}),
      },
    }),
  });
  let response:Response;
  try {response=await outbound(request);}
  catch {return {status:'dispatch_unknown'};}
  // Documented 4xx rejection establishes no accepted dispatch. A timeout,
  // redirect, unexpected status, or malformed 200 can conceal acceptance.
  if([400,401,403,404,422].includes(response.status)){
    // Normalize recognized GitHub diagnostics, never return/log an untrusted
    // response body, arbitrary remote text, or authorization credentials.
    const body=await response.json().catch(()=>null) as {message?:unknown}|null;
    const message=typeof body?.message==='string'
      ?body.message.slice(0,250).toLowerCase():'';
    const reason=message.includes('resource not accessible by integration')
      ?'integration_scope'
      :message.includes('rate limit')||message.includes('rate-limited')
        ?'rate_limit'
      :message.includes('workflow_dispatch trigger')?'workflow_trigger'
      :message.includes('administrative rules')||message.includes('policy')
        ?'policy':'unknown';
    return {status:'rejected',
      httpStatus:response.status as 400|401|403|404|422,reason};
  }
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


/** No runtime or Plan input can elect the isolated CI executor. */
export function selectedGithubExecutor(
  env:{GITHUB_EXECUTOR_REPOSITORY?:string;GITHUB_EXECUTOR_REF?:string;GITHUB_TEST_WORKER_NAME?:string;GITHUB_TEST_DEDICATED_EXECUTOR?:string},
):{workflow:'workflow-github-executor.yml'|'ci.yml';workerName?:string}{
  if(env.GITHUB_TEST_WORKER_NAME===undefined){
    if(env.GITHUB_TEST_DEDICATED_EXECUTOR==='true')
      throw Error('github_executor_test_environment_invalid');
    return {workflow:'workflow-github-executor.yml'};
  }
  if(env.GITHUB_EXECUTOR_REPOSITORY!=='lirtual/mcp-workers'||
     env.GITHUB_EXECUTOR_REF!=='refs/heads/wip/workflow-github-executor'||
     !/^workflow-github-(?:oidc|plan)-[a-f0-9]{10}$/.test(env.GITHUB_TEST_WORKER_NAME))
    throw Error('github_executor_test_environment_invalid');
  if(env.GITHUB_TEST_DEDICATED_EXECUTOR==='true')
    return {workflow:'workflow-github-executor.yml'};
  return {workflow:'ci.yml',workerName:env.GITHUB_TEST_WORKER_NAME};
}

/**
 * Additional immutable source binding for protocol Actions.
 * Call ONLY after GitHub-issued JWT signature/issuer/audience verification,
 * and after the registered Attempt's physical run/attempt were loaded from D1.
 * The token alone must never approve a dispatch.
 */
export function matchPinnedActionRunIdentity(
  verified: VerifiedGitHubClaims & {repository_id?:unknown;sha?:unknown;job_workflow_sha?:unknown},
  expected: ConfirmedCandidate & {repositoryId:string;commitSha:string},
): boolean {
  return /^[a-f0-9]{40}$/i.test(expected.commitSha) &&
    /^\\d+$/.test(expected.repositoryId) &&
    verified.repository_id===expected.repositoryId &&
    verified.sha===expected.commitSha &&
    matchCandidateIdentity(verified,expected);
}
