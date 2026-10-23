import {parseRegisteredInputs,REGISTERED_GITHUB_ACTION,registeredWorkflowRef} from './github-registry.ts';

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
  | {status:'confirmed';runId:number;runAttempt:1;headSha?:string}
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
    const confirmed=confirmedDispatch(await response.json());
    if(confirmed)return {status:'confirmed',runId:confirmed.runId,runAttempt:1,...(confirmed.headSha?{headSha:confirmed.headSha}:{})};
  }catch{}
  return {status:'dispatch_unknown'};
}

const GITHUB_HEADERS=(token:string)=>({
  accept:'application/vnd.github+json',
  authorization:'Bearer '+token,
  'x-github-api-version':'2026-03-10',
  'user-agent':'mcp-workers-workflow-executor',
});
const COMPLETED_CONCLUSIONS=new Set([
  'success','failure','neutral','skipped','timed_out','stale','action_required',
]);

export type GithubExecutionObservation=
  | {kind:'open';headSha?:string}
  | {kind:'cancelled';headSha?:string}
  | {kind:'completed';conclusion:string;headSha?:string}
  | {kind:'unknown'};

/**
 * One normal cancel. HTTP 202 only means GitHub accepted the request.
 * This never calls force-cancel, because that can skip cleanup.
 */
export async function cancelRegisteredGithubRun(
  repository:string, runId:number, token:string,
  outbound:(request:Request)=>Promise<Response>=fetch,
):Promise<boolean>{
  if(!REPO.test(repository)||repository.includes('..')||
     !Number.isSafeInteger(runId)||runId<=0||!token.trim()) return false;
  let response:Response;
  try{
    response=await outbound(new Request(
      'https://api.github.com/repos/'+repository+'/actions/runs/'+runId+'/cancel',
      {method:'POST',redirect:'manual',headers:GITHUB_HEADERS(token)},
    ));
  }catch{return false;}
  if(response.status>=300&&response.status<400) return false;
  return response.status===202;
}

async function githubObject(response:Response):Promise<Record<string,unknown>|null>{
  if(response.status<200||response.status>=300) return null;
  try{
    const value:unknown=await response.json();
    if(!value||typeof value!=='object'||Array.isArray(value)) return null;
    return value as Record<string,unknown>;
  }catch{return null;}
}

/**
 * Read the registered run and its jobs. A non-terminal or unreadable payload
 * is not a physical stop. The body is not returned to the caller.
 */
export async function observeRegisteredGithubRun(
  repository:string, runId:number, token:string,
  outbound:(request:Request)=>Promise<Response>=fetch,
):Promise<GithubExecutionObservation>{
  if(!REPO.test(repository)||repository.includes('..')||
     !Number.isSafeInteger(runId)||runId<=0||!token.trim()) return {kind:'unknown'};
  const runUrl='https://api.github.com/repos/'+repository+'/actions/runs/'+runId;
  let runResponse:Response;
  try{
    runResponse=await outbound(new Request(runUrl,{method:'GET',redirect:'manual',headers:GITHUB_HEADERS(token)}));
  }catch{return {kind:'unknown'};}
  if(runResponse.status>=300&&runResponse.status<400) return {kind:'unknown'};
  const run=await githubObject(runResponse);
  if(!run||typeof run.status!=='string') return {kind:'unknown'};
  const headSha=githubHeadSha(run.head_sha);
  if(run.status!=='completed') return headSha?{kind:'open',headSha}:{kind:'open'};
  if(typeof run.conclusion!=='string') return {kind:'unknown'};
  let jobsResponse:Response;
  try{
    jobsResponse=await outbound(new Request(runUrl+'/jobs?per_page=100',{
      method:'GET',redirect:'manual',headers:GITHUB_HEADERS(token),
    }));
  }catch{return {kind:'unknown'};}
  if(jobsResponse.status>=300&&jobsResponse.status<400) return {kind:'unknown'};
  const jobsBody=await githubObject(jobsResponse);
  if(!jobsBody||!Array.isArray(jobsBody.jobs)||typeof jobsBody.total_count!=='number'||
     !Number.isSafeInteger(jobsBody.total_count)) return {kind:'unknown'};
  const jobs=jobsBody.jobs;
  if(jobsBody.total_count!==jobs.length||jobs.length===0||jobs.length>100) return {kind:'unknown'};
  const conclusions:string[]=[];
  for(const job of jobs){
    if(!job||typeof job!=='object'||Array.isArray(job)) return {kind:'unknown'};
    const status=(job as {status?:unknown}).status;
    const conclusion=(job as {conclusion?:unknown}).conclusion;
    if(status!=='completed'||typeof conclusion!=='string') return {kind:'unknown'};
    conclusions.push(conclusion);
  }
  if(run.conclusion==='cancelled'){
    return conclusions.every(item=>item==='cancelled'||item==='skipped')
      ?(headSha?{kind:'cancelled',headSha}:{kind:'cancelled'}):{kind:'unknown'};
  }
  if(!COMPLETED_CONCLUSIONS.has(run.conclusion)||conclusions.some(item=>item==='cancelled'))
    return {kind:'unknown'};
  return headSha?{kind:'completed',conclusion:run.conclusion,headSha}:{kind:'completed',conclusion:run.conclusion};
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
 * Dispatch only the source allow-listed workflow. The caller cannot pass a
 * repository, ref, or workflow file. One POST; ambiguous results are not retried.
 */
export async function dispatchAllowListedGithubAction(
  inputs:Record<string,string>,
  attempt:{attemptId:string;dispatchId:string},
  dispatchToken:string,
  outbound:(request:Request)=>Promise<Response>=fetch,
):Promise<DispatchOutcome>{
  if(!parseRegisteredInputs(inputs)||!UUID.test(attempt.attemptId)||!UUID.test(attempt.dispatchId)||
     typeof dispatchToken!=='string'||!dispatchToken.trim())
    throw new Error('github_action_inputs_invalid');
  const action=REGISTERED_GITHUB_ACTION;
  const request=githubRequest(
    'https://api.github.com/repos/'+action.repository+'/actions/workflows/'+action.workflow+'/dispatches',
    dispatchToken,{
      ref:action.ref.slice('refs/heads/'.length),
      return_run_details:true,
      inputs:{subject:inputs.subject},
    });
  return postDispatch(request,outbound);
}

export type AllowListedRead=
  | {status:'pending';headSha?:string}
  | {status:'inconclusive'}
  | {status:'completed';outcome:'succeeded'|'failed';result:unknown;headSha?:string};

/** Read one confirmed run. Never dispatches. URLs in the result are synthesized. */
export async function readAllowListedGithubExecution(
  runId:number,
  dispatchToken:string,
  outbound:(request:Request)=>Promise<Response>=fetch,
):Promise<AllowListedRead>{
  if(!Number.isSafeInteger(runId)||runId<=0||typeof dispatchToken!=='string'||!dispatchToken.trim())
    return {status:'inconclusive'};
  const action=REGISTERED_GITHUB_ACTION;
  const run=await githubJson(outbound,githubRequest(
    'https://api.github.com/repos/'+action.repository+'/actions/runs/'+runId,dispatchToken));
  if(!run)return {status:'inconclusive'};
  const body=run as {
    id?:unknown;status?:unknown;conclusion?:unknown;event?:unknown;path?:unknown;
    head_branch?:unknown;run_attempt?:unknown;head_sha?:unknown;repository?:{full_name?:unknown};
  };
  const branch=action.ref.slice('refs/heads/'.length);
  const identity=body.id===runId && body.event==='workflow_dispatch' &&
    body.path==='.github/workflows/'+action.workflow && body.head_branch===branch &&
    body.run_attempt===1 &&
    (body.repository===undefined || body.repository?.full_name===action.repository);
  if(!identity||typeof body.status!=='string')return {status:'inconclusive'};
  const headSha=githubHeadSha(body.head_sha);
  if(body.status!=='completed')return headSha?{status:'pending',headSha}:{status:'pending'};
  const failed=body.conclusion==='failure'||body.conclusion==='cancelled'||
    body.conclusion==='timed_out'||body.conclusion==='startup_failure';
  if(body.conclusion!=='success'&&!failed)return {status:'inconclusive'};
  if(failed)return {status:'completed',outcome:'failed',result:executionResult('failure',runId,[],headSha),...(headSha?{headSha}:{})};
  const listed=await githubJson(outbound,githubRequest(
    'https://api.github.com/repos/'+action.repository+'/actions/runs/'+runId+'/artifacts?per_page=8',
    dispatchToken));
  if(!listed)return {status:'inconclusive'};
  const artifacts=artifactReferences(listed);
  if(!artifacts)return {status:'inconclusive'};
  return {status:'completed',outcome:'succeeded',result:executionResult('success',runId,artifacts,headSha),...(headSha?{headSha}:{})};
}

function githubRequest(url:string,token:string,body?:unknown):Request{
  return new Request(url,{
    method:body===undefined?'GET':'POST',redirect:'manual',
    headers:{
      accept:'application/vnd.github+json',
      authorization:'Bearer '+token,
      'x-github-api-version':'2026-03-10',
      'user-agent':'mcp-workers-workflow-executor',
      ...(body===undefined?{}:{'content-type':'application/json'}),
    },
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
}

async function postDispatch(
  request:Request,outbound:(request:Request)=>Promise<Response>,
):Promise<DispatchOutcome>{
  let response:Response;
  try{response=await outbound(request);}
  catch{return {status:'dispatch_unknown'};}
  if([400,401,403,404,422].includes(response.status)){
    const body=await response.json().catch(()=>null) as {message?:unknown}|null;
    const message=typeof body?.message==='string'?body.message.slice(0,250).toLowerCase():'';
    const reason=message.includes('resource not accessible by integration')?'integration_scope'
      :message.includes('rate limit')||message.includes('rate-limited')?'rate_limit'
      :message.includes('workflow_dispatch trigger')?'workflow_trigger'
      :message.includes('administrative rules')||message.includes('policy')?'policy':'unknown';
    return {status:'rejected',httpStatus:response.status as 400|401|403|404|422,reason};
  }
  if(response.status!==200)return {status:'dispatch_unknown'};
  try{
    const confirmed=confirmedDispatch(await response.json());
    if(confirmed)return {status:'confirmed',runId:confirmed.runId,runAttempt:1,...(confirmed.headSha?{headSha:confirmed.headSha}:{})};
  }catch{}
  return {status:'dispatch_unknown'};
}

async function githubJson(
  outbound:(request:Request)=>Promise<Response>,request:Request,
):Promise<unknown|null>{
  try{
    const response=await outbound(request);
    if(response.status!==200)return null;
    return await response.json();
  }catch{return null;}
}

const HEAD_SHA=/^[0-9a-f]{40}$/i;
export function githubHeadSha(value:unknown):string|undefined{
  return typeof value==='string'&&HEAD_SHA.test(value)?value.toLowerCase():undefined;
}
function confirmedDispatch(value:unknown):{runId:number;headSha?:string}|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const result=value as {workflow_run_id?:unknown;head_sha?:unknown};
  if(typeof result.workflow_run_id!=='number'||!Number.isSafeInteger(result.workflow_run_id)||result.workflow_run_id<=0)
    return null;
  const headSha=githubHeadSha(result.head_sha);
  return headSha?{runId:result.workflow_run_id,headSha}:{runId:result.workflow_run_id};
}
function executionResult(conclusion:'success'|'failure',runId:number,artifacts:ArtifactReference[],headSha?:string){
  const action=REGISTERED_GITHUB_ACTION;
  return {
    task:action.id,
    conclusion,
    run:{
      id:runId,attempt:1,status:'completed' as const,
      html_url:'https://github.com/'+action.repository+'/actions/runs/'+runId,
      ...(headSha?{head_sha:headSha}:{}),
    },
    implementation:{
      repository:action.repository,
      repository_id:action.repositoryId,
      workflow:action.workflow,
      ref:action.ref,
      workflow_ref:registeredWorkflowRef(),
    },
    artifacts,
  };
}

type ArtifactReference={
  id:number;name:string;size_in_bytes:number;expired:boolean;expires_at:string|null;url:string;
};
const ARTIFACT_NAME=/^[A-Za-z0-9._-]{1,80}$/;
const EXPIRES=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function artifactReferences(value:unknown):ArtifactReference[]|null{
  const body=value as {artifacts?:unknown};
  if(!body||typeof body!=='object'||!Array.isArray(body.artifacts)||body.artifacts.length>32)return null;
  const action=REGISTERED_GITHUB_ACTION;
  const artifacts:ArtifactReference[]=[];
  for(const entry of body.artifacts){
    if(artifacts.length>=8)break;
    const item=entry as {id?:unknown;name?:unknown;size_in_bytes?:unknown;expired?:unknown;expires_at?:unknown};
    if(typeof item.id!=='number'||!Number.isSafeInteger(item.id)||item.id<=0)continue;
    if(typeof item.name!=='string'||!ARTIFACT_NAME.test(item.name))continue;
    if(typeof item.size_in_bytes!=='number'||!Number.isSafeInteger(item.size_in_bytes)||item.size_in_bytes<0)continue;
    if(typeof item.expired!=='boolean')continue;
    const expires=item.expires_at===null||item.expires_at===undefined?null:
      typeof item.expires_at==='string'&&EXPIRES.test(item.expires_at)?item.expires_at:null;
    if(item.expires_at!==null&&item.expires_at!==undefined&&expires===null&&typeof item.expires_at==='string')continue;
    artifacts.push({
      id:item.id,name:item.name,size_in_bytes:item.size_in_bytes,expired:item.expired,expires_at:expires,
      url:'https://api.github.com/repos/'+action.repository+'/actions/artifacts/'+item.id,
    });
  }
  return artifacts;
}
