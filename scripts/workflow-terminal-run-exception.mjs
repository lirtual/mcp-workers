import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Spec #392: narrowly scoped historical evidence, never a general opt-out.
export const TERMINAL_RUN_ID = "47739981-0534-4966-8034-1e79c1d17481";
export const TERMINAL_SESSION_GITHUB_RUN_ID = 40324650847;
export const SECOND_TERMINAL_RUN_ID = "8e0a94a7-136f-41fd-b839-211c9a60ad49";
export const SECOND_SESSION_GITHUB_RUN_ID = 40654886218;

const WORKFLOW = "workflow-mcp-orchestrator";

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
  requireValid(native?.status === "complete" && native?.end,
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
  requireValid(native?.status==="complete"&&native?.end,
    "second Cloudflare instance is not complete");
  requireValid(github?.id===SECOND_SESSION_GITHUB_RUN_ID&&
    github?.status==="completed"&&github?.conclusion==="cancelled",
    "second GitHub Job is not physically terminated");
  return SECOND_TERMINAL_RUN_ID;
}

async function main() {
  requireValid(process.env.SELECTED_WORKER === "workflow-mcp-worker",
    "only the Workflow release may request this exception");
  requireValid(process.env.CLOUDFLARE_ACCOUNT_ID &&
    /^[a-f\d]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID) &&
    process.env.CLOUDFLARE_API_TOKEN &&
    process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN,
    "required read-only verification credentials missing");
  const second=process.env.TERMINAL_PROOF_KIND==="second";
  const d1 = JSON.parse(await readFile("/dev/stdin","utf8"));
  const get = async (url, token) => {
    const response = await fetch(url,{
      headers:{Authorization:"Bearer "+token,Accept:"application/json"},
      signal:AbortSignal.timeout(15000)
    });
    requireValid(response.ok,"independent native/GitHub state unavailable (HTTP "+response.status+")");
    return response.json();
  };
  const cf = await get("https://api.cloudflare.com/client/v4/accounts/"+
    process.env.CLOUDFLARE_ACCOUNT_ID+"/workflows/"+WORKFLOW+"/instances/"+
    (second?SECOND_TERMINAL_RUN_ID:TERMINAL_RUN_ID),process.env.CLOUDFLARE_API_TOKEN);
  requireValid(cf?.success === true && cf?.result,
    "native Cloudflare instance readback unavailable");
  const github = await get("https://api.github.com/repos/lirtual/session-actions/actions/runs/"+
    (second?SECOND_SESSION_GITHUB_RUN_ID:TERMINAL_SESSION_GITHUB_RUN_ID),
    process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
  if(second)verifySecondTerminalEvidence(d1,cf.result,github);
  else verifyTerminalRunEvidence(d1,cf.result,github);
  requireValid(process.env.GITHUB_OUTPUT,"GitHub output unavailable");
  await appendFile(process.env.GITHUB_OUTPUT,
    (second?"second_terminal_run_id="+SECOND_TERMINAL_RUN_ID:
      "terminal_run_id="+TERMINAL_RUN_ID)+"\n");
  console.log("Verified one exact terminated historical Run; business outcome preserved");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error(e.message);
    process.exitCode=1;
  });
}
