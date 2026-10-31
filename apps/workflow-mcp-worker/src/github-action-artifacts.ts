import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import {publishedGitHubActionStep,type Plan} from './plan.ts';

type Db=Pick<D1Database,'prepare'>;
type Http=(request:Request)=>Promise<Response>;
type Attempt={step_id:string;repository:string;repository_id:string;workflow_ref:string;
 ref:string;owner_run_id:number|null;owner_run_attempt:number|null;
 candidate_run_id:number|null;candidate_run_attempt:number|null};
export type GitHubArtifactReference={provider:'github_actions';repository:string;repository_id:number;
 workflow_run_id:number;run_attempt:1;artifact_id:number;name:string;size_bytes:number;
 expires_at:string;digest?:string;requires_auth:'github_actions_read'};
export type GitHubArtifactObservation={step_id:string;status:'verified'|'none'|'unavailable';
 references:GitHubArtifactReference[]};
const MAX_TASKS=8,MAX_ARTIFACTS=8,MAX_RESPONSE=48*1024;
const isInteger=(n:unknown)=>Number.isSafeInteger(n)&&(n as number)>0;
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);

/** On-demand, bounded, credential-free metadata in workflow_result only.
 * The published Action, signed Claim, exact physical terminal and D1 Step
 * must all agree. This never saves artifact bytes or provider download URLs.
 */
export async function workflowGitHubArtifactReferences(
 db:Db,runId:string,token:string|undefined,http:Http=fetch,
):Promise<GitHubArtifactObservation[]>{
 if(!token?.trim())return [];
 const version=await db.prepare(`SELECT v.plan FROM runs r
   JOIN workflow_versions v ON v.id=r.version_id WHERE r.id=?`)
   .bind(runId).first<{plan:string}>();
 if(!version)return [];
 let plan:Plan;
 try{plan=JSON.parse(version.plan) as Plan;}catch{return [];}
 if(plan.github_execution_approved!==true)return [];
 const rows=(await db.prepare(`SELECT a.step_id,a.repository,a.repository_id,a.workflow_ref,a.ref,
   a.owner_run_id,a.owner_run_attempt,a.candidate_run_id,a.candidate_run_attempt
   FROM step_attempts a JOIN run_steps s ON s.run_id=a.run_id AND s.step_id=a.step_id
   WHERE a.run_id=? AND a.capability_id='github.action' AND a.state='succeeded'
     AND s.status='succeeded' ORDER BY a.step_id LIMIT ?`)
   .bind(runId,MAX_TASKS+1).all<Attempt>()).results;
 if(rows.length>MAX_TASKS)return [{step_id:'*',status:'unavailable',references:[]}];
 const results:GitHubArtifactObservation[]=[];
 for(const row of rows){
   const step=publishedGitHubActionStep(plan,row.step_id);
   if(!step||step.uses!=='github.run'||step.with.capability!=='github.action')continue;
   const action=step.with.action as (ReviewedGitHubAction&{ref?:string})|undefined;
   if(!action||action.type!=='task')continue;
   const identity:ReviewedGitHubAction={repository:action.repository,
     repositoryId:action.repositoryId,workflowId:action.workflowId,
     workflowPath:action.workflowPath,commitSha:action.commitSha,
     type:action.type,contractDigest:action.contractDigest};
   if(!isPublishedGitHubActionApproved(plan.github_action_approvals,identity))continue;
   if(row.repository!==action.repository||row.repository_id!==String(action.repositoryId)||
     row.ref!==action.ref||row.workflow_ref!==action.repository+'/'+action.workflowPath+'@'+row.ref||
     !isInteger(row.owner_run_id)||row.owner_run_id!==row.candidate_run_id||
     row.owner_run_attempt!==1||row.candidate_run_attempt!==1)continue;
   const entry:GitHubArtifactObservation={step_id:row.step_id,status:'unavailable',references:[]};
   results.push(entry);
   try{
     const response=await http(new Request('https://api.github.com/repos/'+action.repository+
       '/actions/runs/'+row.owner_run_id+'/artifacts?per_page=9',{redirect:'manual',headers:{
         accept:'application/vnd.github+json',authorization:'Bearer '+token,
         'x-github-api-version':'2026-03-10','user-agent':'workflow-mcp-artifact-metadata',
       }}));
     if(response.status!==200)continue;
     const length=Number(response.headers.get('content-length'));
     if(Number.isFinite(length)&&length>MAX_RESPONSE)continue;
     const raw=await response.text();
     if(raw.length>MAX_RESPONSE)continue;
     const data:unknown=JSON.parse(raw);
     if(!object(data)||!Array.isArray(data.artifacts)||
       !Number.isSafeInteger(data.total_count)||
       (data.total_count as number)>MAX_ARTIFACTS||
       data.artifacts.length>MAX_ARTIFACTS||data.artifacts.length!==data.total_count)continue;
     const refs:GitHubArtifactReference[]=[];
     let invalid=false;
     for(const item of data.artifacts){
       if(!object(item)||!object(item.workflow_run)||!isInteger(item.id)||
         typeof item.name!=='string'||!item.name||item.name.length>128||
         !Number.isSafeInteger(item.size_in_bytes)||Number(item.size_in_bytes)<0||
         item.expired!==false||typeof item.expires_at!=='string'||
         !Number.isFinite(Date.parse(item.expires_at))||Date.parse(item.expires_at)<=Date.now()||
         item.workflow_run.id!==row.owner_run_id||
         item.workflow_run.repository_id!==action.repositoryId||
         item.workflow_run.head_sha!==action.commitSha||
         (item.workflow_run.head_repository_id!==undefined&&
          item.workflow_run.head_repository_id!==action.repositoryId)){
         invalid=true;break;
       }
       if(item.digest!==undefined&&
          (typeof item.digest!=='string'||!/^sha256:[a-f0-9]{64}$/i.test(item.digest))){
         invalid=true;break;
       }
       refs.push({provider:'github_actions',repository:action.repository,
         repository_id:action.repositoryId,workflow_run_id:row.owner_run_id!,
         run_attempt:1,artifact_id:Number(item.id),name:item.name,
         size_bytes:Number(item.size_in_bytes),expires_at:item.expires_at,
         ...(item.digest?{digest:item.digest}:{}),requires_auth:'github_actions_read'});
     }
     if(invalid)continue;
     entry.references=refs;
     entry.status=refs.length?'verified':'none';
   }catch{/* An unknown read is not proof of an artifact or its absence. */}
 }
 return results;
}
