import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LATEST_AGENT_RELEASE_URL,
  agentAssetName,
  readLatestAgentRelease,
  selectLatestAgentRelease,
  type AgentReleaseTarget,
  type SelectedAgentRelease,
} from "../src/github-latest-agent-release.ts";
import { handleLatestMacInstallRequest, renderLatestMacInstallShell } from "../src/install-macos-latest.ts";

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

function selected(body = releaseBody()): SelectedAgentRelease {
  const decision = selectLatestAgentRelease({ status: 200, body });
  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error("fixture was rejected");
  return decision.release;
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
  const origin = ORIGIN;
  for (const status of [404, 403, 429] as const) {
    const response = handleLatestMacInstallRequest(
      new Request(origin + "/install-macos.sh"),
      origin,
      selectLatestAgentRelease({ status, retryAfter: status === 429 ? "30" : null }),
    );
    const text = response.statusText;
    void text;
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /shellscript/);
  }
});

test("#809 macOS route reports lookup failures without a script or old repository", async () => {
  const origin = ORIGIN;
  const cases = [
    { status: 404, http: 503, body: "No stable Agent Release is published.\n" },
    { status: 403, http: 403, body: "GitHub refused the Agent Release lookup.\n", retry: "12" },
    { status: 429, http: 429, body: "GitHub rate limit stopped the Agent Release lookup.\n", retry: "30" },
  ];
  for (const item of cases) {
    const response = handleLatestMacInstallRequest(
      new Request(origin + "/install-macos.sh"), origin,
      selectLatestAgentRelease({ status: item.status, retryAfter: item.retry ?? null }));
    assert.equal(response.status, item.http);
    const failure = await response.text();
    assert.equal(failure, item.body);
    if (item.retry) assert.equal(response.headers.get("retry-after"), item.retry);
    assert.doesNotMatch(failure, /#!\/bin\/sh|remote-control-agent/);
  }
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

function packArchive(target: "darwin-arm64" | "darwin-x64", version = TAG): Buffer {
  const root = mkdtempSync(path.join(tmpdir(), "rca809-pack-"));
  try {
    const dirs = [
      "bin",
      "apps/remote-control-agent/src",
      "apps/remote-control-agent/scripts",
      "apps/remote-control-agent/.build",
    ];
    for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    const node = path.join(root, "bin/node");
    writeFileSync(node, `#!/bin/sh
printf '%s\\n' "$*" >> "\${RCA_NODE_LOG:?}"
if [ "\${1:-}" = "-e" ]; then
  exec '${process.execPath}' "$@"
fi
case "\${RCA_NODE_MODE:-ok}" in
  fail) exit 1 ;;
  unknown) printf 'not-a-result\\n'; exit 0 ;;
esac
printf '%s\\n' '{"status":"launched","operation_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}'
`, { mode: 0o700 });
    chmodSync(node, 0o700);
    writeFileSync(path.join(root, "bundle.json"), JSON.stringify({
      name: "remote-control-agent",
      version,
      target,
      source_commit: NEW_COMMIT,
      artifact_schema: 1,
      device_protocol: 2,
      receipt_schema: 1,
      candidate_profile: "darwin-permanent-local-v1",
      native_supervisor: "darwin-owned-group-v1",
      modules: ["macos-permanent.ts"],
    }) + "\n", { mode: 0o600 });
    writeFileSync(path.join(root, "apps/remote-control-agent/package.json"), "{\"type\":\"module\"}\n", { mode: 0o600 });
    writeFileSync(path.join(root, "apps/remote-control-agent/src/macos-permanent.js"), "export {}\n", { mode: 0o600 });
    writeFileSync(path.join(root, "apps/remote-control-agent/scripts/macos-local.mjs"), "export {}\n", { mode: 0o600 });
    writeFileSync(path.join(root, "apps/remote-control-agent/scripts/macos-remote-upgrade.mjs"), "export {}\n", { mode: 0o600 });
    const helper = path.join(root, "apps/remote-control-agent/.build/darwin-session-supervisor");
    writeFileSync(helper, "owned-group\n", { mode: 0o700 });
    chmodSync(helper, 0o700);
    const archive = path.join(root, "agent.tar.gz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", root, "bin", "apps", "bundle.json"], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);
    return readFileSync(archive);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function shellFor(bytes: { arm: Buffer; intel: Buffer }, body?: string): string {
  const release = releaseBody();
  release.assets = [
    asset(TAG, "linux-x64-glibc", 1200, "11".repeat(32)),
    asset(TAG, "linux-arm64-glibc", 1201, "22".repeat(32)),
    asset(TAG, "windows-x64", 1202, "33".repeat(32)),
    asset(TAG, "darwin-arm64", bytes.arm.length, sha256(bytes.arm)),
    asset(TAG, "darwin-x64", bytes.intel.length, sha256(bytes.intel)),
  ];
  if (body) release.body = body;
  return renderLatestMacInstallShell(ORIGIN, selected(release));
}

function runInstaller(script: string, arch: "arm64" | "x86_64", bytes: { arm: Buffer; intel: Buffer }, extra: Record<string, string> = {}, action = "--remote-upgrade") {
  const root = mkdtempSync(path.join(tmpdir(), "rca809-run-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin, { mode: 0o755 });
  writeFileSync(path.join(bin, "uname"), `#!/bin/sh
if [ "$1" = "-m" ]; then echo ${arch}; exit 0; fi
echo Darwin
`, { mode: 0o755 });
  writeFileSync(path.join(bin, "sw_vers"), "#!/bin/sh\necho 15.6\n", { mode: 0o755 });
  const armFile = path.join(root, "arm.tar.gz");
  const intelFile = path.join(root, "intel.tar.gz");
  writeFileSync(armFile, bytes.arm);
  writeFileSync(intelFile, bytes.intel);
  const curlLog = path.join(root, "curl.log");
  const nodeLog = path.join(root, "node.log");
  writeFileSync(curlLog, "");
  writeFileSync(nodeLog, "");
  writeFileSync(path.join(bin, "curl"), `#!/bin/sh
out=""
prev=""
url=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out=$arg; fi
  case "$arg" in
    https://*) url=$arg ;;
  esac
  prev=$arg
done
printf '%s\\n' "$url" >> '${curlLog}'
if [ -n "\${RCA_CURL_EFFECTIVE:-}" ]; then printf '%s' "$RCA_CURL_EFFECTIVE"; else printf '%s' "$url"; fi
case "$url" in
  *darwin-arm64*) cat '${armFile}' > "$out" ;;
  *darwin-x64*) cat '${intelFile}' > "$out" ;;
  *) echo missing > "$out" ;;
esac
if [ -n "\${RCA_CURL_APPEND:-}" ]; then printf '%s' "$RCA_CURL_APPEND" >> "$out"; fi
`, { mode: 0o755 });
  for (const name of ["uname", "sw_vers", "curl"]) chmodSync(path.join(bin, name), 0o755);
  const result = spawnSync("sh", ["-c", script, "macos-script", action], {
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      TMPDIR: root,
      RCA_NODE_LOG: nodeLog,
      RCA_CURL_LOG: curlLog,
      ...extra,
    },
  });
  const curls = readFileSync(curlLog, "utf8").trim().split("\n").filter(Boolean);
  let nodes = "";
  try { nodes = readFileSync(nodeLog, "utf8"); } catch { nodes = ""; }
  const left = readdirSync(root).filter(name => name.startsWith("rca-macos"));
  rmSync(root, { recursive: true, force: true });
  return { result, curls, nodes, left };
}

test("#809 installer shell picks one arch asset from the snapshot and does not use the old commit", () => {
  const bytes = { arm: packArchive("darwin-arm64"), intel: packArchive("darwin-x64") };
  const script = shellFor(bytes, "notes " + OLD_COMMIT);
  assert.equal(spawnSync("sh", ["-n"], { input: script, encoding: "utf8" }).status, 0);
  assert.doesNotMatch(script, /github\.com\/lirtual\/remote-control-agent/);
  assert.doesNotMatch(script, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(script, /api\.github\.com/);
  assert.doesNotMatch(script, new RegExp(OLD_COMMIT));
  assert.match(script, /mode=temporary/);
  assert.match(script, /Permanent \(login LaunchAgent\)/);
  const arm = runInstaller(script, "arm64", bytes);
  assert.equal(arm.result.status, 0, arm.result.stderr);
  assert.deepEqual(arm.curls, [
    `https://github.com/lirtual/mcp-workers/releases/download/${TAG}/remote-control-agent-${TAG}-darwin-arm64.tar.gz`,
  ]);
  assert.match(arm.nodes, new RegExp("--source-sha " + NEW_COMMIT));
  assert.doesNotMatch(arm.nodes, new RegExp(OLD_COMMIT));
  assert.equal(arm.left.length, 0);
  const intel = runInstaller(script, "x86_64", bytes);
  assert.equal(intel.result.status, 0, intel.result.stderr);
  assert.deepEqual(intel.curls, [
    `https://github.com/lirtual/mcp-workers/releases/download/${TAG}/remote-control-agent-${TAG}-darwin-x64.tar.gz`,
  ]);
  assert.match(intel.nodes, /darwin-x64|dispatch/);
  const noTty = runInstaller(script, "arm64", bytes, {}, "--upgrade");
  assert.notEqual(noTty.result.status, 0);
  assert.match(noTty.result.stderr, /Ordinary interactive Terminal required/);
  assert.deepEqual(noTty.curls, []);
});

test("#809 corrupt, redirected, wrong-arch, failed, and unknown upgrades stop once", () => {
  const bytes = { arm: packArchive("darwin-arm64"), intel: packArchive("darwin-x64") };
  const script = shellFor(bytes);
  const corrupt = runInstaller(script, "arm64", bytes, { RCA_CURL_APPEND: "x" });
  assert.notEqual(corrupt.result.status, 0);
  assert.match(corrupt.result.stderr, /Release asset size mismatch/);
  assert.equal(corrupt.curls.length, 1);
  assert.equal(corrupt.nodes, "");
  const redirected = runInstaller(script, "arm64", bytes, { RCA_CURL_EFFECTIVE: "https://evil.example/agent.tar.gz" });
  assert.notEqual(redirected.result.status, 0);
  assert.match(redirected.result.stderr, /Unexpected Release redirect/);
  assert.equal(redirected.nodes, "");
  const crossed = { arm: bytes.intel, intel: bytes.arm };
  const wrongArch = runInstaller(shellFor(crossed), "arm64", crossed);
  assert.notEqual(wrongArch.result.status, 0);
  assert.match(wrongArch.result.stderr, /does not match this Mac or Release/);
  assert.doesNotMatch(wrongArch.nodes, /macos-remote-upgrade/);
  assert.equal(wrongArch.curls.length, 1);
  const failed = runInstaller(script, "arm64", bytes, { RCA_NODE_MODE: "fail" });
  assert.notEqual(failed.result.status, 0);
  assert.match(failed.result.stderr, /local recovery evidence retained/);
  assert.equal(failed.curls.length, 1);
  assert.equal((failed.nodes.match(/macos-remote-upgrade/g) ?? []).length, 1);
  const unknown = runInstaller(script, "arm64", bytes, { RCA_NODE_MODE: "unknown" });
  assert.notEqual(unknown.result.status, 0);
  assert.match(unknown.result.stderr, /Unknown macOS installer result/);
  assert.equal(unknown.curls.length, 1);
  assert.equal((unknown.nodes.match(/macos-remote-upgrade/g) ?? []).length, 1);
});

test("#809 hostile archive members never reach the bundled Agent", () => {
  const bytes = { arm: packArchive("darwin-arm64"), intel: packArchive("darwin-x64") };
  const root = mkdtempSync(path.join(tmpdir(), "rca809-bad-"));
  try {
    mkdirSync(path.join(root, "apps/remote-control-agent/src"), { recursive: true });
    writeFileSync(path.join(root, "apps/remote-control-agent/src/Evil.js"), "nope\n");
    const archive = path.join(root, "bad.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", archive, "-C", root, "apps"], { encoding: "utf8" }).status, 0);
    const hostile = readFileSync(archive);
    const script = shellFor({ arm: hostile, intel: bytes.intel });
    const ran = runInstaller(script, "arm64", { arm: hostile, intel: bytes.intel });
    assert.notEqual(ran.result.status, 0);
    assert.match(ran.result.stderr, /Untrusted archive member/);
    assert.equal(ran.nodes, "");
    assert.equal(ran.curls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#809 production macOS route performs one latest read and ignores the old pin", async () => {
  const { default: worker } = await import("../src/worker.ts");
  const prod = "https://rca.lirtual.dpdns.org";
  let calls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "owner-only",
    REMOTE_CONTROL_INSTALL_ORIGIN: prod,
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) },
    AGENT_RELEASE_FETCH: async (url: string) => {
      calls += 1;
      assert.equal(String(url), LATEST_AGENT_RELEASE_URL);
      return new Response("missing", { status: 404 });
    },
  };
  const blocked = await worker.fetch(new Request("https://unauthorized.test/install-macos.sh"), env as never);
  assert.equal(blocked.status, 403);
  assert.equal(calls, 0);
  const missing = await worker.fetch(new Request(prod + "/install-macos.sh"), env as never);
  assert.equal(missing.status, 503);
  const missingText = await missing.text();
  assert.equal(missingText, "No stable Agent Release is published.\n");
  assert.equal(calls, 1);
  assert.doesNotMatch(missingText, /#!\/bin\/sh|remote-control-agent|03a14fd/);
});
