import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Spec #392: narrowly scoped historical evidence, never a general opt-out.
export const TERMINAL_RUN_ID = "47739981-0534-4966-8034-1e79c1d17481";
export const TERMINAL_SESSION_GITHUB_RUN_ID = 40324650847;
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

async function main() {
  requireValid(process.env.SELECTED_WORKER === "workflow-mcp-worker",
    "only the Workflow release may request this exception");
  requireValid(process.env.CLOUDFLARE_ACCOUNT_ID &&
    /^[a-f\d]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID) &&
    process.env.CLOUDFLARE_API_TOKEN &&
    process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN,
    "required read-only verification credentials missing");
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
    TERMINAL_RUN_ID,process.env.CLOUDFLARE_API_TOKEN);
  requireValid(cf?.success === true && cf?.result,
    "native Cloudflare instance readback unavailable");
  const github = await get("https://api.github.com/repos/lirtual/session-actions/actions/runs/"+
    TERMINAL_SESSION_GITHUB_RUN_ID,process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN);
  verifyTerminalRunEvidence(d1, cf.result, github);
  requireValid(process.env.GITHUB_OUTPUT,"GitHub output unavailable");
  await appendFile(process.env.GITHUB_OUTPUT,
    "terminal_run_id="+TERMINAL_RUN_ID+"\n");
  console.log("Verified one historical terminated Run for release only; business result preserved");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error(e.message);
    process.exitCode=1;
  });
}
