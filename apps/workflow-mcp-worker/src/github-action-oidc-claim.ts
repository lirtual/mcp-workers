import {createRemoteJWKSet,jwtVerify} from 'jose';
import type {JWTPayload} from 'jose';
import {matchPinnedActionRunIdentity} from './github-dispatch.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import type {Plan} from './plan.ts';

type Db=Pick<D1Database,'prepare'>;
type Keys=Parameters<typeof jwtVerify>[1];
const githubKeys=createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Row={run_id:string;step_id:string;state:string;capability_id:string;repository:string;repository_id:string;workflow_ref:string;ref:string;candidate_run_id:number|null;candidate_run_attempt:number|null;owner_run_id:number|null;owner_run_attempt:number|null;run_outcome:string;plan:string};

/**
 * Verify GitHub-issued identity against both D1's confirmed physical candidate
 * and the immutable published Action. No caller supplied repo, ref or SHA.
 * The endpoint wiring must select the server-owned audience.
 */
export async function verifyAndClaimPinnedGitHubAction(
 db:Db,attemptId:string,jwt:string,audience:string,
 keys:Keys=githubKeys,
):Promise<boolean>{
 if(!UUID.test(attemptId)||typeof jwt!=='string'||jwt.length>8192||
    !/^workflow-github-[a-z0-9:-]{4,120}$/.test(audience))return false;
 const row=await db.prepare(`SELECT a.run_id,a.step_id,a.state,a.capability_id,a.repository,
  a.repository_id,a.workflow_ref,a.ref,a.candidate_run_id,a.candidate_run_attempt,
  a.owner_run_id,a.owner_run_attempt,r.outcome AS run_outcome,v.plan
  FROM step_attempts a JOIN runs r ON r.id=a.run_id
  JOIN workflow_versions v ON v.id=r.version_id WHERE a.attempt_id=?`)
  .bind(attemptId).first<Row>();
 if(!row||row.capability_id!=='github.action'||row.state!=='confirmed'||
    !['queued','running'].includes(row.run_outcome)||
    row.owner_run_id!==null||row.owner_run_attempt!==null||
    !row.candidate_run_id||!row.candidate_run_attempt)return false;
 let plan:Plan;
 try{plan=JSON.parse(row.plan) as Plan;}catch{return false;}
 if(plan.github_execution_approved!==true||!Array.isArray(plan.steps))return false;
 const step=plan.steps.find(s=>s.id===row.step_id);
 if(!step||step.uses!=='github.run'||step.with?.capability!=='github.action')return false;
 const action=step.with.action as ReviewedGitHubAction|undefined;
 if(!action||!isPublishedGitHubActionApproved(plan.github_action_approvals,action)||
    row.repository!==action.repository||row.repository_id!==String(action.repositoryId)||
    row.workflow_ref!==action.repository+'/'+action.workflowPath+'@'+row.ref)return false;
 let claims:JWTPayload;
 try{
  const verified=await jwtVerify(jwt,keys,{issuer:'https://token.actions.githubusercontent.com',
   audience,algorithms:['RS256'],clockTolerance:'5s',maxTokenAge:'5m'});
  claims=verified.payload;
  if(typeof claims.iat!=='number'||typeof claims.exp!=='number'||claims.exp-claims.iat>600)return false;
 }catch{return false;}
 if(!matchPinnedActionRunIdentity(claims,{
  repository:row.repository,repositoryId:row.repository_id,workflowRef:row.workflow_ref,
  ref:row.ref,runId:row.candidate_run_id,runAttempt:row.candidate_run_attempt,
  commitSha:action.commitSha,
 }))return false;
 const written=await db.prepare(`UPDATE step_attempts
   SET state='claimed',owner_run_id=?,owner_run_attempt=?,updated_at=?
   WHERE attempt_id=? AND capability_id='github.action' AND state='confirmed'
    AND owner_run_id IS NULL AND owner_run_attempt IS NULL
    AND candidate_run_id=? AND candidate_run_attempt=?
    AND repository=? AND repository_id=? AND workflow_ref=? AND ref=?
    AND EXISTS(SELECT 1 FROM runs WHERE id=step_attempts.run_id
      AND outcome IN ('queued','running'))`)
  .bind(row.candidate_run_id,row.candidate_run_attempt,Date.now(),attemptId,
   row.candidate_run_id,row.candidate_run_attempt,row.repository,row.repository_id,
   row.workflow_ref,row.ref).run();
 return written.meta.changes===1;
}
