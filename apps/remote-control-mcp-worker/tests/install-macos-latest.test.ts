import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LATEST_AGENT_RELEASE_URL,
  agentAssetName,
  readLatestAgentRelease,
  selectLatestAgentRelease,
  type AgentReleaseTarget,
} from "../src/github-latest-agent-release.ts";
import { handleLatestMacInstallRequest, renderLatestMacInstallShell, renderPackagedMacUpdateShell } from "../src/install-macos-latest.ts";
import { LATEST_MANIFEST_URL } from "../src/release-manifest-shell.ts";

const ORIGIN = "https://rca.lirtual.dpdns.org";
const OLD_COMMIT = "03a14fd4138ca8d77fa8aced78f7a53ccc51724e";
const NEW_COMMIT = "b".repeat(40);
const TAG = "v0.2.0";

function asset(tag: string, target: AgentReleaseTarget, bytes: number, sha256: string) {
  const name = agentAssetName(tag, target);
  return {
    name,
    state: "uploaded",
    size: bytes,
    digest: "sha256:" + sha256,
    browser_download_url: `https://github.com/lirtual/mcp-workers/releases/download/${tag}/${name}`,
  };
}

function releaseBody(tag = TAG, overrides: Record<string, unknown> = {}) {
  const sha = "cd".repeat(32);
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    immutable: true,
    html_url: `https://github.com/lirtual/mcp-workers/releases/tag/${tag}`,
    body: "historical source " + OLD_COMMIT,
    assets: [
      asset(tag, "linux-x64-glibc", 1200, sha),
      asset(tag, "linux-arm64-glibc", 1201, "ce".repeat(32)),
      asset(tag, "windows-x64", 1202, "cf".repeat(32)),
      asset(tag, "darwin-arm64", 1300, "ab".repeat(32)),
      asset(tag, "darwin-x64", 1301, "ac".repeat(32)),
      { name: "SHA256SUMS", state: "uploaded", size: 64, digest: "sha256:" + "aa".repeat(32),
        browser_download_url: "https://example.invalid/not-used" },
    ],
    ...overrides,
  };
}

test("#809 latest selection uses one immutable five-asset snapshot and keeps both Mac assets", () => {
  const decision = selectLatestAgentRelease({ status: 200, body: releaseBody() });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.release.repository, "lirtual/mcp-workers");
  assert.equal(decision.release.tag, TAG);
  assert.equal(decision.release.immutable, true);
  assert.equal(decision.release.assets["darwin-arm64"].sha256, "ab".repeat(32));
  assert.equal(decision.release.assets["darwin-x64"].sha256, "ac".repeat(32));
  assert.notEqual(decision.release.assets["darwin-arm64"].downloadUrl,
    decision.release.assets["darwin-x64"].downloadUrl);
  assert.match(decision.release.assets["darwin-arm64"].downloadUrl, /\/v0\.2\.0\/remote-control-agent-v0\.2\.0-darwin-arm64\.tar\.gz$/);
  assert.equal(JSON.stringify(decision.release).includes(OLD_COMMIT), false);
});

test("#809 latest lookup fails closed on 404, 403, 429, and unusable releases", () => {
  assert.deepEqual(selectLatestAgentRelease({ status: 404, body: releaseBody() }), { ok: false, stop: "not_found" });
  assert.deepEqual(selectLatestAgentRelease({ status: 403, retryAfter: "120" }),
    { ok: false, stop: "forbidden", retryAfter: "120" });
  assert.deepEqual(selectLatestAgentRelease({ status: 429, retryAfter: "nope" }),
    { ok: false, stop: "rate_limited" });
  const unusable = [
    releaseBody(TAG, { prerelease: true }),
    releaseBody(TAG, { draft: true }),
    releaseBody(TAG, { immutable: false }),
    releaseBody(TAG, { html_url: "https://github.com/lirtual/remote-control-agent/releases/tag/" + TAG }),
    releaseBody(TAG, { assets: releaseBody().assets.slice(0, 4) }),
    releaseBody(TAG, { assets: [...releaseBody().assets, asset("v0.9.0", "darwin-arm64", 9, "dd".repeat(32))] }),
    releaseBody(TAG, { assets: releaseBody().assets.map(item =>
      item && typeof item === "object" && "name" in item && String(item.name).includes("darwin-arm64")
        ? { ...item, browser_download_url: "https://github.com/lirtual/remote-control-agent/releases/download/v0.1.51/" + item.name }
        : item) }),
  ];
  for (const body of unusable) {
    assert.equal(selectLatestAgentRelease({ status: 200, body }).ok, false, JSON.stringify(body).slice(0, 180));
  }

});

test("Rust-only packaged macOS updater validates a local archive and invokes only the verified Rust manager", () => {
  const generated = renderPackagedMacUpdateShell();
  const syntax = spawnSync("sh", ["-n"], { input: generated, encoding: "utf8", timeout: 5000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(generated, /rca-standard-darwin-candidate/);
  assert.match(generated, /--verify-bundle/);
  assert.match(generated, /--upgrade-local/);
  assert.match(generated, /--automatic/);
  assert.match(generated, /shasum -a 256/);
  assert.match(generated, /tar -tzf/);
  assert.doesNotMatch(generated, /bin\/node|macos-local\.mjs|macos-remote-upgrade\.mjs|curl/);
});

test("Rust-only updater verifies the exact archive before dispatching manual or automatic upgrade", () => {
  const root = mkdtempSync(path.join(tmpdir(), "rca-native-updater-test-"));
  try {
    const app = "apps/remote-control-agent";
    const candidatePath = path.join(root, app, ".build", "rca-standard-darwin-candidate");
    const helperPath = path.join(root, app, ".build", "darwin-session-supervisor");
    const updaterPath = path.join(root, app, "scripts", "macos-update.sh");
    const shim = path.join(root, "shim");
    mkdirSync(path.dirname(candidatePath), { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(updaterPath), { recursive: true, mode: 0o700 });
    mkdirSync(shim, { mode: 0o700 });
    writeFileSync(path.join(root, "bundle.json"), "{}\n", { mode: 0o600 });
    writeFileSync(helperPath, "native helper\n", { mode: 0o700 });
    writeFileSync(candidatePath, "#!/bin/sh\nif [ \"$1\" = --verify-bundle ]; then printf '%s\\n' \"$RCA_SOURCE\"; exit 0; fi\necho \"$*\" >> \"$RCA_CANDIDATE_LOG\"\n", { mode: 0o700 });
    chmodSync(candidatePath, 0o700);
    writeFileSync(updaterPath, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    writeFileSync(path.join(shim, "uname"), "#!/bin/sh\n[ \"$1\" = -s ] && echo Darwin || echo arm64\n", { mode: 0o700 });
    writeFileSync(path.join(shim, "id"), "#!/bin/sh\necho 501\n", { mode: 0o700 });
    const archive = path.join(root, "candidate.tar.gz");
    const makeArchive = (extra: string[] = []) => {
      for (const file of extra) writeFileSync(path.join(root, file), "untrusted\n");
      const tar = spawnSync("tar", ["-czf", archive, "-C", root, "bundle.json", "apps", ...extra], { encoding: "utf8" });
      assert.equal(tar.status, 0, tar.stderr);
      return readFileSync(archive);
    };
    const bytes = makeArchive();
    const digest = sha256(bytes);
    const log = path.join(root, "candidate.log");
    const generated = renderPackagedMacUpdateShell();
    const manual = spawnSync("sh", ["-c", generated, "native-updater", archive, digest, String(bytes.length), TAG, "darwin-arm64", "https://rca.example.test/", "a".repeat(64)], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: shim + path.delimiter + (process.env.PATH ?? "/usr/bin:/bin"), TMPDIR: root,
        RCA_SOURCE: NEW_COMMIT, RCA_CANDIDATE_LOG: log },
    });
    assert.equal(manual.status, 0, manual.stderr);
    assert.match(readFileSync(log, "utf8"), /--upgrade-local https:\/\/rca\.example\.test\/ v0\.2\.0 /);
    const automatic = spawnSync("sh", ["-c", generated, "native-updater", archive, digest, String(bytes.length), TAG, "darwin-arm64", "https://rca.example.test/", "a".repeat(64), "--automatic"], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: shim + path.delimiter + (process.env.PATH ?? "/usr/bin:/bin"), TMPDIR: root,
        RCA_SOURCE: NEW_COMMIT, RCA_CANDIDATE_LOG: log },
    });
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.match(readFileSync(log, "utf8"), /--upgrade-local https:\/\/rca\.example\.test\/ v0\.2\.0 .* --automatic/);
    const before = readFileSync(log, "utf8");
    const wrongDigest = spawnSync("sh", ["-c", generated, "native-updater", archive, "0".repeat(64), String(bytes.length), TAG, "darwin-arm64", "https://rca.example.test/", "a".repeat(64)], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: shim + path.delimiter + (process.env.PATH ?? "/usr/bin:/bin"), TMPDIR: root,
        RCA_SOURCE: NEW_COMMIT, RCA_CANDIDATE_LOG: log },
    });
    assert.notEqual(wrongDigest.status, 0);
    assert.equal(readFileSync(log, "utf8"), before);
    const hostileBytes = makeArchive(["foreign.txt"]);
    writeFileSync(archive, hostileBytes, { mode: 0o600 });
    const hostile = spawnSync("sh", ["-c", generated, "native-updater", archive, sha256(hostileBytes), String(hostileBytes.length), TAG, "darwin-arm64", "https://rca.example.test/", "a".repeat(64)], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: shim + path.delimiter + (process.env.PATH ?? "/usr/bin:/bin"), TMPDIR: root,
        RCA_SOURCE: NEW_COMMIT, RCA_CANDIDATE_LOG: log },
    });
    assert.notEqual(hostile.status, 0);
    assert.equal(readFileSync(log, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#809 macOS route reports lookup failures without a script or old repository", async () => {
  const staticRoute = handleLatestMacInstallRequest(
    new Request(ORIGIN + "/install-macos.sh"), ORIGIN);
  assert.equal(staticRoute.status, 200);
  assert.match(await staticRoute.text(), /rca-release-v1/);
  const redirected = await readLatestAgentRelease(async () => new Response(null, { status: 302, headers: { location: "https://github.com/lirtual/remote-control-agent/releases/latest" } }));
  assert.deepEqual(redirected, { ok: false, stop: "rejected" });
  let calls = 0;
  const limited = await readLatestAgentRelease(async (url) => {
    calls += 1;
    assert.equal(url, LATEST_AGENT_RELEASE_URL);
    return new Response("slow", { status: 429, headers: { "retry-after": "15" } });
  });
  assert.equal(calls, 1);
  assert.deepEqual(limited, { ok: false, stop: "rate_limited", retryAfter: "15" });
  const down = await readLatestAgentRelease(async () => { throw new Error("offline"); });
  assert.deepEqual(down, { ok: false, stop: "unavailable" });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("Rust-only macOS install shell selects the stable asset and invokes only the native CLI", () => {
  const script = renderLatestMacInstallShell(ORIGIN);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
  assert.ok(script.includes(LATEST_MANIFEST_URL));
  assert.match(script, /--verify-bundle/);
  assert.match(script, /--install-local/);
  assert.match(script, /--temporary-local/);
  assert.ok(script.includes("The Rust-only macOS installer accepts no legacy action arguments."));
  assert.doesNotMatch(script, /bin\/node|macos-local\.mjs|macos-remote-upgrade\.mjs/);
});

test("packaged macOS updater validates the exact local Rust archive without a runtime manager", () => {
  const script = renderPackagedMacUpdateShell();
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
  assert.match(script, /--automatic/);
  assert.ok(script.includes("Release asset SHA-256 mismatch."));
  assert.doesNotMatch(script, /bin\/node|macos-local\.mjs|macos-remote-upgrade\.mjs|curl/);
});

test("production macOS route is static and does not call GitHub API from Cloudflare", async () => {
  const { default: worker } = await import("../src/worker.ts");
  let calls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "owner-only",
    REMOTE_CONTROL_INSTALL_ORIGIN: ORIGIN,
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) },
    AGENT_RELEASE_FETCH: async () => { calls++; throw Error("forbidden Worker API call"); },
  };
  const blocked = await worker.fetch(new Request("https://unauthorized.test/install-macos.sh"), env as never);
  assert.equal(blocked.status, 403);
  const shell = await worker.fetch(new Request(ORIGIN + "/install-macos.sh"), env as never);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /rca-release-v1/);
  assert.equal(calls, 0);
});
