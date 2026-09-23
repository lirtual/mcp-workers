/* global Response, structuredClone, URL */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CPU_KEY,
  OPERATIONS,
  OP_HEADER,
  RUN_HEADER,
  SAMPLE_HEADER,
  WORKER_NAME,
  WORKER_URL,
  assertProductionTarget,
  assertRollbackState,
  buildRollbackDeploymentRequest,
  buildSamplePlan,
  buildSnapshotRecord,
  buildTelemetryRunQuery,
  buildTelemetryQuery,
  invokeFixedOperation,
  parseCurrentDeployment,
  parseTelemetryEvent,
  parseTelemetryRun,
  requireSha,
  requireSafeTag,
  sanitizeBlockedReason,
  verifyDeploymentProvenance,
  verifySourceIdentity,
} from "../scripts/v4-cpu-evidence-lib.mjs";

const deploymentId = "367c8e27-eb45-4959-949b-49d883917720";
const versionId = "52a58648-1f94-4f7c-81da-d58face037f0";
const sourceSha = "cc05fc9ecbdac38a57d66856f771583746b0e6df";

function deploymentPayload(
  versions = [{ version_id: versionId, percentage: 100 }],
) {
  return {
    success: true,
    errors: [],
    result: [
      {
        id: deploymentId,
        created_on: "2026-09-21T12:00:00.000Z",
        versions,
        annotations: { "workers/message": `issue-129 source=${sourceSha}` },
      },
    ],
  };
}

function telemetryPayload(overrides = {}) {
  return {
    success: true,
    errors: [],
    result: {
      run: { status: "COMPLETED" },
      events: {
        events: [
          {
            timestamp: 1_795_000_000_000,
            $metadata: { service: WORKER_NAME, statusCode: 200 },
            $workers: {
              cpuTimeMs: 7,
              scriptVersion: { id: versionId },
              event: {
                request: {
                  headers: {
                    [RUN_HEADER]: "run-1",
                    [OP_HEADER]: "initialize",
                    [SAMPLE_HEADER]: "first",
                  },
                },
              },
            },
            ...overrides,
          },
        ],
      },
    },
  };
}

test("production target, immutable SHA, and sanitized tags fail closed", () => {
  assert.doesNotThrow(() => assertProductionTarget(WORKER_NAME, WORKER_URL));
  assert.throws(() => assertProductionTarget(WORKER_NAME, `${WORKER_URL}/mcp`));
  assert.throws(() =>
    assertProductionTarget("raindrop-mcp-worker-v3-test", WORKER_URL),
  );
  assert.equal(requireSha(sourceSha), sourceSha);
  assert.throws(() => requireSha("main"));
  assert.equal(requireSafeTag("run-123.4", "run"), "run-123.4");
  assert.throws(() => requireSafeTag("run/header", "run"));
  assert.throws(() => requireSafeTag("run\r\ninjected", "run"));
});

test("plan contains only four fixed reads and exactly first + three ten-sample windows", () => {
  assert.deepEqual(
    OPERATIONS.map((operation) => [operation.label, operation.method]),
    [
      ["initialize", "initialize"],
      ["tools_list", "tools/list"],
      ["diagnostics_read_local", "tools/call"],
      ["raindrop_read_list_1", "tools/call"],
    ],
  );
  assert.equal(OPERATIONS[2].params.name, "diagnostics_read");
  assert.deepEqual(OPERATIONS[2].params.arguments, { action: "local" });
  assert.equal(OPERATIONS[3].params.name, "raindrop_read");
  assert.deepEqual(OPERATIONS[3].params.arguments, {
    action: "list",
    collectionId: 0,
    page: 0,
    perpage: 1,
  });
  const plan = buildSamplePlan();
  assert.equal(plan.length, 4 * 31);
  for (const label of OPERATIONS.map((operation) => operation.label)) {
    const samples = plan.filter((sample) => sample.label === label);
    assert.equal(
      samples.filter((sample) => sample.phase === "first").length,
      1,
    );
    for (let window = 1; window <= 3; window += 1) {
      assert.equal(
        samples.filter((sample) => sample.window === window).length,
        10,
      );
    }
  }
  assert(
    !JSON.stringify(plan).match(/create|update|delete|trash|rename|merge/),
  );
});

test("deployment snapshot requires one version at 100 percent and verifies SHA annotation", () => {
  assert.deepEqual(parseCurrentDeployment(deploymentPayload()), {
    deploymentId,
    versionId,
    createdAt: "2026-09-21T12:00:00.000Z",
    message: `issue-129 source=${sourceSha}`,
  });
  assert.throws(() =>
    parseCurrentDeployment(
      deploymentPayload([
        { version_id: versionId, percentage: 50 },
        { version_id: "8ec94687-81bd-4c79-915c-3e9d6947a1ef", percentage: 50 },
      ]),
    ),
  );
  assert.doesNotThrow(() =>
    verifyDeploymentProvenance(
      { message: `issue-129 source=${sourceSha}` },
      sourceSha,
    ),
  );
  assert.throws(() =>
    verifyDeploymentProvenance(
      { message: "issue-129 source=wrong" },
      sourceSha,
    ),
  );
});

test("rollback snapshot does not require the future source SHA, while deployed snapshot does", () => {
  const rollbackPayload = deploymentPayload();
  rollbackPayload.result[0].annotations["workers/message"] =
    "frozen-v3 source=cc05fc9ecbdac38a57d66856f771583746b0e6df";
  const rollback = buildSnapshotRecord(rollbackPayload);
  assert.equal(rollback.deploymentId, deploymentId);
  assert.equal(rollback.versionId, versionId);
  assert.equal("sourceSha" in rollback, false);

  assert.throws(
    () => buildSnapshotRecord(rollbackPayload, sourceSha),
    /immutable source SHA/,
  );
  assert.equal(
    buildSnapshotRecord(deploymentPayload(), sourceSha).sourceSha,
    sourceSha,
  );
});

test("rollback request restores exactly one recorded version at 100 percent", () => {
  assert.deepEqual(buildRollbackDeploymentRequest(versionId), {
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
    annotations: {
      "workers/message": `issue-129 automatic rollback version=${versionId}`,
    },
  });
  assert.throws(() => buildRollbackDeploymentRequest("main"));
});

test("workflow snapshots rollback without future SHA, verifies deployed SHA, and rolls back after any successful deploy failure", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/raindrop-v4-cpu-evidence.yml", import.meta.url),
    "utf8",
  );
  const preDeploy = workflow.slice(
    workflow.indexOf("Record and verify pre-deploy rollback point"),
    workflow.indexOf("Deploy exact SHA without changing secrets"),
  );
  const postDeploy = workflow.slice(
    workflow.indexOf("Verify deployed version provenance"),
    workflow.indexOf("Run fixed read-only observations"),
  );
  assert.match(preDeploy, /v4-cpu-evidence\.mjs snapshot\n/);
  assert.doesNotMatch(preDeploy, /snapshot-deployed/);
  assert.match(postDeploy, /v4-cpu-evidence\.mjs snapshot-deployed\n/);
  assert.match(workflow, /id: deploy\n/);
  assert.match(
    workflow,
    /always\(\).*steps\.deploy\.outcome != 'skipped'.*failure\(\).*cancelled\(\)/,
  );
  assert.match(workflow, /RAINDROP_EVIDENCE_ROLLBACK_PATH/);
  assert.match(workflow, /RAINDROP_EVIDENCE_BLOCKED_OUTPUT: \$\{\{ env\.EVIDENCE_PATH \}\}/);
  assert.match(workflow, /cleanup:\n/);
  assert.match(workflow, /needs: evidence/);
  assert.match(
    workflow,
    /always\(\).*needs\.evidence\.result != 'success'/,
    "a separate job must roll back after evidence-job timeout or cancellation",
  );
  assert.match(workflow, /RAINDROP_EVIDENCE_ROLLBACK_DEPLOYMENT_ID: \$\{\{ inputs\.expected_rollback_deployment \}\}/);
  assert.match(workflow, /RAINDROP_EVIDENCE_ROLLBACK_VERSION_ID: \$\{\{ inputs\.expected_rollback_version \}\}/);
  assert.match(
    workflow,
    /name: Record deployment failure as sanitized Blocked evidence/,
  );
  assert.match(workflow, /v4-cpu-evidence\.mjs record-blocked/);
  const confirmationStep = workflow.slice(
    workflow.indexOf("Validate explicit production confirmation"),
    workflow.indexOf("uses: actions/checkout"),
  );
  assert.doesNotMatch(
    confirmationStep.slice(confirmationStep.indexOf("run: |")),
    /\$\{\{ inputs\.production_confirmation \}\}/,
  );
  assert.match(workflow, /PRODUCTION_CONFIRMATION: \$\{\{ inputs\.production_confirmation \}\}/);
  assert.equal(
    workflow.match(/v4-cpu-evidence\.mjs verify-source/g)?.length,
    2,
    "source must be reverified immediately before deploy",
  );
});

test("source authorization requires checkout SHA to equal the dispatched reviewed workflow SHA", () => {
  assert.equal(verifySourceIdentity(sourceSha, sourceSha, sourceSha, ""), sourceSha);
  assert.throws(() => verifySourceIdentity(sourceSha, sourceSha, "a".repeat(40), ""), /reviewed workflow SHA/);
  assert.throws(() => verifySourceIdentity(sourceSha, sourceSha, sourceSha, " M file"), /clean/);
});

test("telemetry query is exact to script, version, run, operation, sample, and native CPU", () => {
  const query = buildTelemetryQuery({
    run: "run-1",
    op: "initialize",
    sample: "first",
    versionId,
    from: 100,
    to: 200,
  });
  assert.equal(query.view, "events");
  assert.equal(query.limit, 2);
  assert.deepEqual(query.parameters.filters, [
    {
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: WORKER_NAME,
    },
    {
      key: "$workers.scriptVersion.id",
      operation: "eq",
      type: "string",
      value: versionId,
    },
    {
      key: `$workers.event.request.headers.${RUN_HEADER}`,
      operation: "eq",
      type: "string",
      value: "run-1",
    },
    {
      key: `$workers.event.request.headers.${OP_HEADER}`,
      operation: "eq",
      type: "string",
      value: "initialize",
    },
    {
      key: `$workers.event.request.headers.${SAMPLE_HEADER}`,
      operation: "eq",
      type: "string",
      value: "first",
    },
    { key: CPU_KEY, operation: "exists", type: "number" },
  ]);
});

test("native telemetry parser requires exactly one correlated event, CPU, UTC, and HTTP status", () => {
  assert.deepEqual(
    parseTelemetryEvent(telemetryPayload(), {
      run: "run-1",
      op: "initialize",
      sample: "first",
      versionId,
      httpStatus: 200,
    }),
    { utc: "2026-11-18T11:06:40.000Z", cpuTimeMs: 7, httpStatus: 200 },
  );

  const missingCpu = telemetryPayload();
  delete missingCpu.result.events.events[0].$workers.cpuTimeMs;
  assert.throws(
    () =>
      parseTelemetryEvent(missingCpu, {
        run: "run-1",
        op: "initialize",
        sample: "first",
        versionId,
        httpStatus: 200,
      }),
    /native \$workers\.cpuTimeMs/,
  );

  const ambiguous = telemetryPayload();
  ambiguous.result.events.events.push(
    structuredClone(ambiguous.result.events.events[0]),
  );
  assert.throws(
    () =>
      parseTelemetryEvent(ambiguous, {
        run: "run-1",
        op: "initialize",
        sample: "first",
        versionId,
        httpStatus: 200,
      }),
    /exactly one/,
  );
  const failedHttp = telemetryPayload();
  failedHttp.result.events.events[0].$metadata.statusCode = 500;
  assert.throws(() =>
    parseTelemetryEvent(failedHttp, {
      run: "run-1", op: "initialize", sample: "first", versionId,
      httpStatus: 200,
    }), /HTTP status mismatch/);
});

test("one bounded telemetry query correlates the complete journal and rejects missing samples", () => {
  const observations = buildSamplePlan().map((item) => ({
    op: item.label,
    sample: item.sample,
    phase: item.phase,
    window: item.window,
    ordinal: item.ordinal,
    startedAt: "2026-11-18T11:06:00.000Z",
    endedAt: "2026-11-18T11:07:00.000Z",
    httpStatus: 200,
    jsonRpcStatus: "succeeded",
  }));
  const query = buildTelemetryRunQuery({
    run: "run-1", versionId, from: 1, to: 2,
  });
  assert.equal(query.limit, 200);
  assert.equal(query.parameters.filters.length, 4);

  const events = observations.map((observation, index) => {
    const payload = telemetryPayload();
    const event = payload.result.events.events[0];
    event.timestamp += index;
    event.$workers.event.request.headers[OP_HEADER] = observation.op;
    event.$workers.event.request.headers[SAMPLE_HEADER] = observation.sample;
    return event;
  });
  const payload = telemetryPayload();
  payload.result.events.events = events;
  assert.equal(
    parseTelemetryRun(payload, observations, { run: "run-1", versionId }).length,
    124,
  );
  payload.result.events.events.pop();
  assert.throws(() =>
    parseTelemetryRun(payload, observations, { run: "run-1", versionId }),
    /exactly one event/,
  );
});

test("rollback is compare-and-set: no-op on restored version and refuses unrelated deployments", () => {
  const rollback = { deploymentId, versionId };
  assert.equal(assertRollbackState(rollback, rollback, sourceSha), "already-restored");
  const candidate = {
    deploymentId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    message: `issue-129 source=${sourceSha}`,
  };
  assert.equal(assertRollbackState(candidate, rollback, sourceSha), "restore");
  assert.throws(() => assertRollbackState({ ...candidate, message: "manual deploy" }, rollback, sourceSha), /unrelated deployment/);
});

test("Blocked reasons redact credentials and URLs before artifact persistence", () => {
  const reason = sanitizeBlockedReason(
    "fetch https://secret.example/mcp failed Authorization: Bearer abc123",
  );
  assert.doesNotMatch(reason, /secret\.example|abc123/);
  assert.match(reason, /\[redacted-url\]|\[redacted\]/);
});

test("deployment ambiguity writes one sanitized Blocked artifact without overwriting richer evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "raindrop-v4-evidence-"));
  const output = join(directory, "blocked.json");
  const script = fileURLToPath(
    new URL("../scripts/v4-cpu-evidence.mjs", import.meta.url),
  );
  const run = (reason) =>
    execFileSync(process.execPath, [script, "record-blocked"], {
      env: {
        ...process.env,
        RAINDROP_EVIDENCE_OUTPUT: output,
        RAINDROP_EVIDENCE_STAGE: "deploy",
        RAINDROP_EVIDENCE_REASON: reason,
        RAINDROP_EVIDENCE_SOURCE_SHA: sourceSha,
      },
    });
  try {
    run("failed at https://secret.example with Bearer abc123");
    const first = readFileSync(output, "utf8");
    const record = JSON.parse(first);
    assert.equal(record.status, "blocked");
    assert.equal(record.stage, "deploy");
    assert.doesNotMatch(record.reason, /secret\.example|abc123/);
    run("a later generic failure must not replace the first record");
    assert.equal(readFileSync(output, "utf8"), first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP driver rejects non-fixed operations and blocks until both v4 tracers exist", async () => {
  const fakeFetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers[RUN_HEADER], "run-1");
    assert.equal(init.headers[OP_HEADER], "tools_list");
    assert.equal(init.headers[SAMPLE_HEADER], "first");
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: "diagnostics" }, { name: "raindrop_list" }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  await assert.rejects(
    () =>
      invokeFixedOperation({
        baseUrl: WORKER_URL,
        token: "synthetic-token",
        run: "run-1",
        sample: "first",
        operation: OPERATIONS[1],
        fetchImpl: fakeFetch,
      }),
    /Blocked: v4 diagnostics_read tracer is not deployed/,
  );
  await assert.rejects(
    () =>
      invokeFixedOperation({
        baseUrl: WORKER_URL,
        token: "synthetic-token",
        run: "run-1",
        sample: "first",
        operation: {
          label: "raindrop_delete",
          method: "tools/call",
          params: {},
        },
        fetchImpl: fakeFetch,
      }),
    /Only fixed read-only/,
  );
});
