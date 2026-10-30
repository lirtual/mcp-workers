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

const WORKFLOW = "workflow-mcp-orchestrator";

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

async function main() {
  requireValid(process.env.SELECTED_WORKER === "workflow-mcp-worker",
    "only the Workflow release may request this exception");
  requireValid(process.env.CLOUDFLARE_ACCOUNT_ID &&
    /^[a-f\d]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID) &&
    process.env.CLOUDFLARE_API_TOKEN &&
    process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN,
    "required read-only verification credentials missing");
  const kind=process.env.TERMINAL_PROOF_KIND;
  requireValid(kind===undefined||kind==="second"||kind==="third"||kind==="fourth"||kind==="fifth"||kind==="sixth"||kind==="seventh",
    "unknown terminal proof kind");
  const second=kind==="second";
  const third=kind==="third";
  const fourth=kind==="fourth";
  const fifth=kind==="fifth";
  const sixth=kind==="sixth";
  const seventh=kind==="seventh";
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
    (seventh?SEVENTH_TERMINAL_RUN_ID:sixth?SIXTH_TERMINAL_RUN_ID:fifth?FIFTH_TERMINAL_RUN_ID:fourth?FOURTH_TERMINAL_RUN_ID:third?THIRD_TERMINAL_RUN_ID:second?SECOND_TERMINAL_RUN_ID:TERMINAL_RUN_ID),
    {headers:{Authorization:"Bearer "+process.env.CLOUDFLARE_API_TOKEN,
      Accept:"application/json"},signal:AbortSignal.timeout(15000)});
  let native;
  if (cfResponse.ok) {
    const cf = await cfResponse.json();
    requireValid(cf?.success === true && cf?.result,
      "native Cloudflare instance readback unavailable");
    native = cf.result;
  } else if (cfResponse.status === 404) {
    requireValid(!seventh,"seventh native instance must be independently live-proven");
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
  const github = await get("https://api.github.com/repos/lirtual/session-actions/actions/runs/"+
    (seventh?SEVENTH_TASK_GITHUB_RUN_ID:sixth?SIXTH_SESSION_GITHUB_RUN_ID:fifth?FIFTH_SESSION_GITHUB_RUN_ID:fourth?FOURTH_SESSION_GITHUB_RUN_ID:third?THIRD_SESSION_GITHUB_RUN_ID:second?SECOND_SESSION_GITHUB_RUN_ID:TERMINAL_SESSION_GITHUB_RUN_ID),
    process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
  if(seventh)verifySeventhTerminalEvidence(d1,native,github);
  else if(sixth)verifySixthTerminalEvidence(d1,native,github);
  else if(fifth)verifyFifthTerminalEvidence(d1,native,github);
  else if(fourth)verifyFourthTerminalEvidence(d1,native,github);
  else if(third)verifyThirdTerminalEvidence(d1,native,github);
  else if(second)verifySecondTerminalEvidence(d1,native,github);
  else verifyTerminalRunEvidence(d1,native,github);
  requireValid(process.env.GITHUB_OUTPUT,"GitHub output unavailable");
  await appendFile(process.env.GITHUB_OUTPUT,
    (seventh?"seventh_terminal_run_id="+SEVENTH_TERMINAL_RUN_ID:
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
