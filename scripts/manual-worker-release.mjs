// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKERS = new Set(["raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker", "ssh-mcp-worker", "remote-control-mcp-worker", "github-actions-mcp-worker", "workflow-mcp-worker", "email-mcp-worker"]);
const REQUIRED_SECRETS = {
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "IMA_API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "email-mcp-worker": ["MCP_ACCESS_TOKEN", "MAIL_ENCRYPTION_KEY"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "ENCRYPTION_KEY"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "ACTIONS_GITHUB_DISPATCH_TOKENS"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN", "SESSION_RUNTIME_DATA_KEY"],
};
const WORKER_ENTRIES = {
  "raindrop-mcp-worker": "src/worker.ts",
  "ima-mcp-worker": "src/index.ts",
  "database-mcp-worker": "src/index.ts",
  "email-mcp-worker": "src/index.ts",
  "ssh-mcp-worker": "src/index.ts",
  "remote-control-mcp-worker": "src/worker.ts",
  "github-actions-mcp-worker": "src/index.ts",
  "workflow-mcp-worker": "src/index.ts",
};

function invariant(value, message) {
  if (!value) throw new Error(message);
}

export function verifyBindings(worker, settings, secrets, options = {}) {
  invariant(WORKERS.has(worker), "Release target not enabled");
  const bindings = settings?.bindings;
  invariant(Array.isArray(bindings), "Cloudflare bindings unavailable");
  const find = (name, type) => bindings.find((x) => x.name === name && x.type === type);
  const secretNames = new Set(Array.isArray(secrets) ? secrets.map((x) => x.name) : []);
  for (const name of REQUIRED_SECRETS[worker]) {
    // On preflight a missing runtime Secret can be repaired from GitHub.
    // The unconditional Secrets staging step fails closed before deployment.
    // Readback must still prove that every required Secret binding exists.
    if (options.mode !== "preflight") {
      invariant(secretNames.has(name), "Required runtime Secret missing: " + name);
      invariant(!!find(name, "secret_text"), "Required Secret binding missing: " + name);
    }
  }
  if (worker === "ssh-mcp-worker") {
    invariant(settings.observability?.enabled === true &&
      settings.observability?.logs?.invocation_logs === true,
      "SSH observability and invocation logs must remain enabled");
    const catalog = find("EDGE_SSH_DB", "d1");
    invariant(options.mode === "preflight" || (catalog?.id || catalog?.database_id) === "bd5cfdc5-3db0-4af7-8e95-cbf3d65cfa94",
      "SSH shared EdgeSSH D1 binding missing or changed");
    invariant(find("SSH_OPERATIONS", "durable_object_namespace")?.class_name === "SshOperationsDO",
      "SSH Durable Object binding missing");
    if (options.mode !== "preflight") {
      invariant(!bindings.some((x) => ["EDGE_SSH_BROKER", "SSH_BROKER_TOKEN", "MCP_BROKER_FULL_ACCESS"].includes(x.name)),
        "SSH legacy broker binding or token remains");
    }
  } else {
    const logs = ["remote-control-mcp-worker", "email-mcp-worker"].includes(worker) ? false : true;
    invariant(settings.observability?.enabled === true &&
      settings.observability?.logs?.invocation_logs === logs,
      "Unexpected Invocation Logs configuration");
  }
  if (worker === "workflow-mcp-worker") {
    const d1 = find("DB", "d1");
    const liveD1=d1?.id || d1?.database_id;
    invariant(liveD1==="a4a477cd-6339-478c-ab7c-f7d87bb0d772",
      "Workflow production D1 runtime binding drift");
    const flow = find("WORKFLOW", "workflow");
    if(options.mode==="readback") {
      invariant(flow?.workflow_name==="workflow-mcp-orchestrator" &&
        flow?.class_name==="WorkflowOrchestrator", "Workflow native Workflow binding drift");
    }
    if (options.mode === "readback") {
      invariant(find("MCP_PORTAL_ENDPOINT", "plain_text")?.text ===
        "https://mcp.lirtual.dpdns.org/mcp", "Pinned Workflow MCP Portal drift");
      invariant(!bindings.some(x => ["GITHUB_EXECUTOR_REPOSITORY",
        "GITHUB_EXECUTOR_REPOSITORY_ID","GITHUB_EXECUTOR_REF",
        "GITHUB_EXECUTOR_AUDIENCE","GITHUB_TEST_WORKER_NAME",
        "GITHUB_TEST_DEDICATED_EXECUTOR"].includes(x.name)),
        "Retired fixed GitHub executor variables must be removed");
      invariant(find("GITHUB_ACTION_OIDC_AUDIENCE","plain_text")?.text ===
        "workflow-github-action:production", "Workflow Action OIDC audience drift");
      for (const name of ["MCP_PORTAL_CLIENT_SECRET","WORKFLOW_GITHUB_DISPATCH_TOKEN"]) {
        invariant(secretNames.has(name) && !!find(name,"secret_text"),
          "Workflow runtime credential binding missing: " + name);
      }
      invariant(bindings.filter(x => x.name === "MCP_PORTAL_CLIENT_ID").length === 1 &&
        typeof find("MCP_PORTAL_CLIENT_ID", "plain_text")?.text === "string" &&
        find("MCP_PORTAL_CLIENT_ID", "plain_text").text.trim().length > 0 &&
        !secretNames.has("MCP_PORTAL_CLIENT_ID"),
        "Workflow Portal Client ID must be exactly one plaintext Variable");
      invariant(!bindings.some(x => ["MCP_CALL_ENABLED","GITHUB_EXECUTION_ENABLED",
        "MCP_DIRECT_TARGETS_ENABLED"].includes(x.name)),
        "Obsolete stage flag present after release");
    }
  }
  if (worker === "github-actions-mcp-worker" && options.mode === "readback") {
    // GitHub PATs alone authorize repositories. No repository lists should
    // survive from the old Worker configuration.
    invariant(!find("GITHUB_REPOS", "plain_text") &&
      !find("GITHUB_REPOS_SECONDARY", "plain_text"),
      "Legacy GitHub Actions repository allowlists must be removed");
    invariant(secretNames.has("ACTIONS_GITHUB_DISPATCH_TOKENS") && !!find("ACTIONS_GITHUB_DISPATCH_TOKENS", "secret_text"),
      "GitHub Actions ACTIONS_GITHUB_DISPATCH_TOKENS Secret binding missing");
  }
  if (worker === "ima-mcp-worker") {
    // During preflight, existing CLIENT_ID Variable may still be present.
    // The selected GitHub Environment stages IMA_CLIENT_ID on publish.
    // Readback MUST confirm the new name and type, with no old binding.
    if (options.mode !== "preflight") {
      const clientId = find("IMA_CLIENT_ID", "plain_text");
      invariant(bindings.filter(x => x.name === "IMA_CLIENT_ID").length === 1 &&
        !bindings.some(x => x.name === "CLIENT_ID") && !secretNames.has("CLIENT_ID"),
        "IMA legacy CLIENT_ID binding must be absent after release");
      invariant(typeof clientId?.text === "string" && clientId.text.trim().length > 0,
        "IMA_CLIENT_ID must be a nonempty plain-text Variable after release");
      invariant(!find("IMA_CLIENT_ID", "secret_text") && !secretNames.has("IMA_CLIENT_ID"),
        "IMA legacy IMA_CLIENT_ID Secret still present after release");
    }
    const durable = find("IMA_IMAGE_REFRESH_SHARD", "durable_object_namespace");
    invariant(durable?.class_name === "ImaImageRefreshShard", "IMA Durable Object missing or class drift");
    invariant(settings.observability?.traces?.enabled === true, "IMA tracing drift");
    invariant(!bindings.some((x) => x.name === "R2_BUCKET"), "Legacy IMA R2 Worker binding remains");
  }
  if (worker === "email-mcp-worker") {
    const d1 = find("DB", "d1");
    invariant((d1?.id || d1?.database_id) === "1fa50616-effb-458e-b798-b1ca1a0da24f",
      "Email production D1 binding drift");
    const expected = { ACCESS_TEAM_DOMAIN: "lirtualzero.cloudflareaccess.com",
      ACCESS_AUD: "cea1cd806f0f68552c5bed2acd917afcaf8e18a7eda3fb19f5c9704c3a00cd1b",
      OWNER_EMAIL: "lirtual@outlook.com" };
    for (const [name, value] of Object.entries(expected)) {
      invariant(bindings.filter(b => b.name === name).length === 1 &&
        find(name, "plain_text")?.text === value && !secretNames.has(name),
        "Email production Access Variable drift: " + name);
    }
    invariant(!bindings.some(b => b.type === "plain_text" && !(b.name in expected)),
      "Email has unexpected plaintext bindings");
  }
  if (worker === "database-mcp-worker") {
    const limiter = find("RATE_LIMITER", "ratelimit");
    invariant(limiter && String(limiter.namespace_id) === "1001" &&
      Number(limiter.simple?.limit) === 120 && Number(limiter.simple?.period) === 60,
      "Database RATE_LIMITER binding/policy drift");
  }
  if (worker === "remote-control-mcp-worker") {
    const coordinator = find("DEVICE_COORDINATOR", "durable_object_namespace");
    const previous = find("V2_OWNER", "durable_object_namespace");
    // Preflight may inspect the currently deployed Preview-backed v2 or legacy VPC
    // version. Identify the previous namespace from THIS Worker, not from a
    // separate Preview Worker that may already have been deleted.
    const isPreflightPrevious = options.mode === "preflight" && !coordinator &&
      ((previous?.class_name === "V2OwnerCoordinator" &&
        previous?.script_name === "remote-control-v2-preview" &&
        typeof previous.namespace_id === "string") ||
        !!find("REMOTE_CONTROL_DEVICE", "vpc_service"));
    if (!isPreflightPrevious) {
      invariant(coordinator?.class_name === "DeviceCoordinator" &&
        typeof coordinator.namespace_id === "string" &&
        !coordinator.script_name &&
        coordinator.namespace_id !== options.previousNamespaceId,
        "Production must have its own DeviceCoordinator namespace distinct from Preview");
      invariant(!previous && !find("REMOTE_CONTROL_V2_ONLY", "plain_text") &&
        !find("REMOTE_CONTROL_V2_PREVIEW_ONLY", "plain_text"),
        "Production must not retain Preview binding or v1/v2 runtime switches");
      invariant(!bindings.some(x => x.type === "vpc_service" ||
        x.name === "REMOTE_CONTROL_DEVICE"), "Production VPC binding must be absent");
    }
    // Readback must prove Wrangler deployed the origin derived from the
    // reviewed Custom Domain, not a stale or attacker-controlled Host value.
    if (options.mode === "readback") {
      const route = options.sourceConfig?.routes;
      invariant(Array.isArray(route) && route.length === 1 &&
        route[0]?.custom_domain === true &&
        find("REMOTE_CONTROL_INSTALL_ORIGIN", "plain_text")?.text ===
          "https://" + route[0].pattern,
        "Remote Control installer origin binding differs from Custom Domain");
      invariant(!bindings.some(x => x.name?.startsWith("BROWSER_APPROVAL_")),
        "Retired Remote Control approval bindings must be removed");
    }
  }
  const allowed = new Set(worker === "workflow-mcp-worker"
    ? (options.mode === "preflight" ? ["DB", "WORKFLOW", "WORKFLOW_LEGACY"] : ["DB", "WORKFLOW"]) :
    worker === "email-mcp-worker" ? ["DB"] :
    worker === "ima-mcp-worker"
    ? ["IMA_IMAGE_REFRESH_SHARD"]
    : worker === "database-mcp-worker" ? ["RATE_LIMITER"]
      : worker === "ssh-mcp-worker" ? (options.mode === "preflight" ? ["EDGE_SSH_BROKER", "EDGE_SSH_DB", "SSH_OPERATIONS"] : ["EDGE_SSH_DB", "SSH_OPERATIONS"])
      : worker === "remote-control-mcp-worker"
        ? (options.mode === "preflight"
          ? ["DEVICE_COORDINATOR", "V2_OWNER", "REMOTE_CONTROL_DEVICE"]
          : ["DEVICE_COORDINATOR"]) : []);
  for (const item of bindings) {
    if (!["plain_text", "secret_text"].includes(item.type)) {
      // Source manifest controls the new bindings; a production preflight may
      // still observe bindings that this release is about to remove.
      // Readback strictly verifies that no extra resource binding survives.
      if (!(worker === "workflow-mcp-worker" && options.mode === "preflight" && item.type === "service"))
        invariant(allowed.has(item.name), "Unexpected production resource binding: " + item.name);
    }
  }
  return true;
}

// Fail closed before any production Worker deployment.
export function verifyWorkflowReleaseConfig(conf) {
  invariant(conf?.name === "workflow-mcp-worker" && conf.main === "src/index.ts",
    "Workflow source identity drift");
  invariant(conf.keep_vars === false && conf.workers_dev === false &&
    conf.preview_urls === false && conf.routes?.length === 1 &&
    conf.routes[0]?.pattern === "workflow.lirtual.dpdns.org" &&
    conf.routes[0]?.custom_domain === true, "Workflow reviewed public route drift");
  invariant(conf.observability?.enabled === true &&
    conf.observability?.logs?.invocation_logs === true, "Workflow Invocation Logs drift");
  invariant(conf.d1_databases?.length === 1 &&
    conf.d1_databases[0]?.binding === "DB" &&
    conf.d1_databases[0]?.database_name === "workflow-mcp-db" &&
    conf.d1_databases[0]?.database_id === "a4a477cd-6339-478c-ab7c-f7d87bb0d772" &&
    conf.d1_databases[0]?.migrations_dir === "migrations", "Workflow approved production D1 drift");
  invariant(conf.workflows?.length === 1 &&
    conf.workflows[0]?.binding === "WORKFLOW" &&
    conf.workflows[0]?.name === "workflow-mcp-orchestrator" &&
    conf.workflows[0]?.class_name === "WorkflowOrchestrator",
    "Workflow binding drift");
  invariant(!conf.services?.length, "Workflow must not retain Service Bindings");
  invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN", "MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN", "SESSION_RUNTIME_DATA_KEY"]),
    "Workflow Portal Secret declaration drift");
  invariant(!conf.vars || Object.keys(conf.vars).length===0,
    "Workflow MCP source cannot declare runtime feature flags");
  invariant(!(conf.compatibility_flags || []).includes("global_fetch_strictly_public"),
    "Workflow must never enable or import MCP dynamic-target behavior");
  return true;
}

export function verifyWorkflowD1Readiness(response, bootstrap, requireCompleteSchema = false) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow remote D1 readback unavailable");
  const row = response[0].results[0];
  // Production already has migration 0005. A failed two-file deployment may
  // leave 0006 committed; permit a controlled resume but never publish the
  // upgraded Worker until both new migrations and tables are confirmed.
  const base = [1,2,3,4,5].every(n => row?.["migration_v" + n] === 1) &&
    row?.attempt_table === 1 && row?.receipt_table === 1 &&
    row?.native_column === 1;
  const before = row?.migration_count === 5 &&
    row?.migration_v6 === 0 && row?.migration_v7 === 0 &&
    row?.session_table === 0 && row?.cancellation_table === 0;
  const partial = row?.migration_count === 6 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 0 &&
    row?.session_table === 0 && row?.cancellation_table === 0;
  const current = row?.migration_count === 7 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 0 && row?.locator_column === 0 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  const previous = row?.migration_count === 8 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 0 &&
    row?.locator_column === 1 && row?.fixed_column === 0 && row?.fixed_index === 0 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  const oldComplete = row?.migration_count === 9 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 1 &&
    row?.locator_column === 1 && row?.fixed_column === 1 && row?.fixed_index === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  // v10 belongs to Session Runtime Data. v11 introduces awaited children.
  // Refuse a fake v10-only child schema and any partially applied v11.
  const runtimeComplete = row?.migration_count === 10 && row?.migration_v10 === 1 &&
    row?.migration_v11 === 0 && row?.runtime_table === 1 &&
    row?.capacity_column === 0 && row?.parent_column === 0 &&
    row?.parent_step_column === 0 && row?.child_index === 0 &&
    row?.child_cancel_table === 0 && row?.child_terminate_fence_column === 0 &&
    row?.capacity_guard_trigger === 0 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 1 &&
    row?.locator_column === 1 && row?.fixed_column === 1 && row?.fixed_index === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  const fullV11Schema = row?.migration_v10 === 1 &&
    row?.migration_v11 === 1 && row?.runtime_table === 1 &&
    row?.capacity_column === 1 && row?.parent_column === 1 &&
    row?.parent_step_column === 1 && row?.child_index === 1 &&
    row?.child_cancel_table === 1 && row?.child_terminate_fence_column === 1 &&
    row?.capacity_guard_trigger === 1 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 1 &&
    row?.locator_column === 1 && row?.fixed_column === 1 && row?.fixed_index === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  // Accept the reviewed v11 schema ONLY before a v12 migration. Deployment
  // requires the exact v12 receipt table + migration record.
  const completeV11 = row?.migration_count === 11 &&
    row?.migration_v12 === 0 && row?.event_receipts_table === 0 && fullV11Schema;
  const complete = row?.migration_count === 12 &&
    row?.migration_v12 === 1 && row?.event_receipts_table === 1 && fullV11Schema;
  invariant(base && (requireCompleteSchema ? complete : (before || partial || current || previous || oldComplete || runtimeComplete || completeV11 || complete)),
    "Workflow production D1 schema migrations missing, partial or drifted");
  invariant(Number.isSafeInteger(row?.active_runs) && row.active_runs === 0,
    "Workflow cannot redeploy while Runs are active or indeterminate");
  // D1 migration may change Session reservations even after the parent Run
  // succeeded at Ready. Require a physically quiescent Tailnet before schema
  // changes; completed-schema code-only releases use their separate gate.
  if(!complete) invariant(Number.isSafeInteger(row?.active_sessions) &&
    row.active_sessions===0, "Workflow D1 migration blocked by active physical Sessions");
  if(bootstrap) invariant(row.run_count === 0 && row.workflow_count === 0,
    "Workflow first deployment requires empty production Run and Workflow state");
  return true;
}

/**
 * #204: read-only database half of the migration fence.
 * It does not freeze ingress, inspect live Cloudflare Workflow instances,
 * verify external GitHub jobs or authorize a production cutover.
 */
export const WORKFLOW_MIGRATION_READINESS_SQL = `SELECT
 (SELECT count(*) FROM d1_migrations) AS migration_count,
 (SELECT count(*) FROM d1_migrations WHERE name IN (
   '0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql',
   '0004_s3_callback_receipts.sql','0005_github_workflow_check.sql',
   '0006_action_attempt_capabilities.sql','0007_session_executions.sql',
   '0008_session_locator.sql','0009_fixed_sessions.sql',
   '0010_session_runtime_data.sql','0011_awaited_child_capacity.sql',
   '0012_event_wait_receipts.sql')) AS expected_migrations,
 (SELECT count(*) FROM workflows) AS workflow_count,
 (SELECT count(*) FROM runs) AS run_count,
 (SELECT count(*) FROM session_executions) AS session_count,
 (SELECT count(*) FROM step_attempts) AS attempt_count,
 (SELECT count(*) FROM callback_receipts) AS callback_count,
 (SELECT count(*) FROM github_action_cancellations) AS cancellation_count,
 (SELECT count(*) FROM runs WHERE outcome IS NULL OR
   outcome NOT IN ('succeeded','failed','cancelled')) AS nonterminal_runs,
 (SELECT count(*) FROM runs WHERE start_state IS NULL OR
   start_state IN ('reserved','start_unknown')) AS unresolved_starts,
 (SELECT count(*) FROM run_steps WHERE status IS NULL OR
   status NOT IN ('succeeded','failed','skipped')) AS unresolved_steps,
 (SELECT count(*) FROM step_attempts WHERE state IS NULL OR
   state NOT IN ('rejected','succeeded','failed','cancelled')) AS nonterminal_attempts,
 (SELECT count(*) FROM session_executions WHERE state IS NULL OR
   state != 'terminated') AS nonterminated_sessions,
 (SELECT count(*) FROM callback_receipts WHERE notification_delivered IS NULL OR
   notification_delivered != 1) AS undelivered_callbacks,
 (SELECT count(*) FROM session_executions s
   JOIN runs r ON r.id=s.run_id
   JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
   WHERE s.state='ready' AND r.outcome='succeeded'
   AND a.state='claimed') AS confirmed_ready_sessions`;

export function verifyWorkflowMigrationReadiness(response) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow migration D1 readback unavailable");
  const row = response[0].results[0];
  const nonnegative = [
    "migration_count","expected_migrations","workflow_count","run_count",
    "session_count","attempt_count","callback_count","cancellation_count",
    "nonterminal_runs","unresolved_starts","unresolved_steps",
    "nonterminal_attempts","nonterminated_sessions","undelivered_callbacks",
  ];
  for (const key of nonnegative) {
    invariant(Number.isSafeInteger(row?.[key]) && row[key] >= 0,
      "Workflow migration D1 count unavailable or invalid: " + key);
  }
  invariant(row.migration_count === 12 && row.expected_migrations === 12,
    "Workflow migration requires the exact twelve reviewed D1 migrations");
  for (const key of [
    "nonterminal_runs","unresolved_starts","unresolved_steps",
    "nonterminal_attempts","nonterminated_sessions","undelivered_callbacks",
  ]) {
    invariant(row[key] === 0, "Workflow migration blocked by " + key);
  }
  return {
    workflows: row.workflow_count,
    runs: row.run_count,
    sessions: row.session_count,
    attempts: row.attempt_count,
    callbacks: row.callback_count,
    cancellations: row.cancellation_count,
  };
}

/**
 * Pure-code release gate: keep full quiescence for schema migrations, but
 * permit only claimed Ready sessions with a succeeded parent business Run.
 * All incomplete Tasks, unresolved Runs and callbacks remain blocked.
 */
export function verifyWorkflowCodeReleaseReadiness(response) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow code-only release D1 readback unavailable");
  const row=response[0].results[0];
  for (const key of [
    "migration_count","expected_migrations","nonterminal_runs",
    "unresolved_starts","unresolved_steps","nonterminal_attempts",
    "nonterminated_sessions","undelivered_callbacks","confirmed_ready_sessions",
  ]) invariant(Number.isSafeInteger(row?.[key]) && row[key]>=0,
    "Workflow code-only release count unavailable or invalid: "+key);
  invariant(row.migration_count===12 && row.expected_migrations===12,
    "Workflow code-only release blocked by D1 migration drift");
  for (const key of [
    "nonterminal_runs","unresolved_starts","unresolved_steps","undelivered_callbacks",
  ]) invariant(row[key]===0,"Workflow code-only release blocked by "+key);
  invariant(row.nonterminal_attempts===row.confirmed_ready_sessions &&
    row.nonterminated_sessions===row.confirmed_ready_sessions,
    "Workflow code-only release blocked by unconfirmed Session or Attempt");
  return {confirmed_ready_sessions:row.confirmed_ready_sessions};
}

export function parseWranglerVersion(output) {
  const match = output.match(/(?:Current )?Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  invariant(!!match, "Wrangler did not report a release Version ID");
  return match[1].toLowerCase();
}

export function activeVersion(deployments) {
  const deployment = deployments?.deployments?.[0];
  const versions = deployment?.versions;
  invariant(Array.isArray(versions) && versions.length === 1 &&
    versions[0]?.percentage === 100 && typeof versions[0]?.version_id === "string",
    "Active Worker version is not an unambiguous 100% release");
  return { deployment_id: deployment.id, version_id: versions[0].version_id };
}

export function verifyPublishedVersion(previous, observed, expected) {
  invariant(typeof expected === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expected),
    "Expected Wrangler version ID missing or malformed");
  invariant(observed.version_id.toLowerCase() === expected.toLowerCase(),
    "Active Worker version does not match the Wrangler-published version");
  if (previous.mode !== "bootstrap") {
    invariant(previous.version_id !== observed.version_id &&
      previous.deployment_id !== observed.deployment_id, "Active Worker version did not change");
  }
  return true;
}

function readConfiguration(worker, content) {
  const conf = JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""));
  if (worker === "workflow-mcp-worker") verifyWorkflowReleaseConfig(conf);
  invariant(conf.name === worker && conf.main === WORKER_ENTRIES[worker],
    "Worker script name or entry differs from selected target");
  invariant(conf.keep_vars === false,
    "GitHub/Wrangler must own all runtime Variables; keep_vars must be false");
  if (worker === "ssh-mcp-worker") {
    invariant(conf.observability?.enabled === true &&
      conf.observability?.logs?.invocation_logs === true,
      "SSH observability and invocation logs must stay enabled");
  } else {
    const logs = ["remote-control-mcp-worker", "email-mcp-worker"].includes(worker) ? false : true;
    invariant(conf.observability?.logs?.invocation_logs === logs,
      "Source Invocation Logs setting differs from production");
  }
  invariant(REQUIRED_SECRETS[worker].every((s) => conf.secrets?.required?.includes(s)),
    "Source required Secret names changed unexpectedly");
  if (worker === "email-mcp-worker") {
    invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN", "MAIL_ENCRYPTION_KEY"]),
      "Email source Secret declaration drift");
    const routes = conf.routes ?? [];
    invariant(conf.workers_dev === false && conf.preview_urls === false &&
      routes.length === 2 && routes.every(x => x.custom_domain === true) &&
      routes[0].pattern === "email.lirtual.dpdns.org" &&
      routes[1].pattern === "email-mcp.lirtual.dpdns.org",
      "Email production custom domains must keep Setup and MCP separate");
    invariant(conf.observability?.logs?.invocation_logs === false,
      "Email may not log mailbox operations");
    invariant(conf.d1_databases?.length === 1 &&
      conf.d1_databases[0].binding === "DB" &&
      conf.d1_databases[0].database_name === "email-mcp-db" &&
      conf.d1_databases[0].database_id === "1fa50616-effb-458e-b798-b1ca1a0da24f" &&
      conf.d1_databases[0].migrations_dir === "migrations",
      "Email production D1 source drift");
    invariant(!conf.vars || Object.keys(conf.vars).length === 0,
      "Email secrets must not be staged as plain-text vars");
  }
  if (worker === "ima-mcp-worker") {
    invariant(!conf.secrets?.required?.includes("IMA_CLIENT_ID"),
      "IMA IMA_CLIENT_ID must be provided as a Variable, not a Secret");
    invariant(conf.durable_objects?.bindings?.some((b) =>
      b.name === "IMA_IMAGE_REFRESH_SHARD" && b.class_name === "ImaImageRefreshShard") &&
      conf.exports?.ImaImageRefreshShard?.storage === "sqlite", "IMA SQLite Durable Object must remain");
    invariant(!conf.r2_buckets?.length, "Obsolete IMA R2 Worker binding still declared");
    invariant(conf.observability?.traces?.enabled === true, "IMA production tracing must be declared");
  }
  if (worker === "database-mcp-worker") {
    invariant(conf.ratelimits?.some((b) => b.name === "RATE_LIMITER" &&
      String(b.namespace_id) === "1001" && Number(b.simple?.limit) === 120 &&
      Number(b.simple?.period) === 60), "Source RATE_LIMITER policy changed");
  }
  if (worker === "ssh-mcp-worker") {
    invariant(conf.workers_dev === true && conf.preview_urls === false, "SSH public route drift");
    invariant(!conf.services?.length, "SSH must not retain EdgeSSH Broker Service Binding");
    invariant(conf.d1_databases?.length === 1 &&
      conf.d1_databases[0]?.binding === "EDGE_SSH_DB" &&
      conf.d1_databases[0]?.database_id === "bd5cfdc5-3db0-4af7-8e95-cbf3d65cfa94",
      "SSH shared EdgeSSH D1 configuration drift");
    invariant(conf.durable_objects?.bindings?.length === 1 &&
      conf.durable_objects.bindings[0].name === "SSH_OPERATIONS" &&
      conf.durable_objects.bindings[0].class_name === "SshOperationsDO" &&
      conf.migrations?.[0]?.tag === "v1" &&
      conf.migrations[0].new_sqlite_classes?.includes("SshOperationsDO"), "SSH SQLite DO migration drift");
    invariant(!conf.vars?.MCP_BROKER_FULL_ACCESS,
      "SSH must be broker-only and read-only by default");
  }
  if (worker === "remote-control-mcp-worker") {
    invariant(!conf.vars?.REMOTE_CONTROL_V2_ONLY &&
      !conf.vars?.REMOTE_CONTROL_V2_PREVIEW_ONLY &&
      !conf.vpc_services && conf.preview_urls === false,
      "Production must have no runtime mode switch or VPC");
    const bindings = conf.durable_objects?.bindings;
    invariant(Array.isArray(bindings) && bindings.length === 1 &&
      bindings[0]?.name === "DEVICE_COORDINATOR" &&
      bindings[0]?.class_name === "DeviceCoordinator" &&
      !bindings[0]?.script_name &&
      conf.exports?.DeviceCoordinator?.storage === "sqlite",
      "Production must declare a local SQLite DeviceCoordinator");
  }
  return conf;
}

async function cfListRead(path, token) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  invariant(response.ok, "Workflow private Fixture route inventory HTTP " + response.status);
  const data = await response.json();
  invariant(data?.success === true && Array.isArray(data.result),
    "Workflow private Fixture route inventory missing");
  invariant((data.result_info?.total_pages ?? 1) <= 1 &&
    (!data.result_info?.total_count || data.result_info.total_count <= data.result.length),
    "Workflow private Fixture route inventory incomplete");
  return data.result;
}

async function cfGet(account, worker, token, endpoint) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(account) + "/workers/scripts/" + encodeURIComponent(worker) + endpoint;
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  invariant(response.ok, "Cloudflare read-only " + endpoint + " HTTP " + response.status);
  const document = await response.json();
  invariant(document?.success === true && document?.result != null,
    "Cloudflare read-only " + endpoint + " failed");
  return document.result;
}

async function scriptExists(account, worker, token) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(account) + "/workers/scripts?per_page=100";
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  invariant(response.ok, "Cloudflare script inventory HTTP " + response.status);
  const document = await response.json();
  invariant(document?.success === true && Array.isArray(document.result),
    "Cloudflare script inventory unavailable");
  invariant(!document.result_info?.total_count ||
    document.result_info.total_count <= document.result.length, "Cloudflare inventory incomplete");
  return document.result.some((item) => item.id === worker);
}

async function current(account, worker, token, options) {
  const [settings, secrets, deployments, scriptSettings] = await Promise.all([
    cfGet(account, worker, token, "/settings"),
    cfGet(account, worker, token, "/secrets"),
    cfGet(account, worker, token, "/deployments?per_page=1"),
    cfGet(account, worker, token, "/script-settings"),
  ]);
  const existingOwner = worker === "remote-control-mcp-worker" &&
    Array.isArray(settings.bindings)
    ? settings.bindings.find(x => x.name === "V2_OWNER" &&
      x.type === "durable_object_namespace" &&
      x.class_name === "V2OwnerCoordinator" &&
      x.script_name === "remote-control-v2-preview")
    : null;
  // Capture the namespace before cutover in the protected release state file.
  // After a successful release, validation must work even if Preview is gone.
  const previousNamespaceId = options.mode === "preflight"
    ? existingOwner?.namespace_id : options.previousNamespaceId;
  verifyBindings(worker, settings, secrets, {
    ...options, previousNamespaceId,
  });
  if (options.sourceConfig) {
    invariant(settings.compatibility_date === options.sourceConfig.compatibility_date,
      "Compatibility date drift");
    const actualFlags = [...(settings.compatibility_flags || [])].sort();
    const expectedFlags = [...(options.sourceConfig.compatibility_flags || [])].sort();
    invariant(JSON.stringify(actualFlags) === JSON.stringify(expectedFlags),
      "Compatibility flag drift");
  }
  if (worker !== "ssh-mcp-worker") {
    invariant(scriptSettings?.observability?.logs?.invocation_logs ===
      (["remote-control-mcp-worker", "email-mcp-worker"].includes(worker) ? false : true),
      "Script-level Invocation Logs drift");
  }
  if (worker === "ima-mcp-worker") {
    invariant(scriptSettings?.observability?.traces?.enabled === true, "IMA script tracing drift");
  }
  return {
    ...activeVersion(deployments),
    ...(options.mode === "preflight" && typeof previousNamespaceId === "string"
      ? { previousNamespaceId } : {}),
  };
}

/** Cloudflare deployment version and Secret inventories may propagate
 * independently. Retry only these two exact post-deploy readback states;
 * identity, configuration, schema and other version failures remain fatal. */
export async function retryReleaseReadback(read, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await read(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const transient = /^Required (Secret binding|runtime Secret) missing: /.test(message) ||
        message === "Active Worker version does not match the Wrangler-published version";
      if (attempt === 5 || !transient) throw error;
      await pause(2000);
    }
  }
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  invariant(["preflight", "readback", "version", "diagnostic", "d1-check", "migration-sql", "migration-check", "code-release-check"].includes(mode), "Unknown release validation mode");
  if (mode === "migration-sql") {
    invariant(worker === "workflow-mcp-worker", "Migration SQL restricted to Workflow");
    console.log(WORKFLOW_MIGRATION_READINESS_SQL);
    return;
  }
  if (mode === "code-release-check") {
    invariant(worker === "workflow-mcp-worker", "Release gate restricted to Workflow");
    const result = verifyWorkflowCodeReleaseReadiness(
      JSON.parse(await readFile("/dev/stdin", "utf8")));
    console.log("Workflow code-only release D1 gate: PASS " +
      JSON.stringify(result) + "; no migration, no unconfirmed execution");
    return;
  }
  if (mode === "migration-check") {
    invariant(worker === "workflow-mcp-worker", "Migration check restricted to Workflow");
    const observed = verifyWorkflowMigrationReadiness(
      JSON.parse(await readFile("/dev/stdin", "utf8")));
    console.log("Workflow migration D1 quiescence: PASS " +
      JSON.stringify(observed) + "; external GitHub/Cloudflare instance " +
      "and write-freeze checks NOT verified");
    return;
  }
  if (mode === "d1-check") {
    invariant(worker === "workflow-mcp-worker", "D1 check restricted to Workflow");
    const raw = await readFile("/dev/stdin", "utf8");
    verifyWorkflowD1Readiness(JSON.parse(raw),
      process.env.WORKFLOW_FIRST_DEPLOY === "true",
      process.env.WORKFLOW_REQUIRE_COMPLETE_SCHEMA === "true");
    console.log("Workflow production D1 migrations and Run-state gate verified");
    return;
  }
  if (mode === "diagnostic") {
    invariant(worker, "Wrangler log path missing");
    const log = await readFile(worker, "utf8");
    const codes = [...log.matchAll(/\b(?:error\s+code|code)\s*[:=]?\s*(\d{4,6})\b/gi)]
      .map((match) => match[1]).slice(0, 3);
    console.error("Wrangler diagnostic: stage=deploy; code=" +
      (codes.length ? [...new Set(codes)].join(",") : "unavailable") +
      "; summary=Wrangler CLI exited unsuccessfully (details withheld)");
    return;
  }
  if (mode === "version") {
    const file = worker;
    invariant(file, "Wrangler log path missing");
    console.log(parseWranglerVersion(await readFile(file, "utf8")));
    return;
  }
  invariant(WORKERS.has(worker), "Unsupported Worker target");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const statePath = process.env.RELEASE_STATE_FILE;
  const sourceSha = process.env.GITHUB_SHA;
  const configPath = join(process.cwd(), "apps", worker, "wrangler.jsonc");
  const rawConfig = await readFile(configPath, "utf8");
  const sourceConfig = readConfiguration(worker, rawConfig);
  invariant(account && token && statePath && sourceSha, "Required release environment missing");
  const previous = mode === "readback"
    ? JSON.parse(await readFile(statePath, "utf8")) : null;
  if (previous) invariant(previous.worker === worker && previous.sourceSha === sourceSha,
    "Release source changed");
  const exists = mode === "preflight" ? await scriptExists(account, worker, token) : true;
  const read = async () => {
    const observed = await current(account, worker, token, {
      mode, sourceConfig, previousNamespaceId: previous?.previousNamespaceId,
    });
    // Compare the active deployment inside the existing retry loop. Cloudflare
    // may briefly serve the previous version after Wrangler reports success.
    if (mode === 'readback' && worker === 'workflow-mcp-worker')
      verifyPublishedVersion(previous, observed, process.env.EXPECTED_VERSION_ID);
    return observed;
  };
  const observed = !exists ? { mode: "bootstrap" }
    : mode === "readback" && worker === "workflow-mcp-worker"
      ? await retryReleaseReadback(read) : await read();
  if (mode === "preflight") {
    await writeFile(statePath, JSON.stringify({ worker, sourceSha, ...observed }), { mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, "bootstrap=" + (!exists) + "\n");
    }
    console.log("Preflight OK: " + worker + " (" + (exists ? "update" : "bootstrap") +
      "; source " + sourceSha.slice(0, 12) + ")");
  } else {
    verifyPublishedVersion(previous, observed, process.env.EXPECTED_VERSION_ID);
    console.log("Release verified: " + worker + " version " + observed.version_id +
      " source " + sourceSha.slice(0, 12) +
      (previous.mode === "bootstrap" ? " (first deployment)" : ""));
  }
}

if (process.argv[1]?.endsWith("/manual-worker-release.mjs")) {
  main().catch((error) => {
    console.error("Release validation failed: " + error.message);
    process.exitCode = 1;
  });
}
