import {createRemoteJWKSet,jwtVerify} from 'jose';
import type {JWTPayload} from 'jose';
import {matchPinnedActionRunIdentity} from './github-dispatch.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import type {Plan} from './plan.ts';

type Db=Pick<D1Database,'prepare'>;
export type GithubActionKeys=Parameters<typeof jwtVerify>[1];
const githubKeys=createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type PinnedActionRow={run_id:string;step_id:string;state:string;capability_id:string;repository:string;repository_id:string;workflow_ref:string;ref:string;candidate_run_id:number|null;candidate_run_attempt:number|null;owner_run_id:number|null;owner_run_attempt:number|null;run_outcome:string;plan:string};

/**
 * Shared, read-only signature and immutable Published Plan verification for
 * first Claim and later Session Ready. Every token is verified independently;
 * a signed JWT alone does not grant ownership or prove readiness.
 */
export async function verifyPinnedGitHubActionIdentity(
 db:Db,attemptId:string,jwt:string,audience:string,
 keys:GithubActionKeys=githubKeys,
 allowSettledReadyReplay=false,
):Promise<{row:PinnedActionRow;action:ReviewedGitHubAction}|null>{
 if(!UUID.test(attemptId)||typeof jwt!=='string'||jwt.length>8192||
    !/^workflow-github-[a-z0-9:-]{4,120}$/.test(audience))return null;
 const row=await db.prepare(`SELECT a.run_id,a.step_id,a.state,a.capability_id,a.repository,
  a.repository_id,a.workflow_ref,a.ref,a.candidate_run_id,a.candidate_run_attempt,
  a.owner_run_id,a.owner_run_attempt,r.outcome AS run_outcome,v.plan
  FROM step_attempts a JOIN runs r ON r.id=a.run_id
  JOIN workflow_versions v ON v.id=r.version_id WHERE a.attempt_id=?`)
  .bind(attemptId).first<PinnedActionRow>();
 if(!row||row.capability_id!=='github.action'||
    !['confirmed','claimed'].includes(row.state)||
    !row.candidate_run_id||!row.candidate_run_attempt)return null;
 let plan:Plan;
 try{plan=JSON.parse(row.plan) as Plan;}catch{return null;}
 if(plan.github_execution_approved!==true||!Array.isArray(plan.steps))return null;
 const step=plan.steps.find(s=>s.id===row.step_id);
 if(!step||step.uses!=='github.run'||step.with?.capability!=='github.action')return null;
 const raw=step.with.action as (ReviewedGitHubAction & {inputs?:unknown;ref?:string})|undefined;
 if(!raw)return null;
 const action:ReviewedGitHubAction={
  repository:raw.repository,repositoryId:raw.repositoryId,
  workflowId:raw.workflowId,workflowPath:raw.workflowPath,
  commitSha:raw.commitSha,type:raw.type,contractDigest:raw.contractDigest,
 };
 // First Claim always requires an active parent. A Ready HTTP response
 // may be lost after D1 Ready was committed and the parent succeeded.
 // Permit only a *signed replay* of that exact already-Ready Session;
 // this exception cannot create a new Ready or revive a stopping job.
 if(!['queued','running'].includes(row.run_outcome)){
  if(!allowSettledReadyReplay || row.run_outcome!=='succeeded' ||
     action.type!=='session' || row.state!=='claimed')return null;
  const existing=await db.prepare(`SELECT state FROM session_executions
    WHERE run_id=? AND step_id=?`)
    .bind(row.run_id,row.step_id).first<{state:string}>();
  if(existing?.state!=='ready')return null;
 }
 if(!isPublishedGitHubActionApproved(plan.github_action_approvals,action)||
    row.repository!==action.repository||row.repository_id!==String(action.repositoryId)||
    row.workflow_ref!==action.repository+'/'+action.workflowPath+'@'+row.ref||
    row.ref!==raw.ref)return null;
 let claims:JWTPayload;
 try{
  const verified=await jwtVerify(jwt,keys,{issuer:'https://token.actions.githubusercontent.com',
   audience,algorithms:['RS256'],clockTolerance:'5s',maxTokenAge:'5m'});
  claims=verified.payload;
  if(typeof claims.iat!=='number'||typeof claims.exp!=='number'||claims.exp-claims.iat>600)return null;
 }catch{return null;}
 if(!matchPinnedActionRunIdentity(claims as JWTPayload & {
    repository_id?:unknown;sha?:unknown;repository?:unknown;workflow_ref?:unknown;
    ref?:unknown;run_id?:unknown;run_attempt?:unknown;event_name?:unknown;
   },{
    repository:row.repository,repositoryId:row.repository_id,workflowRef:row.workflow_ref,
    ref:row.ref,runId:row.candidate_run_id,runAttempt:row.candidate_run_attempt,
    commitSha:action.commitSha,
   }))return null;
 return {row,action};
}

/** First, one-time owner Claim; re-using the same JWT cannot claim twice. */
export async function verifyAndClaimPinnedGitHubAction(
 db:Db,attemptId:string,jwt:string,audience:string,
 keys:GithubActionKeys=githubKeys,
):Promise<boolean>{
 const valid=await verifyPinnedGitHubActionIdentity(db,attemptId,jwt,audience,keys);
 if(!valid)return false;
 const {row}=valid;
 if(row.state!=='confirmed'||row.owner_run_id!==null||row.owner_run_attempt!==null)return false;
 const written=await db.prepare(`UPDATE step_attempts
   SET state='claimed',owner_run_id=?,owner_run_attempt=?,updated_at=?
   WHERE attempt_id=? AND capability_id='github.action' AND state='confirmed'
    AND owner_run_id IS NULL AND owner_run_attempt IS NULL
    AND candidate_run_id=? AND candidate_run_attempt=?
    AND repository=? AND repository_id=? AND workflow_ref=? AND ref=?
    AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c
      WHERE c.attempt_id=step_attempts.attempt_id)
    AND EXISTS(SELECT 1 FROM runs WHERE id=step_attempts.run_id
      AND outcome IN ('queued','running'))`)
  .bind(row.candidate_run_id,row.candidate_run_attempt,Date.now(),attemptId,
   row.candidate_run_id,row.candidate_run_attempt,row.repository,row.repository_id,
   row.workflow_ref,row.ref).run();
 return written.meta.changes===1;
}
