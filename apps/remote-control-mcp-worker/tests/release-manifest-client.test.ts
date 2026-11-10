import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LATEST_MANIFEST_URL, renderClientReleaseManifestShell } from "../src/release-manifest-shell.ts";

const tag = "v0.2.1";
const targets = ["linux-x64-glibc", "linux-arm64-glibc", "windows-x64", "darwin-arm64", "darwin-x64"];
const sha = "a".repeat(64);
function validManifest() {
  return ["rca-release-v1 " + tag, ...targets.map((t) => t + " 2048 " + sha)].join("\n") + "\n";
}
function verify(manifest: string, target = "linux-x64-glibc", opts: { effective?: string; fail?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "rca-manifest-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const file = path.join(root, "fixture.txt");
    writeFileSync(file, manifest);
    const curl = path.join(bin, "curl");
    writeFileSync(curl, [
      "#!/bin/sh",
      "out=",
      "prev=",
      "url=",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = -o ]; then out=$arg; fi",
      "  case \"$arg\" in https://*) url=$arg ;; esac",
      "  prev=$arg",
      "done",
      "[ \"$url\" = \"$RCA_EXPECTED_MANIFEST_URL\" ] || exit 5",
      "[ \"$RCA_CURL_FAIL\" != yes ] || exit 22",
      "cp \"$RCA_MANIFEST_FILE\" \"$out\"",
      "if [ -n \"$RCA_EFFECTIVE\" ]; then printf '%s' \"$RCA_EFFECTIVE\"; else printf '%s' \"$url\"; fi",
    ].join("\n") + "\n");
    chmodSync(curl, 0o755);
    const script = [
      "set -eu",
      "stage=" + root,
      "target=" + target,
      ...renderClientReleaseManifestShell(),
      "printf 'OK=%s %s %s %s\\n' \"$tag\" \"$expected_size\" \"$expected\" \"$download\"",
    ].join("\n");
    return spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      timeout: 4000,
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        RCA_EXPECTED_MANIFEST_URL: LATEST_MANIFEST_URL,
        RCA_MANIFEST_FILE: file,
        RCA_EFFECTIVE: opts.effective ?? "",
        RCA_CURL_FAIL: opts.fail ? "yes" : "",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("POSIX shell selects each platform from one validated immutable manifest", () => {
  for (const target of ["linux-x64-glibc", "linux-arm64-glibc", "darwin-arm64", "darwin-x64"]) {
    const result = verify(validManifest(), target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp("OK=" + tag.replaceAll(".", "[.]") + " 2048 " + sha));
    assert.match(result.stdout, new RegExp("/releases/download/" + tag.replaceAll(".", "[.]") + "/remote-control-agent-" + tag.replaceAll(".", "[.]") + "-" + target + "[.]tar[.]gz"));
  }
});

test("bad, stale, incomplete, duplicate, malicious, overlong manifest fails before asset execution", () => {
  const valid = validManifest();
  const bad = [
    valid.replace("rca-release-v1", "rca-release-v2"),
    valid.replace(tag, "v0.2.1-rc.1"),
    valid.replace("2048", "0"),
    valid.replace("2048", "180000001"),
    valid.replace(sha, "not-a-digest"),
    valid.replace("windows-x64", "linux-arm64-glibc"),
    valid.replace("darwin-x64 2048 " + sha + "\n", ""),
    valid + "linux-x64-glibc 2048 " + sha + "\n",
    valid.replace("linux-x64-glibc", "linux-x64-glibc $(touch /tmp/do-not-run)"),
    valid + "x".repeat(1050),
    "",
  ];
  for (const body of bad) {
    const result = verify(body);
    assert.notEqual(result.status, 0, JSON.stringify(body).slice(0, 110));
    assert.doesNotMatch(result.stdout, /OK=/);
  }
});

test("unexpected manifest redirect and unavailable GitHub fail without a retry or fallback", () => {
  const wrong = verify(validManifest(), "linux-x64-glibc", { effective: "https://evil.example/release.txt" });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /Unexpected GitHub manifest redirect/);
  const versionMix = verify(validManifest(), "linux-x64-glibc", { effective: "https://github.com/lirtual/mcp-workers/releases/download/v9.9.9/remote-control-agent-manifest.txt" });
  assert.notEqual(versionMix.status, 0);
  const denied = verify(validManifest(), "linux-x64-glibc", { fail: true });
  assert.notEqual(denied.status, 0);
  assert.doesNotMatch(denied.stdout, /OK=/);
});
