import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Spec #392: narrowly scoped historical evidence, never a general opt-out.
export const TERMINAL_RUN_ID = "47739981-0534-4966-8034-1e79c1d17481";
export const TERMINAL_SESSION_GITHUB_RUN_ID = 40324650847;
export const SECOND_TERMINAL_RUN_ID = "8e0a94a7-136f-41fd-b839-211c9a60ad49";
export const SECOND_SESSION_GITHUB_RUN_ID = 40654886218;
// Exact 2026-10-28 owner-confirmed, machine-unknown delivery; no replay.
export const THIRD_TERMINAL_RUN_ID = "9da5816a-e7d9-481a-8203-3a2036534563";
export const THIRD_SESSION_GITHUB_RUN_ID = 40722496262;
export const THIRD_PROVIDER_INVOCATION_ID = "223af10e-dcf4-48c3-8c06-a39e60fa758b";
export const THIRD_PROVIDER_DEPLOYMENT_ID = "8df4f696-2f04-4043-9123-285c7aa86b0d";
// Fourth exact owner-confirmed 2026-10-29 E2E; machine outcome remains unknown.
export const FOURTH_TERMINAL_RUN_ID = "22625b58-e260-4988-81b6-04352a2d5f11";
export const FOURTH_SESSION_GITHUB_RUN_ID = 40792650738;
export const FOURTH_PROVIDER_INVOCATION_ID = "27cf5b0e-3b9c-4d9f-a9bd-db76c2266ea5";
export const FOURTH_PROVIDER_DEPLOYMENT_ID = "12970996-4220-4731-b76e-a0c8aa7a5017";

// Fifth exact 2026-10-29 Owner-delivered E2E; upstream ACK is unknown.
export const FIFTH_TERMINAL_RUN_ID = "a1970556-a529-46c2-9bb1-81980b51557e";
export const FIFTH_SESSION_GITHUB_RUN_ID = 40803663333;
export const FIFTH_PROVIDER_INVOCATION_ID = "2adf4608-c075-425d-a93d-d7d74211a295";
export const FIFTH_PROVIDER_DEPLOYMENT_ID = "3d61997c-eb30-46e3-b96f-334343d061af";

// Sixth exact 2026-10-29 inspected ACK-shape E2E; machine result remains unknown.
export const SIXTH_TERMINAL_RUN_ID = "3e312105-b40e-49ea-a037-c3359074be2b";
export const SIXTH_SESSION_GITHUB_RUN_ID = 40806497790;
export const SIXTH_PROVIDER_INVOCATION_ID = "83b722f0-4ed3-4a7d-838c-78613f5167f1";
export const SIXTH_PROVIDER_DEPLOYMENT_ID = "aeed581e-2769-4cde-9f6a-236d6414b4a2";
// Exact 2026-10-30 download E2E: cloud upload verified, Weixin invocation absent.
export const SEVENTH_TERMINAL_RUN_ID = "0bb5f19e-627e-440d-9757-7dfd9a0af31d";
export const SEVENTH_TASK_GITHUB_RUN_ID = 41046399301;

// Two exact 2026-10-31 Saga Session attempts: native and physical jobs are terminal,
// but historical business outcomes remain indeterminate and must not be rewritten.
export const NINTH_TERMINAL_RUN_ID = "29e121ab-de3e-43dd-b3bb-6e6d495fa2b1";
export const NINTH_SESSION_GITHUB_RUN_ID = 41146470419;
export const TENTH_TERMINAL_RUN_ID = "eab7b71f-b857-4569-afde-fd269cd1b2bb";
export const TENTH_SESSION_GITHUB_RUN_ID = 41147999088;
// Exact 2026-10-31 generic text E2E: the Provider has NO durable receipt.
// Preserve the unknown business outcome; do not replay its invocation.
export const ELEVENTH_TERMINAL_RUN_ID = "5813140e-6559-469c-8e0a-d6800ff33331";
export const ELEVENTH_WORKFLOW_ID = "8ab02be9-f010-4359-bc25-938e47b896eb";
export const ELEVENTH_VERSION_ID = "ff87097f-e2f1-4454-b845-7715d86d06b8";
export const ELEVENTH_INVOCATION_ID = "87d62d6e-32aa-4bdc-91d8-c70260f37f55";
export const ELEVENTH_PROVIDER_VERSION = "95e42878-91e9-49db-aae8-4703725a027f";
export const ELEVENTH_INPUT_DIGEST = "a291503723b808ef09cfecb7277a91bcecd4e943771a065a987462f79113d315";
export const ELEVENTH_CONTRACT_DIGEST = "aa9f078a8a7f8ea2f816286b9c023aeadee3e1cd038b197df08567bcebc04e1b";
const ELEVENTH_WEIXIN_DB = "051c3b6d-e3bc-4d69-907f-37e8ab00618f";
// #179: exact GitHub Artifact E2E with confirmed Claim and one signed result.
export const TWELFTH_TERMINAL_RUN_ID = "f99bb918-2909-46df-b196-d07faa64df27";
export const TWELFTH_WORKFLOW_ID = "685026cf-abaa-4618-a363-5944fac729d2";
export const TWELFTH_VERSION_ID = "88158dd2-25c9-4e66-b98a-51ac34f829e0";
export const TWELFTH_ATTEMPT_ID = "c7893834-10ff-41d5-b784-a33d00cc20f5";
export const TWELFTH_GITHUB_RUN_ID = 41182432750;
const TWELFTH_REPOSITORY_ID = 1430925009;
const TWELFTH_WORKFLOW_GITHUB_ID = 394689660;
const TWELFTH_TAG = "refs/tags/v0.1.42-rc.10";
const TWELFTH_SHA = "f5d44ff5a5dbd5b1b444c907e3654266a465da85";
const WORKFLOW = "workflow-mcp-orchestrator";
// GitHub repository renamed; read current API path without rewriting historic D1 evidence.
export const HISTORICAL_GITHUB_RUNS_API = "https://api.github.com/repos/lirtual/github-actions/actions/runs/";

// The six exact instances were all verified before Cloudflare pruned history.
// Success at this pinned, owner-only release is independent D1/native/GitHub proof.
const PRIOR_RELEASE_ID = 40871993462;
const VERIFIED_PRIOR_COMPLETION = Symbol("previous-native-proof");
const PRIOR_RELEASE_JOB_ID = 123441577953;
const PRIOR_RELEASE_SHA = "85464b14040e174f3ea43f6e4acd92b29c523563";
const PRIOR_PROOF_STEPS = [
  "Verify historical terminal Run proof (read-only)",
  "Verify second terminal E2E Run proof (read-only)",
  "Verify third terminal E2E Run proof (read-only)",
  "Verify fourth terminal E2E Run proof (read-only)",
  "Verify fifth terminal E2E Run proof (read-only)",
  "Verify sixth terminal E2E Run proof (read-only)",
];
export function verifyPriorNativeProof(run, jobs) {
  requireValid(run?.id === PRIOR_RELEASE_ID &&
    run?.workflow_id === 394912681 &&
    run?.head_sha === PRIOR_RELEASE_SHA &&
    run?.event === "workflow_dispatch" && run?.status === "completed" &&
    run?.conclusion === "success", "prior native proof release identity changed");
  const job = jobs?.jobs?.find(j => j.id === PRIOR_RELEASE_JOB_ID);
  requireValid(job?.name === "Manual selected Worker release" &&
    job?.status === "completed" && job?.conclusion === "success" &&
    job?.head_sha === PRIOR_RELEASE_SHA &&
    PRIOR_PROOF_STEPS.every(name =>
      job.steps?.filter(s => s.name === name && s.conclusion === "success").length === 1),
    "prior native proof not fully verified");
  return Object.freeze({[VERIFIED_PRIOR_COMPLETION]:true});
}
const nativeCompleteProven = native =>
  (native?.status === "complete" && !!native?.end) ||
  native?.[VERIFIED_PRIOR_COMPLETION] === true;


function requireValid(test, message) {
  if (!test) throw Error("Historical Workflow release blocked: " + message);
}

export function verifyTerminalRunEvidence(d1, native, github) {
  requireValid(Array.isArray(d1) && d1.length === 4 &&
    d1.every(group => group?.success === true && Array.isArray(group.results)),
    "incomplete production D1 readback");
  const [runs, steps, sessions, attempts] = d1.map(group => group.results);
  requireValid(runs.length === 1 && runs[0].id === TERMINAL_RUN_ID &&
    runs[0].outcome === "indeterminate" &&
    runs[0].start_state === "started" &&
    runs[0].error_code === "github_session_no_ready",
    "historical Run identity or result changed");
  requireValid(steps.length === 1 && steps[0].run_id === TERMINAL_RUN_ID &&
    steps[0].step_id === "openlist_session" &&
    steps[0].status === "indeterminate" &&
    steps[0].error_code === "github_session_no_ready",
    "historical step identity changed");
  requireValid(sessions.length === 1 && sessions[0].run_id === TERMINAL_RUN_ID &&
    sessions[0].step_id === "openlist_session" &&
    sessions[0].state === "terminated",
    "historical Session not physically marked terminated");
  requireValid(attempts.length === 1 && attempts[0].run_id === TERMINAL_RUN_ID &&
    attempts[0].step_id === "openlist_session" &&
    attempts[0].state === "cancelled" &&
    attempts[0].repository === "lirtual/session-actions" &&
    attempts[0].owner_run_id === TERMINAL_SESSION_GITHUB_RUN_ID &&
    attempts[0].owner_run_attempt === 1 &&
    attempts[0].candidate_run_id === TERMINAL_SESSION_GITHUB_RUN_ID &&
    attempts[0].candidate_run_attempt === 1,
    "historical GitHub Attempt not cancelled");
  requireValid(nativeCompleteProven(native),
    "native Cloudflare instance is not completed");
  requireValid(github?.id === TERMINAL_SESSION_GITHUB_RUN_ID &&
    github?.status === "completed" && github?.conclusion === "cancelled",
    "GitHub Session job not physically terminated");
  return TERMINAL_RUN_ID;
}

// Second owner-confirmed delivery: business result and upstream acknowledgement
// stay indeterminate/unknown. Only physical termination permits release.
export function verifySecondTerminalEvidence(d1,native,github) {
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(z=>z?.success===true&&Array.isArray(z.results)),
    "second Run D1 readback incomplete");
  const [runs,steps,sessions,attempts,invocations]=d1.map(z=>z.results);
  requireValid(runs.length===1&&runs[0].id===SECOND_TERMINAL_RUN_ID&&
    runs[0].outcome==="indeterminate"&&runs[0].start_state==="started"&&
    runs[0].error_code==="cloudflare_outcome_unknown",
    "second Run's unknown outcome changed");
  requireValid(steps.length===2&&steps[0].step_id==="notify"&&
    steps[0].status==="indeterminate"&&
    steps[0].error_code==="cloudflare_outcome_unknown"&&
    steps[1].step_id==="openlist"&&steps[1].status==="succeeded"&&
    steps[0].run_id===SECOND_TERMINAL_RUN_ID&&
    steps[1].run_id===SECOND_TERMINAL_RUN_ID,
    "second Run Step result changed");
  requireValid(sessions.length===1&&sessions[0].run_id===SECOND_TERMINAL_RUN_ID&&
    sessions[0].step_id==="openlist"&&sessions[0].state==="terminated",
    "second Run Session is not terminated");
  requireValid(attempts.length===1&&attempts[0].run_id===SECOND_TERMINAL_RUN_ID&&
    attempts[0].step_id==="openlist"&&attempts[0].state==="cancelled"&&
    attempts[0].repository==="lirtual/session-actions"&&
    attempts[0].owner_run_id===SECOND_SESSION_GITHUB_RUN_ID&&
    attempts[0].candidate_run_id===SECOND_SESSION_GITHUB_RUN_ID&&
    attempts[0].owner_run_attempt===1&&attempts[0].candidate_run_attempt===1,
    "second Run GitHub Attempt is not terminal");
  requireValid(invocations.length===1&&
    invocations[0].run_id===SECOND_TERMINAL_RUN_ID&&
    invocations[0].step_id==="notify"&&
    invocations[0].invocation_id==="2a7527ef-23d1-472d-b369-74c29a31c443"&&
    invocations[0].deployment_id==="a2faea6a-dc64-40cb-b6fd-91bf7f306f9b"&&
    invocations[0].binding_generation===1,
    "second Run immutable send receipt identity changed");
  requireValid(nativeCompleteProven(native),
    "second Cloudflare instance is not complete");
  requireValid(github?.id===SECOND_SESSION_GITHUB_RUN_ID&&
    github?.status==="completed"&&github?.conclusion==="cancelled",
    "second GitHub Job is not physically terminated");
  return SECOND_TERMINAL_RUN_ID;
}

// Third *exact* terminated and Owner-confirmed handset delivery. Only the
// physical release gate may exclude this Run; status remains indeterminate.
export function verifyThirdTerminalEvidence(d1,native,github) {
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(z=>z?.success===true&&Array.isArray(z.results)),
    "third Run D1 readback incomplete");
  const [runs,steps,sessions,attempts,invocations]=d1.map(z=>z.results);
  requireValid(runs.length===1&&runs[0].id===THIRD_TERMINAL_RUN_ID&&
    runs[0].outcome==="indeterminate"&&runs[0].start_state==="started"&&
    runs[0].error_code==="cloudflare_outcome_unknown",
    "third Run unknown outcome changed");
  requireValid(steps.length===3&&
    steps[0].run_id===THIRD_TERMINAL_RUN_ID&&
    steps[0].step_id==="notify"&&steps[0].status==="indeterminate"&&
    steps[0].error_code==="cloudflare_outcome_unknown"&&
    steps[1].run_id===THIRD_TERMINAL_RUN_ID&&
    steps[1].step_id==="openlist"&&steps[1].status==="succeeded"&&
    steps[2].run_id===THIRD_TERMINAL_RUN_ID&&
    steps[2].step_id==="receipt"&&steps[2].status==="skipped",
    "third Run Step result changed");
  requireValid(sessions.length===1&&
    sessions[0].run_id===THIRD_TERMINAL_RUN_ID&&
    sessions[0].step_id==="openlist"&&sessions[0].state==="terminated",
    "third Run Session not terminated");
  requireValid(attempts.length===1&&
    attempts[0].run_id===THIRD_TERMINAL_RUN_ID&&
    attempts[0].step_id==="openlist"&&attempts[0].state==="cancelled"&&
    attempts[0].repository==="lirtual/session-actions"&&
    attempts[0].owner_run_id===THIRD_SESSION_GITHUB_RUN_ID&&
    attempts[0].candidate_run_id===THIRD_SESSION_GITHUB_RUN_ID&&
    attempts[0].owner_run_attempt===1&&
    attempts[0].candidate_run_attempt===1,
    "third Run GitHub Attempt not terminated");
  requireValid(invocations.length===1&&
    invocations[0].run_id===THIRD_TERMINAL_RUN_ID&&
    invocations[0].step_id==="notify"&&
    invocations[0].invocation_id===THIRD_PROVIDER_INVOCATION_ID&&
    invocations[0].binding_generation===1&&
    invocations[0].deployment_id===THIRD_PROVIDER_DEPLOYMENT_ID,
    "third Run Action identity changed");
  requireValid(nativeCompleteProven(native),
    "third native Cloudflare instance not complete");
  requireValid(github?.id===THIRD_SESSION_GITHUB_RUN_ID&&
    github?.status==="completed"&&github?.conclusion==="cancelled",
    "third GitHub Run not physically cancelled");
  return THIRD_TERMINAL_RUN_ID;
}

// Fail-closed: only this immutable 2026-10-29 terminated Run is exempted.
export function verifyFourthTerminalEvidence(d1,native,github) {
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(z=>z?.success===true&&Array.isArray(z.results)),
    "fourth Run D1 readback incomplete");
  const [runs,steps,sessions,attempts,invocations]=d1.map(z=>z.results);
  requireValid(runs.length===1&&runs[0].id===FOURTH_TERMINAL_RUN_ID&&
    runs[0].outcome==="indeterminate"&&runs[0].start_state==="started"&&
    runs[0].error_code==="cloudflare_outcome_unknown",
    "fourth Run unknown outcome changed");
  requireValid(steps.length===3&&
    steps[0].run_id===FOURTH_TERMINAL_RUN_ID&&
    steps[0].step_id==="notify"&&steps[0].status==="indeterminate"&&
    steps[0].error_code==="cloudflare_outcome_unknown"&&
    steps[1].run_id===FOURTH_TERMINAL_RUN_ID&&
    steps[1].step_id==="openlist"&&steps[1].status==="succeeded"&&
    steps[2].run_id===FOURTH_TERMINAL_RUN_ID&&
    steps[2].step_id==="receipt"&&steps[2].status==="skipped",
    "fourth Run Step result changed");
  requireValid(sessions.length===1&&
    sessions[0].run_id===FOURTH_TERMINAL_RUN_ID&&
    sessions[0].step_id==="openlist"&&sessions[0].state==="terminated",
    "fourth Run Session not terminated");
  requireValid(attempts.length===1&&
    attempts[0].run_id===FOURTH_TERMINAL_RUN_ID&&
    attempts[0].step_id==="openlist"&&attempts[0].state==="cancelled"&&
    attempts[0].repository==="lirtual/session-actions"&&
    attempts[0].owner_run_id===FOURTH_SESSION_GITHUB_RUN_ID&&
    attempts[0].candidate_run_id===FOURTH_SESSION_GITHUB_RUN_ID&&
    attempts[0].owner_run_attempt===1&&
    attempts[0].candidate_run_attempt===1,
    "fourth Run GitHub Attempt not terminated");
  requireValid(invocations.length===1&&
    invocations[0].run_id===FOURTH_TERMINAL_RUN_ID&&
    invocations[0].step_id==="notify"&&
    invocations[0].invocation_id===FOURTH_PROVIDER_INVOCATION_ID&&
    invocations[0].binding_generation===1&&
    invocations[0].deployment_id===FOURTH_PROVIDER_DEPLOYMENT_ID,
    "fourth Run Action identity changed");
  requireValid(nativeCompleteProven(native),
    "fourth native Cloudflare instance not complete");
  requireValid(github?.id===FOURTH_SESSION_GITHUB_RUN_ID&&
    github?.status==="completed"&&github?.conclusion==="cancelled",
    "fourth GitHub Run not physically cancelled");
  return FOURTH_TERMINAL_RUN_ID;
}

// Fail-closed: only the fifth exact immutable 2026-10-29 terminated Run is exempted.
export function verifyFifthTerminalEvidence(d1,native,github) {
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(z=>z?.success===true&&Array.isArray(z.results)),
    "fifth Run D1 readback incomplete");
  const [runs,steps,sessions,attempts,invocations]=d1.map(z=>z.results);
  requireValid(runs.length===1&&runs[0].id===FIFTH_TERMINAL_RUN_ID&&
    runs[0].outcome==="indeterminate"&&runs[0].start_state==="started"&&
    runs[0].error_code==="cloudflare_outcome_unknown",
    "fifth Run unknown outcome changed");
  requireValid(steps.length===3&&
    steps[0].run_id===FIFTH_TERMINAL_RUN_ID&&
    steps[0].step_id==="notify"&&steps[0].status==="indeterminate"&&
    steps[0].error_code==="cloudflare_outcome_unknown"&&
    steps[1].run_id===FIFTH_TERMINAL_RUN_ID&&
    steps[1].step_id==="openlist"&&steps[1].status==="succeeded"&&
    steps[2].run_id===FIFTH_TERMINAL_RUN_ID&&
    steps[2].step_id==="receipt"&&steps[2].status==="skipped",
    "fifth Run Step result changed");
  requireValid(sessions.length===1&&
    sessions[0].run_id===FIFTH_TERMINAL_RUN_ID&&
    sessions[0].step_id==="openlist"&&sessions[0].state==="terminated",
    "fifth Run Session not terminated");
  requireValid(attempts.length===1&&
    attempts[0].run_id===FIFTH_TERMINAL_RUN_ID&&
    attempts[0].step_id==="openlist"&&attempts[0].state==="cancelled"&&
    attempts[0].repository==="lirtual/session-actions"&&
    attempts[0].owner_run_id===FIFTH_SESSION_GITHUB_RUN_ID&&
    attempts[0].candidate_run_id===FIFTH_SESSION_GITHUB_RUN_ID&&
    attempts[0].owner_run_attempt===1&&
    attempts[0].candidate_run_attempt===1,
    "fifth Run GitHub Attempt not terminated");
  requireValid(invocations.length===1&&
    invocations[0].run_id===FIFTH_TERMINAL_RUN_ID&&
    invocations[0].step_id==="notify"&&
    invocations[0].invocation_id===FIFTH_PROVIDER_INVOCATION_ID&&
    invocations[0].binding_generation===1&&
    invocations[0].deployment_id===FIFTH_PROVIDER_DEPLOYMENT_ID,
    "fifth Run Action identity changed");
  requireValid(nativeCompleteProven(native),
    "fifth native Cloudflare instance not complete");
  requireValid(github?.id===FIFTH_SESSION_GITHUB_RUN_ID&&
    github?.status==="completed"&&github?.conclusion==="cancelled",
    "fifth GitHub Run not physically cancelled");
  return FIFTH_TERMINAL_RUN_ID;
}

// Fail-closed: only the sixth exact immutable 2026-10-29 terminated Run is exempted.
export function verifySixthTerminalEvidence(d1,native,github) {
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(z=>z?.success===true&&Array.isArray(z.results)),
    "sixth Run D1 readback incomplete");
  const [runs,steps,sessions,attempts,invocations]=d1.map(z=>z.results);
  requireValid(runs.length===1&&runs[0].id===SIXTH_TERMINAL_RUN_ID&&
    runs[0].outcome==="indeterminate"&&runs[0].start_state==="started"&&
    runs[0].error_code==="cloudflare_outcome_unknown",
    "sixth Run unknown outcome changed");
  requireValid(steps.length===3&&
    steps[0].run_id===SIXTH_TERMINAL_RUN_ID&&
    steps[0].step_id==="notify"&&steps[0].status==="indeterminate"&&
    steps[0].error_code==="cloudflare_outcome_unknown"&&
    steps[1].run_id===SIXTH_TERMINAL_RUN_ID&&
    steps[1].step_id==="openlist"&&steps[1].status==="succeeded"&&
    steps[2].run_id===SIXTH_TERMINAL_RUN_ID&&
    steps[2].step_id==="receipt"&&steps[2].status==="skipped",
    "sixth Run Step result changed");
  requireValid(sessions.length===1&&
    sessions[0].run_id===SIXTH_TERMINAL_RUN_ID&&
    sessions[0].step_id==="openlist"&&sessions[0].state==="terminated",
    "sixth Run Session not terminated");
  requireValid(attempts.length===1&&
    attempts[0].run_id===SIXTH_TERMINAL_RUN_ID&&
    attempts[0].step_id==="openlist"&&attempts[0].state==="cancelled"&&
    attempts[0].repository==="lirtual/session-actions"&&
    attempts[0].owner_run_id===SIXTH_SESSION_GITHUB_RUN_ID&&
    attempts[0].candidate_run_id===SIXTH_SESSION_GITHUB_RUN_ID&&
    attempts[0].owner_run_attempt===1&&
    attempts[0].candidate_run_attempt===1,
    "sixth Run GitHub Attempt not terminated");
  requireValid(invocations.length===1&&
    invocations[0].run_id===SIXTH_TERMINAL_RUN_ID&&
    invocations[0].step_id==="notify"&&
    invocations[0].invocation_id===SIXTH_PROVIDER_INVOCATION_ID&&
    invocations[0].binding_generation===1&&
    invocations[0].deployment_id===SIXTH_PROVIDER_DEPLOYMENT_ID,
    "sixth Run Action identity changed");
  requireValid(nativeCompleteProven(native),
    "sixth native Cloudflare instance not complete");
  requireValid(github?.id===SIXTH_SESSION_GITHUB_RUN_ID&&
    github?.status==="completed"&&github?.conclusion==="cancelled",
    "sixth GitHub Run not physically cancelled");
  return SIXTH_TERMINAL_RUN_ID;
}

// Exact download notification failure: preserve the indeterminate Run and
// independently verify native completion, physical successful GitHub Task,
// and absence of any Weixin invocation. No generic Unknown exclusion.
export function verifySeventhTerminalEvidence(d1,native,github) {
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(z=>z?.success===true&&Array.isArray(z.results)),
    "seventh Run D1 readback incomplete");
  const [runs,steps,sessions,attempts,invocations]=d1.map(z=>z.results);
  requireValid(runs.length===1&&runs[0].id===SEVENTH_TERMINAL_RUN_ID&&
    runs[0].outcome==="indeterminate"&&runs[0].start_state==="started"&&
    runs[0].error_code==="cloudflare_dispatch_unconfirmed",
    "seventh Run result changed");
  requireValid(steps.length===3&&
    steps.every(s=>s.run_id===SEVENTH_TERMINAL_RUN_ID)&&
    steps[0].step_id==="download_task"&&steps[0].status==="succeeded"&&
    steps[1].step_id==="download_task_0_submit_download"&&steps[1].status==="succeeded"&&
    steps[2].step_id==="notify_weixin"&&steps[2].status==="indeterminate"&&
    steps[2].error_code==="cloudflare_dispatch_unconfirmed",
    "seventh Run step result changed");
  requireValid(sessions.length===0,"seventh Run unexpectedly owns a Session");
  requireValid(attempts.length===1&&
    attempts[0].run_id===SEVENTH_TERMINAL_RUN_ID&&
    attempts[0].step_id==="download_task_0_submit_download"&&
    attempts[0].state==="succeeded"&&
    attempts[0].repository==="lirtual/session-actions"&&
    attempts[0].owner_run_id===SEVENTH_TASK_GITHUB_RUN_ID&&
    attempts[0].candidate_run_id===SEVENTH_TASK_GITHUB_RUN_ID&&
    attempts[0].owner_run_attempt===1&&
    attempts[0].candidate_run_attempt===1,
    "seventh GitHub Task Attempt changed");
  requireValid(invocations.length===0,
    "seventh Weixin invocation cannot be excluded");
  requireValid(nativeCompleteProven(native),
    "seventh Cloudflare instance not completed");
  requireValid(github?.id===SEVENTH_TASK_GITHUB_RUN_ID&&
    github?.status==="completed"&&github?.conclusion==="success"&&
    github?.run_attempt===1&&github?.head_branch==="v0.1.42-rc.7",
    "seventh GitHub Task not physically successful");
  return SEVENTH_TERMINAL_RUN_ID;
}

/** Exact ended Saga Runs only; no generic indeterminate exemption. */
export function verifySagaTerminalEvidence(d1,native,github,kind) {
  const config=kind==='ninth'
    ?{id:NINTH_TERMINAL_RUN_ID,job:NINTH_SESSION_GITHUB_RUN_ID,error:'github_session_no_ready'}
    :kind==='tenth'
    ?{id:TENTH_TERMINAL_RUN_ID,job:TENTH_SESSION_GITHUB_RUN_ID,error:'github_dispatch_unknown'}
    :null;
  requireValid(config,'unsupported Saga terminal proof kind');
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(x=>x?.success===true&&Array.isArray(x.results)),
    'Saga D1 evidence incomplete');
  const [runs,steps,sessions,attempts,invocations]=d1.map(x=>x.results);
  requireValid(runs.length===1&&runs[0].id===config.id&&
    runs[0].outcome==='indeterminate'&&runs[0].start_state==='started'&&
    runs[0].error_code===config.error,
    'Saga business result changed');
  requireValid(steps.length===2&&steps.every(x=>x.run_id===config.id)&&
    steps[0].step_id==='hold'&&steps[0].status==='skipped'&&
    steps[1].step_id==='ubuntu'&&steps[1].status==='indeterminate'&&
    steps[1].error_code===config.error,'Saga Step state changed');
  requireValid(sessions.length===1&&sessions[0].run_id===config.id&&
    sessions[0].step_id==='ubuntu'&&sessions[0].state==='terminated',
    'Saga Session not terminated');
  requireValid(attempts.length===1&&attempts[0].run_id===config.id&&
    attempts[0].step_id==='ubuntu'&&attempts[0].state==='cancelled'&&
    attempts[0].repository==='lirtual/session-actions'&&
    attempts[0].owner_run_id===config.job&&attempts[0].candidate_run_id===config.job&&
    attempts[0].owner_run_attempt===1&&attempts[0].candidate_run_attempt===1,
    'Saga physical Attempt not cancelled');
  requireValid(invocations.length===0,'Saga Run unexpectedly sent a Cloudflare notification');
  requireValid(native?.status==='complete'&&!!native?.end,'Saga native instance incomplete');
  requireValid(github?.id===config.job&&github?.run_attempt===1&&
    github?.head_branch==='v0.1.42-rc.8'&&
    github?.status==='completed'&&github?.conclusion==='cancelled',
    'Saga GitHub job still running or wrong identity');
  return config.id;
}

/** One exact terminal Workflow with a reserved but Provider-unrecorded Action. */
export function verifyEleventhTerminalEvidence(d1,native,providerReceipts){
  requireValid(Array.isArray(d1)&&d1.length===5&&
    d1.every(x=>x?.success===true&&Array.isArray(x.results)),
    'eleventh Run D1 readback incomplete');
  const [runs,steps,sessions,attempts,invocations]=d1.map(x=>x.results);
  requireValid(runs.length===1&&runs[0].id===ELEVENTH_TERMINAL_RUN_ID&&
    runs[0].workflow_id===ELEVENTH_WORKFLOW_ID&&
    runs[0].version_id===ELEVENTH_VERSION_ID&&
    runs[0].start_state==='started'&&
    runs[0].outcome==='indeterminate'&&
    runs[0].error_code==='cloudflare_outcome_unknown',
    'eleventh Run identity or business result changed');
  requireValid(steps.length===1&&
    steps[0].run_id===ELEVENTH_TERMINAL_RUN_ID&&
    steps[0].step_id==='notify'&&steps[0].status==='indeterminate'&&
    steps[0].error_code==='cloudflare_outcome_unknown',
    'eleventh Run Step identity changed');
  requireValid(sessions.length===0&&attempts.length===0,
    'eleventh Run unexpectedly owns physical dispatch');
  requireValid(invocations.length===1&&
    invocations[0].run_id===ELEVENTH_TERMINAL_RUN_ID&&
    invocations[0].step_id==='notify'&&
    invocations[0].invocation_id===ELEVENTH_INVOCATION_ID&&
    invocations[0].source_attempt_id===ELEVENTH_INVOCATION_ID&&
    invocations[0].input_digest===ELEVENTH_INPUT_DIGEST&&
    invocations[0].contract_digest===ELEVENTH_CONTRACT_DIGEST&&
    invocations[0].binding_generation===1&&
    invocations[0].deployment_id===ELEVENTH_PROVIDER_VERSION,
    'eleventh Workflow Action reservation identity changed');
  requireValid(native?.status==='complete'&&!!native.end,
    'eleventh native instance did not finish');
  requireValid(Array.isArray(providerReceipts)&&providerReceipts.length===0,
    'eleventh Provider receipt missing proof failed');
  return ELEVENTH_TERMINAL_RUN_ID;
}

/** Physical completion permits only this historical release exclusion.
 * A claimed (nonterminal) D1 Attempt and indeterminate business Run are
 * deliberately retained, without manufacturing a Workflow success.
 */
export function verifyTwelfthTerminalEvidence(d1,native,github){
  requireValid(Array.isArray(d1)&&d1.length===7&&
    d1.every(x=>x?.success===true&&Array.isArray(x.results)),
    "twelfth Run production readback incomplete");
  const [runs,steps,sessions,attempts,receipts,invocations,cancellations]=
    d1.map(x=>x.results);
  requireValid(runs.length===1&&runs[0].id===TWELFTH_TERMINAL_RUN_ID&&
    runs[0].workflow_id===TWELFTH_WORKFLOW_ID&&
    runs[0].version_id===TWELFTH_VERSION_ID&&
    runs[0].start_state==="started"&&
    runs[0].outcome==="indeterminate"&&
    runs[0].error_code==="github_dispatch_unknown",
    "twelfth immutable business Run changed");
  requireValid(steps.length===1&&steps[0].run_id===TWELFTH_TERMINAL_RUN_ID&&
    steps[0].step_id==="verify"&&steps[0].status==="indeterminate"&&
    steps[0].error_code==="github_dispatch_unknown",
    "twelfth Step receipt changed");
  requireValid(sessions.length===0&&invocations.length===0&&
    cancellations.length===0,"twelfth Run has other live effects");
  requireValid(attempts.length===1&&
    attempts[0].run_id===TWELFTH_TERMINAL_RUN_ID&&
    attempts[0].step_id==="verify"&&
    attempts[0].attempt_id===TWELFTH_ATTEMPT_ID&&
    attempts[0].capability_id==="github.action"&&
    attempts[0].state==="claimed"&&
    attempts[0].repository==="lirtual/github-actions"&&
    String(attempts[0].repository_id)===String(TWELFTH_REPOSITORY_ID)&&
    attempts[0].workflow_ref==="lirtual/github-actions/.github/workflows/verify-action.yml@"+TWELFTH_TAG&&
    attempts[0].ref===TWELFTH_TAG&&
    attempts[0].candidate_run_id===TWELFTH_GITHUB_RUN_ID&&
    attempts[0].candidate_run_attempt===1&&
    attempts[0].owner_run_id===TWELFTH_GITHUB_RUN_ID&&
    attempts[0].owner_run_attempt===1,
    "twelfth approved Attempt identity changed");
  requireValid(receipts.length===1&&
    receipts[0].run_id===TWELFTH_TERMINAL_RUN_ID&&
    receipts[0].step_id==="verify"&&
    receipts[0].outcome==="succeeded"&&
    receipts[0].notification_delivered===1,
    "twelfth signed result receipt missing or changed");
  // Cloudflare REST GET is already scoped to the exact instance ID; unlike
  // Wrangler CLI, its result omits `id`. Reject a mismatched ID if present.
  requireValid((native?.id===undefined||native?.id===TWELFTH_TERMINAL_RUN_ID)&&
    native?.status==="complete"&&native?.success===true&&
    native?.error===null&&!!native?.end&&
    native?.step_count===3&&native?.steps?.length===3&&
    native.steps[0].name==="github-action-dispatch-verify-1"&&
    native.steps[0].success===true&&
    native.steps[1].name==="github-action-check-verify-0-1"&&
    native.steps[1].success===true&&native.steps[1].output==="held"&&
    native.steps[2].name==="github-action-sleep-verify-0-1"&&
    native.steps[2].finished===true,
    "twelfth native instance/checkpoint history changed");
  let dispatch;
  try{dispatch=JSON.parse(native.steps[0].output);}catch{}
  requireValid(dispatch?.attemptId===TWELFTH_ATTEMPT_ID&&
    dispatch?.status==="confirmed"&&
    dispatch?.runId===TWELFTH_GITHUB_RUN_ID&&
    dispatch?.runAttempt===1,
    "twelfth native dispatch ACK identity changed");
  requireValid(github?.id===TWELFTH_GITHUB_RUN_ID&&
    github?.repository?.id===TWELFTH_REPOSITORY_ID&&
    github?.workflow_id===TWELFTH_WORKFLOW_GITHUB_ID&&
    github?.event==="workflow_dispatch"&&github?.run_attempt===1&&
    github?.head_branch==="v0.1.42-rc.10"&&
    github?.head_sha===TWELFTH_SHA&&
    github?.status==="completed"&&github?.conclusion==="success",
    "twelfth GitHub physical Task or source not proven terminal");
  return TWELFTH_TERMINAL_RUN_ID;
}

async function main() {
  const kind=process.env.TERMINAL_PROOF_KIND;
  requireValid(process.env.SELECTED_WORKER === "workflow-mcp-worker",
    "only the Workflow release may request this exception");
  requireValid(process.env.CLOUDFLARE_ACCOUNT_ID &&
    /^[a-f\d]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID) &&
    process.env.CLOUDFLARE_API_TOKEN &&
    (kind==="eleventh"||process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN),
    "required read-only verification credentials missing");
  requireValid(kind===undefined||kind==="second"||kind==="third"||kind==="fourth"||kind==="fifth"||kind==="sixth"||kind==="seventh"||kind==="ninth"||kind==="tenth"||kind==="eleventh"||kind==="twelfth",
    "unknown terminal proof kind");
  const second=kind==="second";
  const third=kind==="third";
  const fourth=kind==="fourth";
  const fifth=kind==="fifth";
  const sixth=kind==="sixth";
  const seventh=kind==="seventh";
  const ninth=kind==="ninth";
  const tenth=kind==="tenth";
  const eleventh=kind==="eleventh";
  const twelfth=kind==="twelfth";
  const d1 = JSON.parse(await readFile("/dev/stdin","utf8"));
  const get = async (url, token) => {
    const response = await fetch(url,{
      headers:{Authorization:"Bearer "+token,Accept:"application/json"},
      signal:AbortSignal.timeout(15000)
    });
    requireValid(response.ok,"independent native/GitHub state unavailable (HTTP "+response.status+")");
    return response.json();
  };
  const cfResponse = await fetch("https://api.cloudflare.com/client/v4/accounts/"+
    process.env.CLOUDFLARE_ACCOUNT_ID+"/workflows/"+WORKFLOW+"/instances/"+
    (twelfth?TWELFTH_TERMINAL_RUN_ID:eleventh?ELEVENTH_TERMINAL_RUN_ID:ninth?NINTH_TERMINAL_RUN_ID:tenth?TENTH_TERMINAL_RUN_ID:seventh?SEVENTH_TERMINAL_RUN_ID:sixth?SIXTH_TERMINAL_RUN_ID:fifth?FIFTH_TERMINAL_RUN_ID:fourth?FOURTH_TERMINAL_RUN_ID:third?THIRD_TERMINAL_RUN_ID:second?SECOND_TERMINAL_RUN_ID:TERMINAL_RUN_ID),
    {headers:{Authorization:"Bearer "+process.env.CLOUDFLARE_API_TOKEN,
      Accept:"application/json"},signal:AbortSignal.timeout(15000)});
  let native;
  if (cfResponse.ok) {
    const cf = await cfResponse.json();
    requireValid(cf?.success === true && cf?.result,
      "native Cloudflare instance readback unavailable");
    native = cf.result;
  } else if (cfResponse.status === 404) {
    requireValid(!seventh&&!ninth&&!tenth&&!eleventh&&!twelfth,"recent native instance must be independently live-proven");
    // A 404 alone is never proof. Pin prior successful checks for all six
    // precise instances, and still check today's D1/GitHub terminal state.
    requireValid(process.env.GITHUB_TOKEN,
      "prior native proof GitHub read token missing");
    const base = "https://api.github.com/repos/lirtual/mcp-workers/actions/runs/"+PRIOR_RELEASE_ID;
    native = verifyPriorNativeProof(await get(base,process.env.GITHUB_TOKEN),
      await get(base+"/jobs?per_page=100",process.env.GITHUB_TOKEN));
    console.log("Historical native instance expired; exact prior release proof verified");
  } else {
    requireValid(false,"independent native state unavailable (HTTP "+cfResponse.status+")");
  }
  if(eleventh){
    // A Provider receipt would mean a send may have been attempted.
    // Never exempt that case or replay an unknown outcome.
    const response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+
      process.env.CLOUDFLARE_ACCOUNT_ID+"/d1/database/"+ELEVENTH_WEIXIN_DB+"/query",{
        method:"POST",
        headers:{Authorization:"Bearer "+process.env.CLOUDFLARE_API_TOKEN,
          Accept:"application/json","Content-Type":"application/json"},
        body:JSON.stringify({sql:"SELECT generation,request_id,status FROM weixin_send_receipts WHERE request_id='"+
          ELEVENTH_INVOCATION_ID+"'"}),
        signal:AbortSignal.timeout(15000)
      });
    requireValid(response.ok,"eleventh Provider D1 query unavailable");
    const proof=await response.json();
    requireValid(proof?.success===true&&Array.isArray(proof.result)&&
      proof.result.length===1&&proof.result[0]?.success===true&&
      Array.isArray(proof.result[0]?.results),
      "eleventh Provider D1 readback incomplete");
    // Independent native Cloudflare completion plus both D1s required.
    verifyEleventhTerminalEvidence(d1,native,proof.result[0].results);
    requireValid(process.env.GITHUB_OUTPUT,"GitHub output unavailable");
    await appendFile(process.env.GITHUB_OUTPUT,
      "eleventh_terminal_run_id="+ELEVENTH_TERMINAL_RUN_ID+"\n");
    console.log("Verified exact terminal generic notification Run; unknown preserved");
    return;
  }
  if(twelfth){
    const github=await get("https://api.github.com/repos/lirtual/github-actions/actions/runs/"+
      TWELFTH_GITHUB_RUN_ID,process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
    verifyTwelfthTerminalEvidence(d1,native,github);
    requireValid(process.env.GITHUB_OUTPUT,"GitHub output unavailable");
    await appendFile(process.env.GITHUB_OUTPUT,
      "twelfth_terminal_run_id="+TWELFTH_TERMINAL_RUN_ID+"\n");
    console.log("Verified exact historical GitHub Artifact Task physical terminal; business unknown preserved");
    return;
  }
  const github = await get(HISTORICAL_GITHUB_RUNS_API+
    (ninth?NINTH_SESSION_GITHUB_RUN_ID:tenth?TENTH_SESSION_GITHUB_RUN_ID:seventh?SEVENTH_TASK_GITHUB_RUN_ID:sixth?SIXTH_SESSION_GITHUB_RUN_ID:fifth?FIFTH_SESSION_GITHUB_RUN_ID:fourth?FOURTH_SESSION_GITHUB_RUN_ID:third?THIRD_SESSION_GITHUB_RUN_ID:second?SECOND_SESSION_GITHUB_RUN_ID:TERMINAL_SESSION_GITHUB_RUN_ID),
    process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
  if(ninth||tenth)verifySagaTerminalEvidence(d1,native,github,kind);
  else if(seventh)verifySeventhTerminalEvidence(d1,native,github);
  else if(sixth)verifySixthTerminalEvidence(d1,native,github);
  else if(fifth)verifyFifthTerminalEvidence(d1,native,github);
  else if(fourth)verifyFourthTerminalEvidence(d1,native,github);
  else if(third)verifyThirdTerminalEvidence(d1,native,github);
  else if(second)verifySecondTerminalEvidence(d1,native,github);
  else verifyTerminalRunEvidence(d1,native,github);
  requireValid(process.env.GITHUB_OUTPUT,"GitHub output unavailable");
  await appendFile(process.env.GITHUB_OUTPUT,
    (ninth?"ninth_terminal_run_id="+NINTH_TERMINAL_RUN_ID:
      tenth?"tenth_terminal_run_id="+TENTH_TERMINAL_RUN_ID:
      seventh?"seventh_terminal_run_id="+SEVENTH_TERMINAL_RUN_ID:
      sixth?"sixth_terminal_run_id="+SIXTH_TERMINAL_RUN_ID:
      fifth?"fifth_terminal_run_id="+FIFTH_TERMINAL_RUN_ID:
      fourth?"fourth_terminal_run_id="+FOURTH_TERMINAL_RUN_ID:
      third?"third_terminal_run_id="+THIRD_TERMINAL_RUN_ID:
      second?"second_terminal_run_id="+SECOND_TERMINAL_RUN_ID:
      "terminal_run_id="+TERMINAL_RUN_ID)+"\n");
  console.log("Verified one exact terminated historical Run; business outcome preserved");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error(e.message);
    process.exitCode=1;
  });
}
