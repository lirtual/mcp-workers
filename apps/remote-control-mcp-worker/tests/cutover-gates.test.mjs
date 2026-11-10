import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderAgentReleaseManifest, RELEASE_MANIFEST_NAME } from "../agent/scripts/agent-release-manifest.mjs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateCutover, requestProductionAction } from "../scripts/cutover-gates.mjs";

const COMMAND = fileURLToPath(new URL("../scripts/cutover-gates.mjs", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const TAG = "v0.2.0";
const MACOS_SCRIPT = "ab".repeat(32);
const PLATFORMS = [
  ["linux-x64-glibc", "ubuntu-24.04", ".tar.gz", "11"],
  ["linux-arm64-glibc", "ubuntu-24.04-arm", ".tar.gz", "22"],
  ["windows-x64", "windows-x64", ".zip", "33"],
  ["darwin-arm64", "darwin-arm64", ".tar.gz", "44"],
  ["darwin-x64", "darwin-x64", ".tar.gz", "55"],
];

function bundleFor(target) {
  const bundle = {
    name: "remote-control-agent",
    version: TAG,
    target,
    artifact_schema: 1,
    device_protocol: 2,
    upgrade_protocol: null,
  };
  if (target.startsWith("darwin-")) {
    return {
      ...bundle,
      receipt_schema: 1,
      candidate_profile: "darwin-permanent-local-v1",
      native_supervisor: "darwin-owned-group-v1",
      source_commit: SHA,
      upgrade_profile: null,
    };
  }
  if (target === "windows-x64") return { ...bundle, upgrade_profile: "paired-full-v1" };
  return { ...bundle, receipt_schema: 1, upgrade_profile: "paired-full-v1" };
}

function candidateFor([target, artifact, extension, digestByte]) {
  const sha256 = digestByte.repeat(32);
  return {
    target,
    artifact: `${TAG}-${artifact}`,
    name: `remote-control-agent-${TAG}-${target}${extension}`,
    sha256,
    observedSha256: sha256,
    size: 2048,
    bundle: bundleFor(target),
  };
}

function sourceAndCandidates() {
  return {
    gitCommit: { sha: SHA },
    ci: {
      workflow: ".github/workflows/agent-native-candidates.yml",
      conclusion: "success",
      headSha: SHA,
    },
    candidates: {
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      actor: "lirtual",
      deployWorker: false,
      releaseTag: TAG,
      sourceSha: SHA,
      immutableReleases: { enabled: true },
      existingRelease: false,
      existingTag: false,
      candidateRun: {
        event: "workflow_dispatch",
        path: ".github/workflows/agent-native-candidates.yml",
        head_branch: "main",
        head_sha: SHA,
        status: "completed",
        conclusion: "success",
      },
      macosScriptSha256: MACOS_SCRIPT,
      sourceMacosScriptSha256: MACOS_SCRIPT,
      candidates: PLATFORMS.map(candidateFor),
    },
    releasePermissions: { contents: "read", actions: "read", trigger: "workflow_dispatch" },
    immutability: { enabled: true },
  };
}

function state(report, name) {
  return report.states.find((item) => item.name === name);
}

test("a read-only fixture records source and CI without publishing, deploying, or upgrading", async () => {
  const report = await evaluateCutover({ fixture: sourceAndCandidates() });
  assert.equal(state(report, "git commit").status, "recorded");
  assert.equal(state(report, "CI").status, "passed");
  assert.equal(state(report, "Agent Release").status, "absent");
  assert.equal(state(report, "Worker deploy").status, "absent");
  assert.equal(state(report, "device run").status, "not-performed");
  assert.equal(report.evidence.sourceSha, SHA);
  assert.equal(report.evidence.ciConclusion, "success");
  assert.equal(report.evidence.candidates, "accepted");
  assert.deepEqual(report.evidence.releasePermissions, {
    contents: "read",
    actions: "read",
    trigger: "workflow_dispatch",
  });
  assert.equal(report.evidence.immutabilityEnabled, true);
  assert.deepEqual(report.performed, []);
  for (const action of ["publish-release", "deploy-worker", "upgrade-device"]) {
    assert.deepEqual(report.production[action], {
      allowed: false,
      performed: false,
      reason: "missing-authorization",
    });
  }
});

test("injected fetch supplies the four evidence documents and never writes", async () => {
  const fixture = sourceAndCandidates();
  const documents = {
    "https://evidence.test/source-ci.json": { gitCommit: fixture.gitCommit, ci: fixture.ci },
    "https://evidence.test/candidates.json": fixture.candidates,
    "https://evidence.test/permissions.json": fixture.releasePermissions,
    "https://evidence.test/immutability.json": fixture.immutability,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, redirect: init?.redirect });
    const body = documents[String(url)];
    if (!body || init?.method !== "GET") throw new Error("unexpected cutover fetch");
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const report = await evaluateCutover({
    fetch: fetchImpl,
    resources: {
      sourceCi: "https://evidence.test/source-ci.json",
      candidates: "https://evidence.test/candidates.json",
      releasePermissions: "https://evidence.test/permissions.json",
      immutability: "https://evidence.test/immutability.json",
    },
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual", "manual", "manual"]);
  assert.equal(state(report, "git commit").status, "recorded");
  assert.equal(state(report, "CI").status, "passed");
  assert.equal(state(report, "Agent Release").status, "absent");
  assert.equal(report.evidence.candidates, "accepted");
  assert.deepEqual(report.performed, []);
});

test("a git commit is not CI, and CI is not an Agent Release or a Worker deploy", async () => {
  const commitOnly = await evaluateCutover({ fixture: { gitCommit: { sha: SHA } } });
  assert.equal(state(commitOnly, "git commit").status, "recorded");
  assert.equal(state(commitOnly, "CI").status, "absent");
  assert.equal(state(commitOnly, "Agent Release").status, "absent");
  assert.equal(state(commitOnly, "Worker deploy").status, "absent");
  assert.equal(state(commitOnly, "device run").status, "not-performed");

  const ci = sourceAndCandidates();
  const report = await evaluateCutover({ fixture: ci });
  assert.equal(state(report, "CI").status, "passed");
  assert.notEqual(state(report, "Agent Release").status, "passed");
  assert.notEqual(state(report, "Worker deploy").status, "passed");
  assert.notEqual(state(report, "device run").status, "passed");
});

test("disabled immutability blocks candidate acceptance and still publishes nothing", async () => {
  const fixture = sourceAndCandidates();
  fixture.immutability = { enabled: false };
  fixture.candidates.immutableReleases = { enabled: true };
  fixture.releasePermissions = { contents: "write", actions: "read", trigger: "workflow_dispatch" };
  const report = await evaluateCutover({ fixture });
  assert.equal(report.evidence.immutabilityEnabled, false);
  assert.equal(report.evidence.candidates, "blocked");
  assert.equal(report.evidence.candidateBlock, "immutable releases are not enabled");
  assert.equal(state(report, "Agent Release").status, "absent");
  assert.equal(report.production["publish-release"].performed, false);
  assert.equal(report.production["publish-release"].reason, "missing-authorization");
});

test("an explicit authorization still does not publish, deploy, or upgrade", () => {
  const authorization = {
    "publish-release": { decision: "authorized", scope: "agent-release" },
    "deploy-worker": { decision: "authorized", scope: "worker" },
    "upgrade-device": { decision: "authorized", scope: "paired-devices" },
  };
  for (const action of Object.keys(authorization)) {
    assert.deepEqual(requestProductionAction(action, authorization), {
      allowed: true,
      performed: false,
      reason: "not-performed-by-this-command",
    });
  }
  const ran = spawnSync(process.execPath, [COMMAND], {
    input: JSON.stringify({ authorization }),
    encoding: "utf8",
  });
  const report = JSON.parse(ran.stdout);
  assert.equal(ran.status, 0);
  assert.deepEqual(report.performed, []);
  assert.equal(report.production["deploy-worker"].performed, false);
});

function releaseReadback() {
  const input = sourceAndCandidates().candidates;
  const expected = input.candidates.map(({ name, sha256, size }) => ({ name, sha256, size }));
  const manifest = renderAgentReleaseManifest(TAG, expected);
  const digest = createHash('sha256').update(manifest).digest('hex');
  return {
    releaseTag: TAG,
    sourceSha: SHA,
    expectedAssets: expected,
    downloaded: [
      ...expected.map((a) => ({ ...a })),
      { name: RELEASE_MANIFEST_NAME, sha256: digest, size: Buffer.byteLength(manifest) },
    ],
    manifest,
    manifestSha256: digest,
    release: {
      tag_name: TAG, draft: false, prerelease: false, immutable: true,
      assets: [
        ...expected.map(({ name, sha256, size }) => ({
          name, size, state: 'uploaded', digest: 'sha256:' + sha256,
        })),
        {
          name: RELEASE_MANIFEST_NAME, size: Buffer.byteLength(manifest),
          state: 'uploaded', digest: 'sha256:' + digest,
          browser_download_url:
            'https://github.com/lirtual/mcp-workers/releases/download/' + TAG + '/' + RELEASE_MANIFEST_NAME,
        },
      ],
    },
    latest: { tag_name: TAG, draft: false, prerelease: false, immutable: true },
    tag: { object: { type: 'commit', sha: SHA } },
  };
}

test("a release that is not latest blocks worker cutover and is not a deploy", async () => {
  const fixture = sourceAndCandidates();
  fixture.releaseReadback = releaseReadback();
  fixture.releaseReadback.latest = { ...fixture.releaseReadback.latest, tag_name: "v0.1.51" };
  fixture.workerDeploy = {
    deployed: true,
    installers: ["/install.sh", "/install.ps1", "/install-macos.sh"],
  };
  const report = await evaluateCutover({ fixture });
  assert.equal(state(report, "CI").status, "passed");
  assert.equal(state(report, "Agent Release").status, "blocked");
  assert.equal(state(report, "Worker deploy").status, "blocked");
  assert.equal(report.workerCutover, "blocked");
  assert.equal(report.evidence.releaseBlock, "Release is not an immutable stable Latest");
  assert.deepEqual(report.performed, []);
});

test("a wrong asset digest or asset count blocks worker cutover", async () => {
  const badDigest = sourceAndCandidates();
  badDigest.releaseReadback = releaseReadback();
  badDigest.releaseReadback.downloaded = badDigest.releaseReadback.downloaded.map((item, index) => (
    index === 0 ? { ...item, sha256: "99".repeat(32) } : item
  ));
  const digestReport = await evaluateCutover({ fixture: badDigest });
  assert.equal(digestReport.workerCutover, "blocked");
  assert.equal(state(digestReport, "Agent Release").status, "blocked");
  assert.equal(digestReport.evidence.releaseBlock, "damaged native candidate");

  const badCount = sourceAndCandidates();
  badCount.releaseReadback = releaseReadback();
  badCount.releaseReadback.release = {
    ...badCount.releaseReadback.release,
    assets: badCount.releaseReadback.release.assets.slice(0, 4),
  };
  const countReport = await evaluateCutover({ fixture: badCount });
  assert.equal(countReport.workerCutover, "blocked");
  assert.equal(state(countReport, "Worker deploy").status, "blocked");
  assert.equal(countReport.evidence.releaseBlock, "partial native Release");
});

test("a verified latest release does not count as a worker deploy or a device run", async () => {
  const fixture = sourceAndCandidates();
  fixture.releaseReadback = releaseReadback();
  const report = await evaluateCutover({ fixture });
  assert.equal(state(report, "Agent Release").status, "passed");
  assert.equal(state(report, "Worker deploy").status, "absent");
  assert.equal(state(report, "device run").status, "not-performed");
  assert.equal(report.workerCutover, "withheld");
  assert.deepEqual(report.performed, []);
});

const DIGESTS = {
  "linux-x64-glibc": "11".repeat(32),
  "linux-arm64-glibc": "22".repeat(32),
  "windows-x64": "33".repeat(32),
  "darwin-arm64": "44".repeat(32),
  "darwin-x64": "55".repeat(32),
};
const RELEASE_TAG = "v1.4.0";

function latestAsset(target, ext, id) {
  const name = `remote-control-agent-${RELEASE_TAG}-${target}${ext}`;
  return {
    id,
    name,
    state: "uploaded",
    size: 2000,
    digest: `sha256:${DIGESTS[target]}`,
    browser_download_url: `https://github.com/lirtual/mcp-workers/releases/download/${RELEASE_TAG}/${name}`,
  };
}

function latestBody(patch = {}) {
  const targets = [
    ["linux-x64-glibc", ".tar.gz"],
    ["linux-arm64-glibc", ".tar.gz"],
    ["windows-x64", ".zip"],
    ["darwin-arm64", ".tar.gz"],
    ["darwin-x64", ".tar.gz"],
  ];
  return {
    tag_name: RELEASE_TAG,
    draft: false,
    prerelease: false,
    immutable: true,
    assets: targets.map(([target, ext], index) => latestAsset(target, ext, 11 + index)),
    ...patch,
  };
}

test("installer 404, bad digest, and wrong product fail closed without touching devices", async () => {
  const devices = Object.freeze([
    Object.freeze({ deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", privateKeyPresent: true }),
    Object.freeze({ deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", privateKeyPresent: true }),
  ]);
  const badDigest = latestBody();
  badDigest.assets = badDigest.assets.map((item, index) => (
    index === 0 ? { ...item, digest: "sha256:abcd" } : item
  ));
  const wrongProduct = {
    ...latestBody(),
    assets: [{
      id: 1,
      name: "browser-extension-v1.4.0.zip",
      state: "uploaded",
      size: 2000,
      digest: `sha256:${"ab".repeat(32)}`,
      browser_download_url: "https://github.com/lirtual/mcp-workers/releases/download/v1.4.0/browser-extension-v1.4.0.zip",
    }],
  };
  const fixture = sourceAndCandidates();
  fixture.devices = devices;
  fixture.installerLookups = [
    { name: "404", status: 404, body: { message: "Not Found" } },
    { name: "bad digest", status: 200, body: badDigest },
    { name: "wrong product", status: 200, body: wrongProduct },
    { name: "selected", status: 200, body: latestBody() },
  ];
  const report = await evaluateCutover({ fixture });
  assert.deepEqual(report.installer.map((item) => [item.name, item.outcome, item.stop, item.httpStatus]), [
    ["404", "fail-closed", "not_found", 503],
    ["bad digest", "fail-closed", "rejected", 503],
    ["wrong product", "fail-closed", "rejected", 503],
    ["selected", "selected", null, null],
  ]);
  assert.match(report.installer[0].body, /No stable Agent Release is published/);
  assert.match(report.installer[1].body, /Stable Agent Release is not usable/);
  assert.match(report.installer[2].body, /Stable Agent Release is not usable/);
  assert.equal(report.installer[3].tag, "v1.4.0");
  for (const item of report.installer) {
    assert.equal(item.deviceMutation, false);
    assert.doesNotMatch(item.body ?? "", /^#!/);
  }
  assert.equal(report.deviceMutation, false);
  assert.deepEqual(report.devices, devices);
  assert.deepEqual(report.performed, []);
});

test("a blocked device stays blocked alone and does not clear another device", async () => {
  const blocked = {
    deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    version: "v0.1.51",
    privateKeyPresent: true,
    grant: "permanent",
    ownerStopped: true,
    unknownOperationId: "unknown-op-1",
    upgradeResult: "unknown",
    blocked: true,
  };
  const other = {
    deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    version: "v0.1.51",
    privateKeyPresent: true,
    grant: "permanent",
    ownerStopped: true,
    unknownOperationId: null,
    blocked: false,
  };
  const fixture = sourceAndCandidates();
  fixture.releaseReadback = releaseReadback();
  fixture.devices = [blocked, other];
  const report = await evaluateCutover({ fixture });
  assert.equal(report.devices[0].action, "isolate");
  assert.equal(report.devices[0].deviceId, blocked.deviceId);
  assert.equal(report.devices[0].privateKeyPreserved, true);
  assert.equal(report.devices[0].rePair, false);
  assert.equal(report.devices[0].replayUnknownOperationId, null);
  assert.equal(report.devices[0].startAgent, false);
  assert.equal(report.devices[0].ownerStopped, true);
  assert.equal(report.devices[1].action, "unchanged");
  assert.equal(report.devices[1].deviceId, other.deviceId);
  assert.equal(report.devices[1].privateKeyPresent, true);
  assert.equal(report.devices[1].grant, "permanent");
  assert.equal(report.devices[1].ownerStopped, true);
  assert.equal(report.devices[1].replayUnknownOperationId, null);
  assert.equal(report.devices[1].reset, false);
  assert.deepEqual(fixture.devices, [blocked, other]);
  assert.equal(report.deviceMutation, false);
});

test("Linux ARM64 and macOS Intel physical acceptance stay Not performed, never Pass", async () => {
  const claimed = sourceAndCandidates();
  claimed.physicalAcceptance = [
    { architecture: "linux-arm64", evidenceKind: "physical", result: "Pass" },
    { architecture: "macos-intel", evidenceKind: "ci", result: "Pass" },
    { architecture: "linux-x64", evidenceKind: "waived", result: "Pass" },
    { architecture: "windows-x64", evidenceKind: "ci", result: "Pass" },
  ];
  const report = await evaluateCutover({ fixture: claimed });
  assert.deepEqual(report.physicalAcceptance, [
    { architecture: "linux-arm64", status: "Not performed" },
    { architecture: "macos-intel", status: "Not performed" },
    { architecture: "linux-x64", status: "Waived" },
    { architecture: "windows-x64", status: "Not performed" },
  ]);
  assert.equal(JSON.stringify(report.physicalAcceptance).includes("Pass"), false);
  assert.equal(state(report, "CI").status, "passed");
  assert.equal(state(report, "device run").status, "not-performed");

  const bare = await evaluateCutover({ fixture: sourceAndCandidates() });
  assert.deepEqual(bare.physicalAcceptance, [
    { architecture: "linux-arm64", status: "Not performed" },
    { architecture: "macos-intel", status: "Not performed" },
  ]);

  const physical = sourceAndCandidates();
  physical.releaseReadback = releaseReadback();
  physical.workerDeploy = {
    deployed: true,
    installers: ["/install.sh", "/install.ps1", "/install-macos.sh"],
  };
  physical.physicalAcceptance = [
    { architecture: "windows-x64", evidenceKind: "physical", result: "Pass" },
    { architecture: "linux-arm64", evidenceKind: "waived" },
  ];
  const recorded = await evaluateCutover({ fixture: physical });
  assert.deepEqual(recorded.physicalAcceptance, [
    { architecture: "linux-arm64", status: "Not performed" },
    { architecture: "macos-intel", status: "Not performed" },
    { architecture: "windows-x64", status: "Pass" },
  ]);
  assert.equal(state(recorded, "Worker deploy").status, "passed");
  assert.equal(state(recorded, "device run").status, "passed");
  assert.equal(recorded.production["upgrade-device"].performed, false);
  assert.deepEqual(recorded.performed, []);

  const deviceOnly = sourceAndCandidates();
  deviceOnly.physicalAcceptance = [
    { architecture: "windows-x64", evidenceKind: "physical", result: "Pass" },
  ];
  const deviceReport = await evaluateCutover({ fixture: deviceOnly });
  assert.equal(state(deviceReport, "device run").status, "passed");
  assert.equal(state(deviceReport, "Agent Release").status, "absent");
  assert.equal(state(deviceReport, "Worker deploy").status, "absent");
});

test("a worker deploy claim without a verified release does not pass either state", async () => {
  const fixture = sourceAndCandidates();
  fixture.workerDeploy = {
    deployed: true,
    installers: ["/install.sh", "/install.ps1", "/install-macos.sh"],
  };
  const report = await evaluateCutover({ fixture });
  assert.equal(state(report, "Agent Release").status, "absent");
  assert.equal(state(report, "Worker deploy").status, "blocked");
  assert.equal(state(report, "device run").status, "not-performed");
  assert.equal(report.workerCutover, "blocked");
  assert.equal(report.production["deploy-worker"].performed, false);
});

test("requesting a production action exits without performing it", () => {
  const missing = spawnSync(process.execPath, [COMMAND, "publish-release"], {
    input: JSON.stringify({ gitCommit: { sha: SHA } }),
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout), {
    allowed: false,
    performed: false,
    reason: "missing-authorization",
  });
  const acknowledged = spawnSync(process.execPath, [COMMAND, "upgrade-device"], {
    input: JSON.stringify({
      authorization: { "upgrade-device": { decision: "authorized", scope: "paired-devices" } },
    }),
    encoding: "utf8",
  });
  assert.equal(acknowledged.status, 1);
  assert.deepEqual(JSON.parse(acknowledged.stdout), {
    allowed: true,
    performed: false,
    reason: "not-performed-by-this-command",
  });
});
