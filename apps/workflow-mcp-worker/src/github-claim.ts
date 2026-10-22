import { createRemoteJWKSet, jwtVerify } from 'jose';
import { matchCandidateIdentity, type DispatchOutcome } from './github-dispatch.ts';

/**
 * GitHub candidate authorization, first isolated slice only.
 * Never call this as a public MCP tool; an OIDC-only GitHub callback endpoint
 * will use it after its exact claim/attempt ID validation is implemented.
 *
 * OIDC proves GitHub job identity, NOT dispatch authorization. The confirmed
 * GitHub run and attempt must already be durably registered in D1.
 */
const ISSUER='https://token.actions.githubusercontent.com';
const GITHUB_JWKS=new URL('https://token.actions.githubusercontent.com/.well-known/jwks');
const githubKeys=createRemoteJWKSet(GITHUB_JWKS);
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO=/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
type KeyResolver=Parameters<typeof jwtVerify>[1];
export type AttemptDatabase=Pick<D1Database,'prepare'>;
export type ExecutorIdentity={
  repository:string;
  repositoryId:string;
  workflowRef:string;
  ref:string;
  audience:string;
};
export type AttemptRegistration=ExecutorIdentity & {
  attemptId:string;
  dispatchId:string;
  runId:string;
  stepId:string;
  capabilityId:'heavy.github.echo';
};
type AttemptRow={
  attempt_id:string;
  repository:string;
  repository_id:string;
  workflow_ref:string;
  ref:string;
  state:string;
  candidate_run_id:number|null;
  candidate_run_attempt:number|null;
  owner_run_id:number|null;
  owner_run_attempt:number|null;
  run_outcome:string;
};
function validateIdentity(c:ExecutorIdentity){
  if(!REPO.test(c.repository)||c.repository.includes('..')||
     !/^\d+$/.test(c.repositoryId)||
     !c.workflowRef.startsWith(c.repository+'/.github/workflows/')||
     !c.workflowRef.endsWith('@'+c.ref)||
     !/^[a-z0-9][a-z0-9_-]*\.yml$/.test(
       c.workflowRef.slice((c.repository+'/.github/workflows/').length,
         -(c.ref.length+1)))||
     !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(c.ref)||
     c.ref.includes('..')||c.ref.includes('//')||
     !/^workflow-github-[a-z0-9:-]{4,120}$/.test(c.audience))
    throw Error('github_oidc_expected_identity_invalid');
}

/** Register exactly one logical Attempt for an existing immutable Run+Step. */
export async function registerGithubAttempt(db:AttemptDatabase,a:AttemptRegistration):Promise<void>{
  validateIdentity(a);
  if(!ID.test(a.attemptId)||!ID.test(a.dispatchId)||
     !/^[a-zA-Z0-9_-]{1,128}$/.test(a.runId)||
     !/^[a-zA-Z0-9_-]{1,64}$/.test(a.stepId)||
     a.capabilityId!=='heavy.github.echo')
    throw Error('github_attempt_invalid');
  const time=Date.now();
  await db.prepare(`INSERT INTO step_attempts
    (attempt_id,run_id,step_id,capability_id,dispatch_id,state,
     repository,repository_id,workflow_ref,ref,created_at,updated_at)
    VALUES (?,?,?,?,?,'created',?,?,?,?,?,?)`).bind(
    a.attemptId,a.runId,a.stepId,a.capabilityId,a.dispatchId,
    a.repository,a.repositoryId,a.workflowRef,a.ref,time,time,
  ).run();
}

/** Store a dispatch ACK before a GitHub job can claim it; never retry here. */
export async function recordGithubDispatchResult(
  db:AttemptDatabase,attemptId:string,result:DispatchOutcome,
):Promise<boolean>{
  if(!ID.test(attemptId))throw Error('github_attempt_invalid');
  if(result.status==='confirmed'&&(!Number.isSafeInteger(result.runId)||result.runId<=0||
      result.runAttempt!==1))throw Error('github_dispatch_candidate_invalid');
  const state=result.status==='confirmed'?'confirmed':
    result.status==='rejected'?'rejected':'dispatch_unknown';
  const updated=await db.prepare(`UPDATE step_attempts SET state=?,
    candidate_run_id=?,candidate_run_attempt=?,updated_at=?
    WHERE attempt_id=? AND state='created' AND owner_run_id IS NULL`).bind(
    state,result.status==='confirmed'?result.runId:null,
    result.status==='confirmed'?result.runAttempt:null,Date.now(),attemptId,
  ).run();
  return updated.meta.changes===1;
}

/**
 * Verify the GitHub signature AND compare it with the D1-authorized physical
 * candidate. A job's signed identity alone is not permission to access an
 * Attempt. A selected row must already carry a confirmed dispatch candidate.
 * This helper is not exposed as an HTTP route or MCP operation.
 */
async function verifiedGithubCandidate(
  db:AttemptDatabase,attemptId:string,token:string,
  pinned:ExecutorIdentity,requiredState:'confirmed'|'claimed',
  keyResolver:KeyResolver,
):Promise<AttemptRow|null>{
  validateIdentity(pinned);
  if(!ID.test(attemptId)||typeof token!=='string'||token.length>8192)
    return null;
  const row=await db.prepare(`SELECT attempt_id,repository,repository_id,
    workflow_ref,ref,state,candidate_run_id,candidate_run_attempt,
    owner_run_id,owner_run_attempt,
    (SELECT outcome FROM runs WHERE runs.id=step_attempts.run_id) AS run_outcome
    FROM step_attempts WHERE attempt_id=?`).bind(attemptId).first<AttemptRow>();
  if(!row||!['queued','running'].includes(row.run_outcome)||
     row.state!==requiredState||
     !row.candidate_run_id||!row.candidate_run_attempt||
     row.repository!==pinned.repository||row.repository_id!==pinned.repositoryId||
     row.workflow_ref!==pinned.workflowRef||row.ref!==pinned.ref)
    return null;
  if(requiredState==='claimed'&&(row.owner_run_id!==row.candidate_run_id||
       row.owner_run_attempt!==row.candidate_run_attempt))return null;
  let claims:Record<string,unknown>;
  try{
    const {payload}=await jwtVerify(token,keyResolver,{
      issuer:ISSUER,audience:pinned.audience,
      algorithms:['RS256'],clockTolerance:'5s',maxTokenAge:'5m',
    });
    claims=payload;
    if(typeof payload.exp!=='number'||typeof payload.iat!=='number'||
       payload.exp-payload.iat>600||
       payload.repository_id!==pinned.repositoryId)
      return null;
  }catch{return null;}
  return matchCandidateIdentity(claims,{
    repository:row.repository,workflowRef:row.workflow_ref,ref:row.ref,
    runId:row.candidate_run_id,runAttempt:row.candidate_run_attempt,
  })?row:null;
}

/**
 * A signed callback from the already claimed owner is authenticated before
 * the D1 receipt insert. No ownership is transferred by this verification.
 */
export async function verifyGithubClaimedOwner(
  db:AttemptDatabase,attemptId:string,token:string,
  pinned:ExecutorIdentity,keyResolver:KeyResolver=githubKeys,
):Promise<boolean>{
  return !!(await verifiedGithubCandidate(
    db,attemptId,token,pinned,'claimed',keyResolver,
  ));
}

/**
 * Validate the GitHub-issued RS256 JWT before a conditional owner Claim.
 * The callback's attempt ID is a LOOKUP ONLY. Repository/ref/Run ID are taken
 * from server-side pinned config and the confirmed D1 candidate.
 */
export async function verifyAndClaimGithubAttempt(
  db:AttemptDatabase,attemptId:string,token:string,
  pinned:ExecutorIdentity,keyResolver:KeyResolver=githubKeys,
):Promise<boolean>{
  const a=await verifiedGithubCandidate(
    db,attemptId,token,pinned,'confirmed',keyResolver,
  );
  if(!a)return false;
  const result=await db.prepare(`UPDATE step_attempts
    SET state='claimed',owner_run_id=?,owner_run_attempt=?,updated_at=?
    WHERE attempt_id=? AND state='confirmed'
      AND owner_run_id IS NULL AND owner_run_attempt IS NULL
      AND candidate_run_id=? AND candidate_run_attempt=?
      AND repository=? AND repository_id=? AND workflow_ref=? AND ref=?
      AND EXISTS(SELECT 1 FROM runs
        WHERE runs.id=step_attempts.run_id
        AND runs.outcome IN ('queued','running'))`).bind(
    a.candidate_run_id,a.candidate_run_attempt,Date.now(),attemptId,
    a.candidate_run_id,a.candidate_run_attempt,a.repository,a.repository_id,
    a.workflow_ref,a.ref,
  ).run();
  return result.meta.changes===1;
}
