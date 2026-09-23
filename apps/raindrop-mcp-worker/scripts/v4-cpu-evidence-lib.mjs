/* global AbortSignal, fetch, URL */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const WORKER_NAME = "raindrop-mcp-worker";
export const WORKER_URL = "https://raindrop-mcp-worker.aiyaya.workers.dev";
export const CPU_KEY = "$workers.cpuTimeMs";
export const RUN_HEADER = "x-raindrop-evidence-run";
export const OP_HEADER = "x-raindrop-evidence-op";
export const SAMPLE_HEADER = "x-raindrop-evidence-sample";
export const SAMPLE_WINDOWS = 3;
export const SAMPLES_PER_WINDOW = 10;

export const OPERATIONS = Object.freeze([
  Object.freeze({
    label: "initialize",
    method: "initialize",
    params: Object.freeze({
      protocolVersion: "2025-11-25",
      capabilities: Object.freeze({}),
      clientInfo: Object.freeze({
        name: "raindrop-v4-cpu-evidence",
        version: "1.0.0",
      }),
    }),
  }),
  Object.freeze({
    label: "tools_list",
    method: "tools/list",
    params: Object.freeze({}),
  }),
  Object.freeze({
    label: "diagnostics_read_local",
    method: "tools/call",
    params: Object.freeze({
      name: "diagnostics_read",
      arguments: Object.freeze({ action: "local" }),
    }),
  }),
  Object.freeze({
    label: "raindrop_read_list_1",
    method: "tools/call",
    params: Object.freeze({
      name: "raindrop_read",
      arguments: Object.freeze({
        action: "list",
        collectionId: 0,
        page: 0,
        perpage: 1,
      }),
    }),
  }),
]);

const SAFE_TAG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireSafeTag(value, name) {
  assert.equal(typeof value, "string", `${name} must be a string`);
  assert(SAFE_TAG.test(value), `${name} must match ${SAFE_TAG}`);
  return value;
}

export function requireSha(value, name = "source SHA") {
  assert.equal(typeof value, "string", `${name} must be a string`);
  assert(
    SHA.test(value),
    `${name} must be a lowercase full 40-character commit SHA`,
  );
  return value;
}

export function requireUuid(value, name) {
  assert.equal(typeof value, "string", `${name} must be a string`);
  assert(UUID.test(value), `${name} must be a UUID`);
  return value;
}

export function verifySourceIdentity(expected, actual, workflowSha, dirty) {
  requireSha(expected);
  requireSha(actual, "checked-out SHA");
  requireSha(workflowSha, "reviewed workflow SHA");
  assert.equal(actual, expected, "Checked-out commit does not match requested SHA");
  assert.equal(
    expected,
    workflowSha,
    "Requested source must equal the reviewed workflow SHA",
  );
  assert.equal(dirty, "", "Evidence source checkout must be clean");
  return actual;
}

export function assertProductionTarget(workerName, workerUrl) {
  assert.equal(
    workerName,
    WORKER_NAME,
    `Worker target must be exactly ${WORKER_NAME}`,
  );
  assert.equal(
    workerUrl,
    WORKER_URL,
    `Worker URL must be exactly ${WORKER_URL}`,
  );
  const url = new URL(workerUrl);
  assert.equal(
    url.protocol,
    "https:",
    "Production evidence URL must use HTTPS",
  );
  assert.equal(url.hostname, "raindrop-mcp-worker.aiyaya.workers.dev");
  assert.equal(url.port, "");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  return url;
}

export function buildSamplePlan() {
  const samples = [];
  for (const operation of OPERATIONS) {
    samples.push({
      ...operation,
      phase: "first",
      window: 0,
      ordinal: 1,
      sample: "first",
    });
  }
  for (let window = 1; window <= SAMPLE_WINDOWS; window += 1) {
    for (const operation of OPERATIONS) {
      for (let ordinal = 1; ordinal <= SAMPLES_PER_WINDOW; ordinal += 1) {
        samples.push({
          ...operation,
          phase: "window",
          window,
          ordinal,
          sample: `w${window}-${String(ordinal).padStart(2, "0")}`,
        });
      }
    }
  }
  return samples;
}

function deploymentList(payload) {
  assert.equal(
    payload?.success,
    true,
    "Cloudflare deployments API did not succeed",
  );
  assert.deepEqual(
    payload.errors ?? [],
    [],
    "Cloudflare deployments API returned errors",
  );
  const deployments = Array.isArray(payload.result)
    ? payload.result
    : payload.result?.deployments;
  assert(
    Array.isArray(deployments) && deployments.length > 0,
    "No Worker deployment was returned",
  );
  return deployments;
}

export function parseCurrentDeployment(payload) {
  // Cloudflare defines the first list item as the latest deployment actively
  // serving traffic. Do not infer active state by re-sorting deployment history.
  const deployment = deploymentList(payload)[0];
  const deploymentId = requireUuid(deployment.id, "deployment ID");
  const versions = deployment.versions;
  assert(Array.isArray(versions), "Deployment versions are missing");
  const active = versions.filter((entry) => Number(entry.percentage) > 0);
  assert.equal(
    active.length,
    1,
    "CPU evidence requires one unambiguous active Worker version",
  );
  assert.equal(
    Number(active[0].percentage),
    100,
    "CPU evidence requires the active version at 100%",
  );
  const versionId = requireUuid(
    active[0].version_id ?? active[0].versionId,
    "version ID",
  );
  return {
    deploymentId,
    versionId,
    createdAt: new Date(
      deployment.created_on ?? deployment.createdOn,
    ).toISOString(),
    message: deployment.annotations?.["workers/message"],
  };
}

export function verifyDeploymentProvenance(deployment, sourceSha) {
  requireSha(sourceSha);
  const message = deployment.message;
  assert.equal(
    typeof message,
    "string",
    "Active deployment is missing its source annotation",
  );
  assert.equal(
    message,
    `issue-129 source=${sourceSha}`,
    "Active deployment does not identify the immutable source SHA exactly",
  );
}

export function buildSnapshotRecord(payload, sourceSha) {
  const { message, ...current } = parseCurrentDeployment(payload);
  if (sourceSha === undefined) return current;
  requireSha(sourceSha);
  verifyDeploymentProvenance({ ...current, message }, sourceSha);
  return { sourceSha, ...current };
}

export function buildRollbackDeploymentRequest(versionId) {
  requireUuid(versionId, "rollback version ID");
  return {
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
    annotations: {
      "workers/message": `issue-129 automatic rollback version=${versionId}`,
    },
  };
}

export function assertRollbackState(current, rollback, sourceSha) {
  requireUuid(current.deploymentId, "current deployment ID");
  requireUuid(current.versionId, "current version ID");
  requireUuid(rollback.deploymentId, "rollback deployment ID");
  requireUuid(rollback.versionId, "rollback version ID");
  requireSha(sourceSha);
  if (current.versionId === rollback.versionId) return "already-restored";
  assert.equal(
    current.message,
    `issue-129 source=${sourceSha}`,
    "Refusing to overwrite an unrelated deployment during rollback",
  );
  return "restore";
}

export function sanitizeBlockedReason(value) {
  return String(value)
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

export function buildTelemetryQuery({ run, op, sample, versionId, from, to }) {
  requireSafeTag(run, "run");
  requireSafeTag(op, "operation");
  requireSafeTag(sample, "sample");
  requireUuid(versionId, "version ID");
  assert(
    Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to,
    "Invalid telemetry UTC window",
  );
  const filter = (key, value) => ({
    key,
    operation: "eq",
    type: "string",
    value,
  });
  return {
    queryId: `raindrop-v4-cpu-${run}-${op}-${sample}`,
    timeframe: { from, to },
    view: "events",
    limit: 2,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters: [
        filter("$metadata.service", WORKER_NAME),
        filter("$workers.scriptVersion.id", versionId),
        filter(`$workers.event.request.headers.${RUN_HEADER}`, run),
        filter(`$workers.event.request.headers.${OP_HEADER}`, op),
        filter(`$workers.event.request.headers.${SAMPLE_HEADER}`, sample),
        { key: CPU_KEY, operation: "exists", type: "number" },
      ],
    },
  };
}

export function buildTelemetryRunQuery({ run, versionId, from, to }) {
  requireSafeTag(run, "run");
  requireUuid(versionId, "version ID");
  assert(
    Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < to,
    "Invalid telemetry UTC window",
  );
  const filter = (key, value) => ({
    key,
    operation: "eq",
    type: "string",
    value,
  });
  return {
    queryId: `raindrop-v4-cpu-${run}`,
    timeframe: { from, to },
    view: "events",
    limit: 200,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters: [
        filter("$metadata.service", WORKER_NAME),
        filter("$workers.scriptVersion.id", versionId),
        filter(`$workers.event.request.headers.${RUN_HEADER}`, run),
        { key: CPU_KEY, operation: "exists", type: "number" },
      ],
    },
  };
}

function headerValue(headers, key) {
  assert(
    headers && typeof headers === "object" && !Array.isArray(headers),
    "Telemetry request headers are missing",
  );
  const match = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === key,
  );
  assert(match, `Telemetry is missing ${key}`);
  assert.equal(typeof match[1], "string", `Telemetry ${key} must be a string`);
  return match[1];
}

export function parseTelemetryEvent(payload, expected) {
  assert.equal(
    payload?.success,
    true,
    "Cloudflare telemetry query did not succeed",
  );
  assert.deepEqual(
    payload.errors ?? [],
    [],
    "Cloudflare telemetry query returned errors",
  );
  assert.equal(
    payload.result?.run?.status,
    "COMPLETED",
    "Cloudflare telemetry query did not complete",
  );
  const events = payload.result?.events?.events;
  assert(
    Array.isArray(events),
    "Cloudflare telemetry response has no event list",
  );
  assert.equal(
    events.length,
    1,
    "Telemetry must contain exactly one event for a sample",
  );
  const event = events[0];
  assert.equal(
    event?.$metadata?.service,
    WORKER_NAME,
    "Telemetry service mismatch",
  );
  assert.equal(
    event?.$workers?.scriptVersion?.id,
    expected.versionId,
    "Telemetry version mismatch",
  );
  const headers = event?.$workers?.event?.request?.headers;
  assert.equal(
    headerValue(headers, RUN_HEADER),
    expected.run,
    "Telemetry run mismatch",
  );
  assert.equal(
    headerValue(headers, OP_HEADER),
    expected.op,
    "Telemetry operation mismatch",
  );
  assert.equal(
    headerValue(headers, SAMPLE_HEADER),
    expected.sample,
    "Telemetry sample mismatch",
  );
  const cpuTimeMs = event?.$workers?.cpuTimeMs;
  assert.equal(
    typeof cpuTimeMs,
    "number",
    `Telemetry must include native ${CPU_KEY}`,
  );
  assert(
    Number.isFinite(cpuTimeMs) && cpuTimeMs >= 0,
    `Telemetry ${CPU_KEY} must be a non-negative finite number`,
  );
  const timestamp = event.timestamp;
  assert(
    Number.isInteger(timestamp) && timestamp >= 0,
    "Telemetry timestamp must be UTC epoch milliseconds",
  );
  const httpStatus =
    event?.$metadata?.statusCode ?? event?.$workers?.event?.response?.status;
  assert(
    Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599,
    "Telemetry HTTP status is missing",
  );
  assert.equal(
    httpStatus,
    expected.httpStatus,
    "Telemetry HTTP status mismatch",
  );
  return { utc: new Date(timestamp).toISOString(), cpuTimeMs, httpStatus };
}

export function parseTelemetryRun(payload, observations, expected) {
  const events = payload?.result?.events?.events;
  assert(Array.isArray(events), "Cloudflare telemetry response has no event list");
  return observations.map((observation) => {
    const matches = events.filter((event) => {
      const headers = event?.$workers?.event?.request?.headers;
      if (!headers || typeof headers !== "object") return false;
      const lower = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
      );
      return (
        lower[RUN_HEADER] === expected.run &&
        lower[OP_HEADER] === observation.op &&
        lower[SAMPLE_HEADER] === observation.sample
      );
    });
    const single = {
      ...payload,
      result: {
        ...payload.result,
        events: { ...payload.result.events, events: matches },
      },
    };
    return parseTelemetryEvent(single, {
      run: expected.run,
      op: observation.op,
      sample: observation.sample,
      versionId: expected.versionId,
      httpStatus: observation.httpStatus,
    });
  });
}

function matchingJsonRpc(text, contentType, id) {
  if (contentType.includes("text/event-stream")) {
    return text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          return null;
        }
      })
      .find((message) => message?.jsonrpc === "2.0" && message.id === id);
  }
  assert(
    contentType.includes("application/json"),
    "MCP response must be JSON or SSE",
  );
  const message = JSON.parse(text);
  return message?.jsonrpc === "2.0" && message.id === id ? message : undefined;
}

export async function invokeFixedOperation({
  baseUrl,
  token,
  run,
  sample,
  operation,
  fetchImpl = fetch,
}) {
  assertProductionTarget(WORKER_NAME, baseUrl);
  assert.equal(typeof token, "string", "MCP token is required");
  assert(token.length > 0 && !/[\r\n]/.test(token), "MCP token is invalid");
  requireSafeTag(run, "run");
  requireSafeTag(sample, "sample");
  assert(
    OPERATIONS.some((candidate) => candidate === operation),
    "Only fixed read-only evidence operations are allowed",
  );
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const response = await fetchImpl(new URL("/mcp", baseUrl), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      [RUN_HEADER]: run,
      [OP_HEADER]: operation.label,
      [SAMPLE_HEADER]: sample,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: operation.method,
      params: operation.params,
    }),
  });
  const text = await response.text();
  const endedAt = new Date().toISOString();
  assert.equal(
    response.status,
    200,
    `${operation.label}: unexpected HTTP ${response.status}`,
  );
  const payload = matchingJsonRpc(
    text,
    response.headers.get("content-type") ?? "",
    id,
  );
  assert(payload, `${operation.label}: no matching JSON-RPC response`);
  assert(
    !payload.error,
    `${operation.label}: JSON-RPC error ${payload.error?.code}`,
  );
  if (operation.label === "initialize") {
    assert(
      payload.result?.serverInfo,
      "initialize response is missing serverInfo",
    );
  } else if (operation.label === "tools_list") {
    const names = payload.result?.tools?.map((tool) => tool.name);
    assert(Array.isArray(names), "tools/list response is missing tools");
    assert(
      names.includes("diagnostics_read"),
      "Blocked: v4 diagnostics_read tracer is not deployed",
    );
    assert(
      names.includes("raindrop_read"),
      "Blocked: v4 raindrop_read tracer is not deployed",
    );
  } else {
    assert.equal(
      payload.result?.structuredContent?.ok,
      true,
      `${operation.label}: tool failed`,
    );
    if (operation.label === "raindrop_read_list_1") {
      const structured = payload.result.structuredContent;
      assert.equal(
        structured.meta?.perpage,
        1,
        "raindrop_read list did not preserve perpage=1",
      );
      assert(
        Array.isArray(structured.data?.items),
        "raindrop_read list result is missing items",
      );
      assert(
        structured.data.items.length <= 1,
        "raindrop_read list returned more than one item",
      );
    }
  }
  return {
    op: operation.label,
    sample,
    startedAt,
    endedAt,
    httpStatus: 200,
    jsonRpcStatus: "succeeded",
  };
}

export async function cloudflareJson({
  accountId,
  apiToken,
  path,
  method = "GET",
  body,
  fetchImpl = fetch,
}) {
  assert(
    /^[0-9a-f]{32}$/.test(accountId),
    "Cloudflare account ID must be 32 lowercase hexadecimal characters",
  );
  assert.equal(typeof apiToken, "string", "Cloudflare API token is required");
  assert(
    apiToken.length > 0 && !/[\r\n]/.test(apiToken),
    "Cloudflare API token is invalid",
  );
  assert(path.startsWith("/"), "Cloudflare API path must be absolute");
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const payload = await response.json();
  assert.equal(
    response.status,
    200,
    `Cloudflare API returned HTTP ${response.status}`,
  );
  return payload;
}
