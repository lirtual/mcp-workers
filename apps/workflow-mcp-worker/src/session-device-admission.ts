/** Spec #62: physical Session job evidence and a conservative grant deadline.
 * These are public-to-test seams, not a new HTTP authorization endpoint.
 */
import {isSessionDurationInputRef} from './github-action-inputs.ts';
import type {ReviewedGitHubAction} from './github-action-review.ts';

type Http=(request:Request)=>Promise<Response>;
const MAX_BODY=32_768;
const MAX_DURATION=300;
export const SESSION_REPOSITORY = 'lirtual/github-actions';
export const SESSION_REPOSITORY_ID = 1430925009;
const WORKFLOWS=new Map([
  ['.github/workflows/windows.yml','windows'],
  ['.github/workflows/ubuntu.yml','ubuntu'],
]);
const validMinute=(value:unknown):value is number=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=1&&value<=MAX_DURATION;

/** Never trust the Runner's clock, a mutable repository variable, or an
 * enrollment-time duration. Only a reviewed explicit Plan or its frozen
 * runtime input binding gives an independently verifiable duration.
 * Repository-mode Sessions remain SSH/RDP-ready but rca-denied unless
 * authoritative duration attestation is implemented.
 */
export function resolveSessionDeadline(
  pinned:Record<string,unknown>,defaults:Record<string,unknown>,
  supplied:Record<string,unknown>,jobStartedAt:number,
):number|null{
  if(!Number.isSafeInteger(jobStartedAt)||jobStartedAt<=0)return null;
  if(pinned.duration_mode!==undefined&&pinned.duration_mode!=='explicit')return null;
  let minutes:unknown=pinned.duration_minutes;
  if(isSessionDurationInputRef(minutes)){
    if(defaults.duration_minutes!==300)return null;
    minutes=Object.hasOwn(supplied,'duration_minutes')
      ? supplied.duration_minutes:defaults.duration_minutes;
  }
  if(!validMinute(minutes))return null;
  const expiresAt=jobStartedAt+minutes*60_000;
  return Number.isSafeInteger(expiresAt)?expiresAt:null;
}

/** The attempt-specific GitHub jobs endpoint is the source of physical
 * started_at. One reviewed job only; never infer start from a Runner marker.
 * Every call is bounded, cannot redirect and must authenticate to GitHub.
 */
export async function inspectSessionJobStart(
  action:ReviewedGitHubAction,runId:number,runAttempt:number,token:string,
  http:Http=fetch,now=Date.now(),
):Promise<number|null>{
  const expectedName=WORKFLOWS.get(action.workflowPath);
  if((action.repository!==SESSION_REPOSITORY||action.repositoryId!==SESSION_REPOSITORY_ID)||
     action.type!=='session'||
     !expectedName||!Number.isSafeInteger(runId)||runId<=0||
     !Number.isSafeInteger(runAttempt)||runAttempt<=0||
     !/^[a-f0-9]{40}$/i.test(action.commitSha)||
     typeof token!=='string'||!token.trim()||!Number.isSafeInteger(now))return null;
  try{
    const request=new Request('https://api.github.com/repos/'+action.repository+
      '/actions/runs/'+runId+'/attempts/'+runAttempt+'/jobs?per_page=2&page=1',{
      redirect:'manual',signal:AbortSignal.timeout(5_000),
      headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,
        'x-github-api-version':'2026-03-10','user-agent':'workflow-mcp-session-admission'},
    });
    const response=await http(request);
    if(response.status!==200)return null;
    const body=await response.text();
    if(body.length>MAX_BODY)return null;
    const data=JSON.parse(body) as {total_count?:unknown;jobs?:unknown};
    if(data?.total_count!==1||!Array.isArray(data.jobs)||data.jobs.length!==1)return null;
    const job=data.jobs[0] as Record<string,unknown>;
    if(!Number.isSafeInteger(job.id)||(job.id as number)<=0||
      job.run_id!==runId||job.head_sha!==action.commitSha||
      job.name!=='session'||job.workflow_name!==expectedName||
      job.status!=='in_progress'||typeof job.started_at!=='string'||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(job.started_at))return null;
    const timestamp=Date.parse(job.started_at);
    if(!Number.isSafeInteger(timestamp)||timestamp<=0||timestamp>now)return null;
    return timestamp;
  }catch{return null;}
}
