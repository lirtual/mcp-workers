/** Shared GitHub Action dispatch outcomes and signed physical job identity predicates. */
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

/** Compare cryptographically verified OIDC claims with the persisted Job identity. */
export function matchCandidateIdentity(
  verified:VerifiedGitHubClaims,expected:ConfirmedCandidate,
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

/** Only a signed, exact reviewed SHA and physical GitHub Job can own an Action. */
export function matchPinnedActionRunIdentity(
  verified: VerifiedGitHubClaims & {repository_id?:unknown;sha?:unknown;job_workflow_sha?:unknown},
  expected: ConfirmedCandidate & {repositoryId:string;commitSha:string},
): boolean {
  return /^[a-f0-9]{40}$/i.test(expected.commitSha) &&
    /^\d+$/.test(expected.repositoryId) &&
    verified.repository_id===expected.repositoryId &&
    verified.sha===expected.commitSha &&
    matchCandidateIdentity(verified,expected);
}
