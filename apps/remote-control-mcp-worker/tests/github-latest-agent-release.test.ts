import assert from "node:assert/strict";
import test from "node:test";
import {
  readLatestAgentRelease,
  selectLatestAgentRelease,
} from "../src/github-latest-agent-release.ts";


const LATEST = "https://api.github.com/repos/lirtual/mcp-workers/releases/latest";
const TAG = "v0.2.0";
const SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SIZE = 12345678;

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
    html_url: `https://github.com/lirtual/mcp-workers/releases/tag/${TAG}`,
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
  const notes = {
    name: "SHA256SUMS.txt",
    state: "uploaded",
    size: 32,
    digest: "sha256:" + "ab".repeat(32),
    browser_download_url: "https://example.invalid/sums",
  };
  const withNotes = release({}, [...TARGETS.map(([target, ext]) => asset(target, ext)), notes]);
  const decision = selectLatestAgentRelease({ status: 200, body: withNotes });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const snapshot = decision.release;
  assert.equal(snapshot.repository, "lirtual/mcp-workers");
  assert.equal(snapshot.tag, TAG);
  assert.equal(snapshot.immutable, true);
  const windows = snapshot.assets["windows-x64"];
  assert.equal(windows.target, "windows-x64");
  assert.equal(windows.architecture, "x64");
  assert.equal(windows.name, "remote-control-agent-v0.2.0-windows-x64.zip");
  assert.equal(windows.sha256, SHA);
  assert.equal(windows.size, SIZE);
  assert.equal(windows.downloadUrl,
    "https://github.com/lirtual/mcp-workers/releases/download/v0.2.0/remote-control-agent-v0.2.0-windows-x64.zip");
  const fake = github(200, withNotes);
  const lookedUp = await readLatestAgentRelease(fake.fetch);
  assert.equal(fake.calls.length, 1);
  const request = fake.calls[0];
  assert.ok(request);
  assert.equal(request.method, "GET");
  assert.equal(request.url, LATEST);
  assert.equal(request.redirect, "manual");
  assert.equal(lookedUp.ok, true);

});

test("latest lookup stops on 404, 403, 429, redirects, prerelease tags, and a bad Agent manifest", async () => {
  for (const [status, stop] of [[404, "not_found"], [403, "forbidden"], [429, "rate_limited"]] as const) {
    const fake = github(status, { message: "no" }, status === 403 ? { "retry-after": "12" } : {});
    const decision = await readLatestAgentRelease(fake.fetch);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.stop, stop);
    if (status === 403) assert.equal(decision.retryAfter, "12");
    assert.equal(fake.calls.length, 1);
  }
  const redirected = github(302, "", { location: "https://evil.example/payload" });
  const redirectDecision = await readLatestAgentRelease(redirected.fetch);
  assert.deepEqual(redirectDecision, { ok: false, stop: "rejected" });
  assert.equal(redirected.calls.length, 1);
  const cases: Array<[unknown, string]> = [
    [release({ prerelease: true }), "rejected"],
    [release({ draft: true }), "rejected"],
    [release({ immutable: false }), "rejected"],
    [release({ tag_name: "v0.2.0-rc.1" }), "rejected"],
    [release({}, TARGETS.filter(([target]) => target !== "windows-x64").map(([target, ext]) => asset(target, ext))), "rejected"],
    [release({}, TARGETS.filter(([target]) => target !== "darwin-x64").map(([target, ext]) => asset(target, ext))), "rejected"],
    [release({}, [...TARGETS.map(([target, ext]) => asset(target, ext)), asset("windows-x64", "zip")]), "rejected"],
    [release({}, TARGETS.map(([target, ext]) => target === "windows-x64"
      ? asset(target, ext, { digest: "sha256:not-a-digest" })
      : asset(target, ext))), "rejected"],
    [release({}, TARGETS.map(([target, ext]) => target === "windows-x64"
      ? asset(target, ext, { browser_download_url: "https://github.com/lirtual/remote-control-agent/releases/download/v0.2.0/remote-control-agent-v0.2.0-windows-x64.zip" })
      : asset(target, ext))), "rejected"],
  ];
  for (const [body, stop] of cases) {
    const decision = selectLatestAgentRelease({ status: 200, body });
    assert.equal(decision.ok, false, JSON.stringify(body).slice(0, 120));
    if (decision.ok) continue;
    assert.equal(decision.stop, stop);
  }
});
