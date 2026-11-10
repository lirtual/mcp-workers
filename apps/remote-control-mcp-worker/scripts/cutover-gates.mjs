import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./register-ps1-text.mjs";
import { acceptAgentReleaseReadback, reviewAgentPublication } from "../agent/scripts/agent-release-guard.mjs";
import { planInstalledWindowsTakeover } from "../agent/src/windows-installed-takeover.ts";
import { selectLatestAgentRelease } from "../src/github-latest-agent-release.ts";

const { macInstallFailure } = await import("../src/install-macos-latest.ts");

const SHA = /^[a-f0-9]{40}$/;
const ACTIONS = ["publish-release", "deploy-worker", "upgrade-device"];
const RESOURCE_KEYS = ["sourceCi", "candidates", "releasePermissions", "immutability"];

async function readEvidence(input) {
  if (input.fixture) return input.fixture;
  const resources = input.resources ?? {};
  const loaded = {};
  for (const key of RESOURCE_KEYS) {
    const url = resources[key];
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error("cutover evidence URL missing");
    }
    const response = await input.fetch(url, { method: "GET", redirect: "manual" });
    if (response.status !== 200) throw new Error("cutover evidence unavailable");
    loaded[key] = await response.json();
  }
  return {
    gitCommit: loaded.sourceCi.gitCommit,
    ci: loaded.sourceCi.ci,
    candidates: loaded.candidates,
    releasePermissions: loaded.releasePermissions,
    immutability: loaded.immutability,
    authorization: loaded.sourceCi.authorization,
  };
}

function state(name, status) {
  return { name, status };
}

export function requestProductionAction(action, authorization) {
  const record = authorization?.[action];
  const explicit = record?.decision === "authorized"
    && typeof record.scope === "string"
    && record.scope.length > 0;
  if (!ACTIONS.includes(action) || !explicit) {
    return { allowed: false, performed: false, reason: "missing-authorization" };
  }
  return { allowed: true, performed: false, reason: "not-performed-by-this-command" };
}

function classifyStates(fixture) {
  const sha = fixture.gitCommit?.sha;
  const commitRecorded = typeof sha === "string" && SHA.test(sha);
  const ci = fixture.ci;
  const ciPassed = commitRecorded
    && ci?.conclusion === "success"
    && ci.headSha === sha
    && typeof ci.workflow === "string"
    && ci.workflow.length > 0;
  const ciFailed = !!ci && !ciPassed && (ci.conclusion || ci.workflow || ci.headSha);
  return [
    state("git commit", commitRecorded ? "recorded" : "absent"),
    state("CI", ciPassed ? "passed" : ciFailed ? "failed" : "absent"),
    state("Agent Release", "absent"),
    state("Worker deploy", "absent"),
    state("device run", "not-performed"),
  ];
}

const INSTALLERS = ["/install.sh", "/install.ps1", "/install-macos.sh"];
const SESSION_NOT_PERFORMED = [
  { architecture: "linux-arm64", status: "Not performed" },
  { architecture: "macos-intel", status: "Not performed" },
];

function classifyPhysical(fixture) {
  const extra = [];
  for (const entry of fixture.physicalAcceptance ?? []) {
    if (entry?.architecture === "linux-arm64" || entry?.architecture === "macos-intel") continue;
    let status = "Not performed";
    if (entry?.evidenceKind === "waived") status = "Waived";
    else if (entry?.evidenceKind === "physical" && entry.result === "Pass") status = "Pass";
    extra.push({ architecture: entry.architecture, status });
  }
  return [...SESSION_NOT_PERFORMED, ...extra];
}

function classifyRelease(fixture) {
  if (!fixture.releaseReadback) return { status: "absent", block: null };
  try {
    acceptAgentReleaseReadback(fixture.releaseReadback);
    return { status: "passed", block: null };
  } catch (error) {
    return { status: "blocked", block: error.message };
  }
}

function classifyWorker(fixture, release) {
  if (release.status === "blocked") return { status: "blocked", workerCutover: "blocked" };
  const worker = fixture.workerDeploy;
  if (!worker) return { status: "absent", workerCutover: "withheld" };
  const installers = Array.isArray(worker.installers) ? worker.installers : [];
  const complete = worker.deployed === true && INSTALLERS.every((item) => installers.includes(item));
  if (release.status === "passed" && complete) return { status: "passed", workerCutover: "withheld" };
  return { status: "blocked", workerCutover: "blocked" };
}

export async function reviewInstallerLookup(lookup) {
  const decision = selectLatestAgentRelease({
    status: lookup.status,
    body: lookup.body,
    retryAfter: lookup.retryAfter ?? null,
  });
  if (decision.ok) {
    return {
      name: lookup.name,
      outcome: "selected",
      stop: null,
      tag: decision.release.tag,
      httpStatus: null,
      body: null,
      deviceMutation: false,
    };
  }
  const response = macInstallFailure(decision);
  return {
    name: lookup.name,
    outcome: "fail-closed",
    stop: decision.stop,
    tag: null,
    httpStatus: response.status,
    body: await response.text(),
    deviceMutation: false,
  };
}

function reviewDevices(devices, releaseTag) {
  const records = Array.isArray(devices) ? devices : [];
  if (!records.some((device) => Object.hasOwn(device, "blocked"))) {
    return records.map((device) => ({ ...device }));
  }
  return records.map((device) => {
    if (device.blocked !== true) {
      return { ...device, action: "unchanged", replayUnknownOperationId: null, reset: false };
    }
    const plan = planInstalledWindowsTakeover({
      version: device.version,
      deviceId: device.deviceId,
      privateKeyPresent: device.privateKeyPresent,
      grant: device.grant,
      ownerStopped: device.ownerStopped,
      unknownOperationId: device.unknownOperationId,
      upgradeResult: device.upgradeResult,
    }, releaseTag);
    return {
      ...device,
      action: plan.action,
      deviceId: plan.deviceId,
      grant: plan.grant,
      ownerStopped: plan.ownerStopped,
      privateKeyPreserved: plan.privateKeyPreserved,
      startAgent: plan.startAgent,
      rePair: plan.rePair,
      replayUnknownOperationId: plan.replayUnknownOperationId,
      reset: false,
    };
  });
}

function classifyCandidates(fixture) {
  const immutabilityEnabled = fixture.immutability?.enabled === true;
  try {
    reviewAgentPublication({
      ...fixture.candidates,
      immutableReleases: fixture.immutability,
    });
    return { candidates: "accepted", immutabilityEnabled };
  } catch (error) {
    return { candidates: "blocked", candidateBlock: error.message, immutabilityEnabled };
  }
}

export async function evaluateCutover(input) {
  const fixture = await readEvidence(input);
  const candidates = classifyCandidates(fixture);
  const release = classifyRelease(fixture);
  const worker = classifyWorker(fixture, release);
  const physicalAcceptance = classifyPhysical(fixture);
  const states = classifyStates(fixture);
  states[2] = state("Agent Release", release.status);
  states[3] = state("Worker deploy", worker.status);
  if (physicalAcceptance.some((item) => item.status === "Pass")) {
    states[4] = state("device run", "passed");
  }
  const production = {};
  for (const action of ACTIONS) {
    production[action] = requestProductionAction(action, fixture.authorization);
  }
  const lookups = Array.isArray(fixture.installerLookups) ? fixture.installerLookups : [];
  const installer = [];
  for (const lookup of lookups) installer.push(await reviewInstallerLookup(lookup));
  return {
    states,
    evidence: {
      sourceSha: fixture.gitCommit?.sha ?? null,
      ciConclusion: fixture.ci?.conclusion ?? null,
      candidates: candidates.candidates,
      candidateBlock: candidates.candidateBlock ?? null,
      releasePermissions: fixture.releasePermissions ?? null,
      immutabilityEnabled: candidates.immutabilityEnabled,
      releaseBlock: release.block,
    },
    workerCutover: worker.workerCutover,
    physicalAcceptance,
    installer,
    devices: reviewDevices(
      fixture.devices,
      fixture.releaseReadback?.releaseTag ?? fixture.candidates?.releaseTag ?? "v0.0.0",
    ),
    deviceMutation: false,
    production,
    performed: [],
  };
}

function main() {
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("cutover fixture is unreadable\n");
    process.exit(1);
  }
  const action = process.argv[2];
  if (action) {
    const result = requestProductionAction(action, fixture.authorization);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.performed === true ? 0 : 1);
  }
  evaluateCutover({ fixture }).then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
