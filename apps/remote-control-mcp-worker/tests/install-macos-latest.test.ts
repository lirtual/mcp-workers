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

function packArchive(target: "darwin-arm64" | "darwin-x64", version = TAG, packaged = false): Buffer {
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
  tty) [ -t 0 ] && [ -t 1 ] || { echo "Missing owner terminal" >&2; exit 1; }
       printf '%s\\n' '{"status":"connected_observed"}'; exit 0 ;;
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
    if(packaged) writeFileSync(path.join(root,"apps/remote-control-agent/scripts/macos-update.sh"),
      renderPackagedMacUpdateShell(),{mode:0o600});
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

function packNativeArchive(target: "darwin-arm64" | "darwin-x64", extra: string[] = []): Buffer {
  const root = mkdtempSync(path.join(tmpdir(), "rca-native-bootstrap-test-"));
  try {
    const app = "apps/remote-control-agent";
    for (const dir of [app + "/.build", app + "/scripts"]) {
      mkdirSync(path.join(root, dir), {recursive: true, mode: 0o700});
    }
    writeFileSync(path.join(root, "bundle.json"), JSON.stringify({
      name: "remote-control-agent", version: TAG, target,
      source_commit: NEW_COMMIT, artifact_schema: 1, device_protocol: 2,
      receipt_schema: 1, artifact_profile: "rust-native-only-v1",
      agent_runtime: "rust-standard-darwin-v1",
      runtime_profile: "standard-darwin-rust-runtime-v1",
      candidate_profile: "darwin-permanent-local-v1",
      native_supervisor: "darwin-owned-group-v1", modules: [],
    }) + "\n", {mode: 0o600});
    const candidate = path.join(root, app, ".build", "rca-standard-darwin-candidate");
    writeFileSync(candidate, [
      "#!/bin/sh",
      'if [ "$1" = --verify-bundle ]; then',
      `  [ "$2" = ${TAG} ] && [ "$3" = ${target} ] || exit 2`,
      `  echo ${NEW_COMMIT}`,
      "  exit 0",
      "fi",
      'printf "%s\\n" "$*" >> "$RCA_NODE_LOG"',
      'exit "${RCA_NATIVE_EXIT:-0}"',
      "",
    ].join("\n"), {mode: 0o700});
    chmodSync(candidate, 0o700);
    const supervisor = path.join(root, app, ".build", "darwin-session-supervisor");
    writeFileSync(supervisor, "fixture\n", {mode: 0o700});
    chmodSync(supervisor, 0o700);
    writeFileSync(path.join(root, app, "scripts", "macos-update.sh"),
      renderPackagedMacUpdateShell(), {mode: 0o600});
    for (const file of extra) writeFileSync(path.join(root, file), "unreviewed\n");
    const archive = path.join(root, "native.tar.gz");
    const tar = spawnSync("tar", ["-czf", archive, "-C", root, "apps", "bundle.json", ...extra], {encoding: "utf8"});
    assert.equal(tar.status, 0, tar.stderr);
    return readFileSync(archive);
  } finally {
    rmSync(root, {recursive: true, force: true});
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
  return renderLatestMacInstallShell(ORIGIN);
}

function runInstaller(script: string, arch: "arm64" | "x86_64", bytes: { arm: Buffer; intel: Buffer }, extra: Record<string, string> = {}, action = "--remote-upgrade", tty = false, packagedVersion?: string) {
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
  const manifestFile = path.join(root, "manifest.txt");
  writeFileSync(manifestFile, [
    "rca-release-v1 " + TAG,
    "linux-x64-glibc 1200 " + "11".repeat(32),
    "linux-arm64-glibc 1201 " + "22".repeat(32),
    "windows-x64 1202 " + "33".repeat(32),
    "darwin-arm64 " + bytes.arm.length + " " + sha256(bytes.arm),
    "darwin-x64 " + bytes.intel.length + " " + sha256(bytes.intel),
  ].join("\n") + "\n");
  const curlLog = path.join(root, "curl.log");
  const nodeLog = path.join(root, "node.log");
  writeFileSync(curlLog, "");
  writeFileSync(nodeLog, "");
  writeFileSync(path.join(bin, "curl"), [
    "#!/bin/sh",
    "out=",
    "prev=",
    "url=",
    "for arg in \"$@\"; do",
    "  if [ \"$prev\" = -o ]; then out=$arg; fi",
    "  case \"$arg\" in https://*) url=$arg ;; esac",
    "  prev=$arg",
    "done",
    "printf '%s\\n' \"$url\" >> \"$RCA_CURL_LOG\"",
    "if [ \"$url\" = \"$RCA_MANIFEST_URL\" ]; then",
    "  cp \"$RCA_MANIFEST_FILE\" \"$out\"",
    "  printf '%s' \"$url\"",
    "  exit 0",
    "fi",
    "if [ -n \"$RCA_CURL_EFFECTIVE\" ]; then printf '%s' \"$RCA_CURL_EFFECTIVE\"; else printf '%s' \"$url\"; fi",
    "case \"$url\" in",
    "  *darwin-arm64*) cp \"$RCA_ARM_FILE\" \"$out\" ;;",
    "  *darwin-x64*) cp \"$RCA_INTEL_FILE\" \"$out\" ;;",
    "  *) exit 22 ;;",
    "esac",
    "if [ -n \"$RCA_CURL_APPEND\" ]; then printf '%s' \"$RCA_CURL_APPEND\" >> \"$out\"; fi",
  ].join("\n") + "\n", { mode: 0o755 });
  for (const name of ["uname", "sw_vers", "curl"]) chmodSync(path.join(bin, name), 0o755);
  const scriptFile = path.join(root, "test-installer.sh");
  writeFileSync(scriptFile, script, {mode:0o700});
  const result = spawnSync(tty ? "script" : "sh", tty
    ? ["-q","-e","-c",extra.RCA_TEST_NATIVE_TTY === "1" ? 'sh "$RCA_TEST_SCRIPT"' :
      packagedVersion===undefined?'sh "$RCA_TEST_SCRIPT" --upgrade':
      'sh "$RCA_TEST_SCRIPT" "$RCA_TEST_ENDPOINT" "$RCA_TEST_INSTALLED" "$RCA_TEST_BINDING"',"/dev/null"]
    : ["-c", script, "macos-script", action], {
    encoding: "utf8",
    timeout: 15000,
    input: extra.RCA_TEST_NATIVE_TTY === "1"
      ? (extra.RCA_TEST_NATIVE_MODE === "temporary" ? "2\nNative Test Device\n" : "1\nNative Test Device\n")
      : undefined,
    env: {
      ...process.env,
      PATH: bin + ":" + process.env.PATH,
      TMPDIR: root,
      RCA_TEST_SCRIPT: scriptFile,
      RCA_TEST_ENDPOINT: ORIGIN+"/",
      RCA_TEST_INSTALLED: packagedVersion??"",
      RCA_TEST_BINDING: "a".repeat(64),
      RCA_NODE_LOG: nodeLog,
      RCA_CURL_LOG: curlLog,
      RCA_MANIFEST_URL: LATEST_MANIFEST_URL,
      RCA_MANIFEST_FILE: manifestFile,
      RCA_ARM_FILE: armFile,
      RCA_INTEL_FILE: intelFile,
      RCA_CURL_APPEND: "",
      RCA_CURL_EFFECTIVE: "",
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
