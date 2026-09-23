/* global process, console, setTimeout */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import {
  OPERATIONS,
  WORKER_NAME,
  WORKER_URL,
  assertRollbackState,
  assertProductionTarget,
  buildRollbackDeploymentRequest,
  buildSamplePlan,
  buildSnapshotRecord,
  buildTelemetryRunQuery,
  cloudflareJson,
  invokeFixedOperation,
  parseTelemetryRun,
  requireSafeTag,
  requireSha,
  requireUuid,
  sanitizeBlockedReason,
  verifySourceIdentity,
} from "./v4-cpu-evidence-lib.mjs";

const command = process.argv[2];
const env = process.env;

function required(name) {
  const value = env[name];
  assert(value, `${name} is required`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeSanitized(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function snapshot() {
  assertProductionTarget(
    required("RAINDROP_EVIDENCE_WORKER"),
    required("RAINDROP_EVIDENCE_URL"),
  );
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = required("CLOUDFLARE_API_TOKEN");
  const payload = await cloudflareJson({
    accountId,
    apiToken,
    path: `/workers/scripts/${WORKER_NAME}/deployments`,
  });
  const verifySource = command === "snapshot-deployed";
  const sourceSha = verifySource
    ? requireSha(required("RAINDROP_EVIDENCE_SOURCE_SHA"))
    : undefined;
  const current = buildSnapshotRecord(payload, sourceSha);
  await writeSanitized(required("RAINDROP_EVIDENCE_OUTPUT"), {
    schemaVersion: 1,
    worker: WORKER_NAME,
    url: WORKER_URL,
    checkedAt: new Date().toISOString(),
    ...current,
  });
}

async function rollback() {
  assertProductionTarget(
    required("RAINDROP_EVIDENCE_WORKER"),
    required("RAINDROP_EVIDENCE_URL"),
  );
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = required("CLOUDFLARE_API_TOKEN");
  const rollbackRecord = env.RAINDROP_EVIDENCE_ROLLBACK_PATH
    ? await readJson(env.RAINDROP_EVIDENCE_ROLLBACK_PATH)
    : undefined;
  const versionId = requireUuid(
    env.RAINDROP_EVIDENCE_ROLLBACK_VERSION_ID ?? rollbackRecord?.versionId,
    "rollback version ID",
  );
  const sourceSha = requireSha(required("RAINDROP_EVIDENCE_SOURCE_SHA"));
  const currentPayload = await cloudflareJson({
    accountId,
    apiToken,
    path: `/workers/scripts/${WORKER_NAME}/deployments`,
  });
  const current = buildSnapshotRecord(currentPayload);
  const action = assertRollbackState(
    current,
    {
      deploymentId: requireUuid(
        rollbackRecord?.deploymentId ?? required("RAINDROP_EVIDENCE_ROLLBACK_DEPLOYMENT_ID"),
        "rollback deployment ID",
      ),
      versionId,
    },
    sourceSha,
  );
  if (action === "already-restored") {
    if (env.RAINDROP_EVIDENCE_OUTPUT) {
      await writeSanitized(env.RAINDROP_EVIDENCE_OUTPUT, {
        schemaVersion: 1,
        status: "restored",
        stage: "rollback",
        action,
        versionId,
      });
    }
    console.log(`ROLLBACK_ALREADY_RESTORED version=${versionId}`);
    return;
  }
  const payload = await cloudflareJson({
    accountId,
    apiToken,
    method: "POST",
    path: `/workers/scripts/${WORKER_NAME}/deployments`,
    body: buildRollbackDeploymentRequest(versionId),
  });
  const restored = buildSnapshotRecord({
    success: payload.success,
    errors: payload.errors,
    result: [payload.result],
  });
  assert.equal(restored.versionId, versionId, "Rollback version mismatch");
  if (env.RAINDROP_EVIDENCE_OUTPUT) {
    await writeSanitized(env.RAINDROP_EVIDENCE_OUTPUT, {
      schemaVersion: 1,
      status: "restored",
      stage: "rollback",
      action: "restored-recorded-version",
      versionId,
    });
  }
  console.log(`ROLLBACK_VERIFIED version=${versionId}`);
}

async function recordBlocked() {
  const output = required("RAINDROP_EVIDENCE_OUTPUT");
  try {
    await access(output);
    console.log("BLOCKED_EVIDENCE_ALREADY_PRESENT");
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeSanitized(output, {
    schemaVersion: 1,
    status: "blocked",
    stage: requireSafeTag(required("RAINDROP_EVIDENCE_STAGE"), "blocked stage"),
    reason: sanitizeBlockedReason(required("RAINDROP_EVIDENCE_REASON")),
    sourceSha: requireSha(required("RAINDROP_EVIDENCE_SOURCE_SHA")),
  });
}

function verifySource() {
  const expected = requireSha(required("RAINDROP_EVIDENCE_SOURCE_SHA"));
  const workflowSha = requireSha(
    required("RAINDROP_EVIDENCE_WORKFLOW_SHA"),
    "reviewed workflow SHA",
  );
  const actual = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  ).trim();
  verifySourceIdentity(expected, actual, workflowSha, dirty);
  console.log(`SOURCE_VERIFIED sha=${actual}`);
}

async function probe() {
  assertProductionTarget(
    required("RAINDROP_EVIDENCE_WORKER"),
    required("RAINDROP_EVIDENCE_URL"),
  );
  const run = requireSafeTag(required("RAINDROP_EVIDENCE_RUN"), "run");
  const token = required("MCP_ACCESS_TOKEN");
  const observations = [];
  for (const item of buildSamplePlan()) {
    const operation = OPERATIONS.find(
      (candidate) => candidate.label === item.label,
    );
    const observation = await invokeFixedOperation({
      baseUrl: WORKER_URL,
      token,
      run,
      sample: item.sample,
      operation,
    });
    observations.push({
      ...observation,
      phase: item.phase,
      window: item.window,
      ordinal: item.ordinal,
    });
    console.log(
      `READ_ONLY_SAMPLE op=${item.label} sample=${item.sample} status=succeeded`,
    );
  }
  await writeSanitized(required("RAINDROP_EVIDENCE_OUTPUT"), {
    schemaVersion: 1,
    run,
    worker: WORKER_NAME,
    observations,
  });
}

async function collect() {
  assertProductionTarget(
    required("RAINDROP_EVIDENCE_WORKER"),
    required("RAINDROP_EVIDENCE_URL"),
  );
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = required("CLOUDFLARE_API_TOKEN");
  const run = requireSafeTag(required("RAINDROP_EVIDENCE_RUN"), "run");
  const sourceSha = requireSha(required("RAINDROP_EVIDENCE_SOURCE_SHA"));
  const deploymentId = requireUuid(
    required("RAINDROP_EVIDENCE_DEPLOYMENT_ID"),
    "deployment ID",
  );
  const versionId = requireUuid(
    required("RAINDROP_EVIDENCE_VERSION_ID"),
    "version ID",
  );
  const rollbackDeploymentId = requireUuid(
    required("RAINDROP_EVIDENCE_ROLLBACK_DEPLOYMENT_ID"),
    "rollback deployment ID",
  );
  const rollbackVersionId = requireUuid(
    required("RAINDROP_EVIDENCE_ROLLBACK_VERSION_ID"),
    "rollback version ID",
  );
  const journal = await readJson(required("RAINDROP_EVIDENCE_JOURNAL"));
  assert.equal(journal.run, run, "Probe journal run mismatch");
  assert.equal(journal.worker, WORKER_NAME, "Probe journal Worker mismatch");
  assert.equal(
    journal.observations?.length,
    4 * 31,
    "Probe journal is incomplete",
  );
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const observation of journal.observations) {
    assert.equal(
      observation.httpStatus,
      200,
      "Probe journal contains a failed HTTP request",
    );
    assert.equal(
      observation.jsonRpcStatus,
      "succeeded",
      "Probe journal contains a failed JSON-RPC request",
    );
    const started = Date.parse(observation.startedAt);
    const ended = Date.parse(observation.endedAt);
    assert(
      Number.isFinite(started) && Number.isFinite(ended) && started <= ended,
      "Probe UTC window is invalid",
    );
    earliest = Math.min(earliest, started);
    latest = Math.max(latest, ended);
  }
  const query = buildTelemetryRunQuery({
    run,
    versionId,
    from: Math.max(0, earliest - 30_000),
    to: latest + 60_000,
  });
  let parsedSamples;
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const payload = await cloudflareJson({
        accountId,
        apiToken,
        method: "POST",
        path: "/workers/observability/telemetry/query",
        body: query,
      });
      parsedSamples = parseTelemetryRun(payload, journal.observations, {
        run,
        versionId,
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 6)
        await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  assert(
    parsedSamples,
    `Blocked: incomplete native telemetry: ${lastError}`,
  );
  const samples = journal.observations.map((observation, index) => ({
      op: observation.op,
      phase: observation.phase,
      window: observation.window,
      ordinal: observation.ordinal,
      sample: observation.sample,
      requestStartedAt: observation.startedAt,
      requestEndedAt: observation.endedAt,
      jsonRpcStatus: observation.jsonRpcStatus,
      ...parsedSamples[index],
    }));
  await writeSanitized(required("RAINDROP_EVIDENCE_OUTPUT"), {
    schemaVersion: 1,
    status: "complete",
    run,
    sourceSha,
    target: { worker: WORKER_NAME, url: WORKER_URL, deploymentId, versionId },
    rollback: {
      deploymentId: rollbackDeploymentId,
      versionId: rollbackVersionId,
    },
    telemetry: {
      source: "Cloudflare Workers Observability",
      cpuField: "$workers.cpuTimeMs",
      samples,
    },
  });
}

try {
  if (command === "verify-source") verifySource();
  else if (command === "snapshot" || command === "snapshot-deployed")
    await snapshot();
  else if (command === "probe") await probe();
  else if (command === "collect") await collect();
  else if (command === "rollback") await rollback();
  else if (command === "record-blocked") await recordBlocked();
  else
    throw new Error(
      "Command must be verify-source, snapshot, snapshot-deployed, probe, collect, rollback, or record-blocked",
    );
} catch (error) {
  const reason = sanitizeBlockedReason(
    error instanceof Error ? error.message : String(error),
  );
  const blockedOutput =
    env.RAINDROP_EVIDENCE_BLOCKED_OUTPUT ?? env.RAINDROP_EVIDENCE_OUTPUT;
  if (
    blockedOutput &&
    ["snapshot-deployed", "probe", "collect", "rollback"].includes(command)
  ) {
    await writeSanitized(
      blockedOutput,
      {
      schemaVersion: 1,
      status: "blocked",
      stage: command,
      reason,
      sourceSha: env.RAINDROP_EVIDENCE_SOURCE_SHA,
      deploymentId: env.RAINDROP_EVIDENCE_DEPLOYMENT_ID,
      versionId: env.RAINDROP_EVIDENCE_VERSION_ID,
      },
    );
  }
  console.error(`BLOCKED: ${reason}`);
  process.exitCode = 1;
}
