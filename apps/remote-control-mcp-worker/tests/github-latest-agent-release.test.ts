import assert from "node:assert/strict";
import test from "node:test";
import {
  LatestAgentReleaseError,
  planInstalledWindowsTakeover,
  selectLatestAgentRelease,
  verifyDownloadedWindowsAsset,
  windowsExtractPathAllowed,
} from "../src/github-latest-agent-release.ts";

const LATEST = "https://api.github.com/repos/lirtual/mcp-workers/releases/latest";
const TAG = "v0.2.0";
const SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIZE = 12345678;
const WINDOWS_SHA = "8e527193e30f66d04ad8a6f13d97f4d577a00dec5a936ccb968ea06ac332399f";
const DEVICE = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_OP = "6f0c2a1e-7b3d-4e1a-9c2f-0a1b2c3d4e5f";

const TARGETS: ReadonlyArray<readonly [string, string]> = [
  ["linux-x64-glibc", "tar.gz"],
  ["linux-arm64-glibc", "tar.gz"],
  ["windows-x64", "zip"],
  ["darwin-arm64", "tar.gz"],
  ["darwin-x64", "tar.gz"],
];

function asset(target: string, ext: string, patch: Record<string, unknown> = {}) {
  const name = `remote-control-agent-${TAG}-${target}.${ext}`;
  return {
    name,
    state: "uploaded",
    size: SIZE,
    digest: `sha256:${SHA}`,
    browser_download_url: `https://github.com/lirtual/mcp-workers/releases/download/${TAG}/${name}`,
    ...patch,
  };
}

function release(patch: Record<string, unknown> = {}, assets = TARGETS.map(([target, ext]) => asset(target, ext))) {
  return {
    tag_name: TAG,
    draft: false,
    prerelease: false,
    immutable: true,
    assets,
    ...patch,
  };
}

function github(status: number, body: unknown, headers: Record<string, string> = {}): {
  fetch: typeof fetch;
  calls: Request[];
} {
  const calls: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    if (calls.length > 1) throw new Error("latest lookup raced");
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  return { fetch: fetchImpl, calls };
}

test("one latest snapshot selects the Windows asset from a stable immutable five-platform Agent Release", async () => {
  const fake = github(200, release());
  const snapshot = await selectLatestAgentRelease({ fetch: fake.fetch });
  assert.equal(fake.calls.length, 1);
  const request = fake.calls[0];
  assert.ok(request);
  assert.equal(request.method, "GET");
  assert.equal(request.url, LATEST);
  assert.equal(request.redirect, "manual");
  assert.equal(snapshot.repository, "lirtual/mcp-workers");
  assert.equal(snapshot.tag, TAG);
  assert.equal(snapshot.draft, false);
  assert.equal(snapshot.prerelease, false);
  assert.equal(snapshot.immutable, true);
  assert.equal(snapshot.identity, "remote-control-agent");
  assert.equal(snapshot.maxRedirects, 3);
  assert.deepEqual(snapshot.allowedRedirectHosts, [
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
  ]);
  assert.deepEqual(snapshot.sizeBounds, { min: 100_000, max: 100_000_000 });
  assert.deepEqual(snapshot.assets.map((item) => item.target), TARGETS.map(([target]) => target));
  assert.equal(snapshot.windows, snapshot.assets[2]);
  assert.equal(snapshot.windows.target, "windows-x64");
  assert.equal(snapshot.windows.architecture, "x64");
  assert.equal(snapshot.windows.name, "remote-control-agent-v0.2.0-windows-x64.zip");
  assert.equal(snapshot.windows.sha256, SHA);
  assert.equal(snapshot.windows.size, SIZE);
  assert.equal(snapshot.windows.url,
    "https://github.com/lirtual/mcp-workers/releases/download/v0.2.0/remote-control-agent-v0.2.0-windows-x64.zip");
  assert.equal(windowsExtractPathAllowed("bin/node.exe"), true);
  assert.equal(windowsExtractPathAllowed("bin/rca-background.exe"), true);
  assert.equal(windowsExtractPathAllowed("apps/remote-control-agent/scripts/windows-user-task.ps1"), true);
  assert.equal(windowsExtractPathAllowed("apps/remote-control-agent/scripts/windows-upgrade-once.ps1"), true);
  assert.equal(windowsExtractPathAllowed("../bin/node.exe"), false);
  assert.equal(windowsExtractPathAllowed("bin/node.exe/../../outside.txt"), false);
  assert.equal(windowsExtractPathAllowed("/bin/node.exe"), false);
  assert.equal(windowsExtractPathAllowed("apps/remote-control-agent/scripts/evil.ps1"), false);
});

test("latest lookup stops on 404, 403, 429, redirects, and a bad Agent manifest", async () => {
  for (const [status, code] of [[404, "not_found"], [403, "forbidden"], [429, "rate_limited"]] as const) {
    const fake = github(status, { message: "no" });
    await assert.rejects(selectLatestAgentRelease({ fetch: fake.fetch }), (error: unknown) => {
      assert.ok(error instanceof LatestAgentReleaseError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes("remote-control-agent"), false);
      assert.equal(fake.calls.length, 1);
      return true;
    });
  }
  const redirected = github(302, "", { location: "https://evil.example/payload" });
  await assert.rejects(selectLatestAgentRelease({ fetch: redirected.fetch }), (error: unknown) => {
    assert.ok(error instanceof LatestAgentReleaseError);
    assert.equal(error.code, "untrusted");
    assert.equal(redirected.calls.length, 1);
    return true;
  });
  const cases: Array<[unknown, string]> = [
    [release({ prerelease: true }), "untrusted"],
    [release({ draft: true }), "untrusted"],
    [release({ immutable: false }), "untrusted"],
    [release({}, TARGETS.filter(([target]) => target !== "windows-x64").map(([target, ext]) => asset(target, ext))), "wrong_platform"],
    [release({}, TARGETS.filter(([target]) => target !== "darwin-x64").map(([target, ext]) => asset(target, ext))), "incomplete"],
    [release({}, [...TARGETS.map(([target, ext]) => asset(target, ext)), asset("windows-x64", "zip")]), "untrusted"],
    [release({}, TARGETS.map(([target, ext]) => target === "windows-x64"
      ? asset(target, ext, { digest: "sha256:not-a-digest" })
      : asset(target, ext))), "corrupt"],
    [release({}, TARGETS.map(([target, ext]) => target === "windows-x64"
      ? asset(target, ext, { browser_download_url: "https://github.com/lirtual/remote-control-agent/releases/download/v0.2.0/remote-control-agent-v0.2.0-windows-x64.zip" })
      : asset(target, ext))), "untrusted"],
  ];
  for (const [body, code] of cases) {
    const fake = github(200, body);
    await assert.rejects(selectLatestAgentRelease({ fetch: fake.fetch }), (error: unknown) => {
      assert.ok(error instanceof LatestAgentReleaseError);
      assert.equal(error.code, code, JSON.stringify(body).slice(0, 120));
      assert.equal(fake.calls.length, 1);
      return true;
    });
  }
});

test("downloaded Windows bytes must match the official size and SHA-256", async () => {
  const bytes = new TextEncoder().encode("windows-asset");
  await verifyDownloadedWindowsAsset({ sha256: WINDOWS_SHA, size: 13 }, bytes);
  await assert.rejects(verifyDownloadedWindowsAsset({ sha256: SHA, size: 13 }, bytes), (error: unknown) => {
    assert.ok(error instanceof LatestAgentReleaseError);
    assert.equal(error.code, "corrupt");
    return true;
  });
  await assert.rejects(verifyDownloadedWindowsAsset({ sha256: WINDOWS_SHA, size: 12 }, bytes), (error: unknown) => {
    assert.ok(error instanceof LatestAgentReleaseError);
    assert.equal(error.code, "corrupt");
    return true;
  });
});

test("v0.1.51 paired Windows state keeps device id, key, permanent grant, and Owner Stop", () => {
  const stopped = planInstalledWindowsTakeover({
    version: "v0.1.51",
    deviceId: DEVICE,
    privateKeyPresent: true,
    grant: "permanent",
    ownerStopped: true,
    unknownOperationId: UNKNOWN_OP,
  }, TAG);
  assert.equal(stopped.action, "upgrade");
  assert.equal(stopped.deviceId, DEVICE);
  assert.equal(stopped.grant, "permanent");
  assert.equal(stopped.ownerStopped, true);
  assert.equal(stopped.privateKeyPreserved, true);
  assert.equal(stopped.startAgent, false);
  assert.equal(stopped.rePair, false);
  assert.equal(stopped.replayUnknownOperationId, null);

  const reconnect = planInstalledWindowsTakeover({
    version: "v0.1.51",
    deviceId: DEVICE,
    privateKeyPresent: true,
    grant: "permanent",
    ownerStopped: false,
    unknownOperationId: UNKNOWN_OP,
  }, TAG);
  assert.equal(reconnect.action, "upgrade");
  assert.equal(reconnect.startAgent, true);
  assert.equal(reconnect.rePair, false);
  assert.equal(reconnect.deviceId, DEVICE);
  assert.equal(reconnect.replayUnknownOperationId, null);

  const unknown = planInstalledWindowsTakeover({
    version: "v0.1.51",
    deviceId: DEVICE,
    privateKeyPresent: true,
    grant: "permanent",
    ownerStopped: true,
    unknownOperationId: UNKNOWN_OP,
    upgradeResult: "unknown",
  }, TAG);
  assert.equal(unknown.action, "isolate");
  assert.equal(unknown.startAgent, false);
  assert.equal(unknown.rePair, false);
  assert.equal(unknown.deviceId, DEVICE);
  assert.equal(unknown.replayUnknownOperationId, null);

  const partial = planInstalledWindowsTakeover({
    version: "v0.1.51",
    deviceId: DEVICE,
    privateKeyPresent: true,
    grant: "permanent",
    ownerStopped: false,
    unknownOperationId: null,
    upgradeResult: "partial",
  }, TAG);
  assert.equal(partial.action, "isolate");
  assert.equal(partial.startAgent, false);
  assert.equal(partial.rePair, false);
  assert.equal(partial.replayUnknownOperationId, null);

  const same = planInstalledWindowsTakeover({
    version: "v0.1.51",
    deviceId: DEVICE,
    privateKeyPresent: true,
    grant: "permanent",
    ownerStopped: false,
    unknownOperationId: null,
  }, "v0.1.51");
  assert.equal(same.action, "refuse");
  assert.equal(same.startAgent, false);
  assert.equal(same.rePair, false);
});
