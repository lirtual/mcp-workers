import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Fixed name shared by every immutable GitHub Release (supports releases/latest/download). */
export const RELEASE_MANIFEST_NAME = "remote-control-agent-manifest.txt";
const TARGETS = [
  ["linux-x64-glibc", ".tar.gz"],
  ["linux-arm64-glibc", ".tar.gz"],
  ["windows-x64", ".zip"],
  ["darwin-arm64", ".tar.gz"],
  ["darwin-x64", ".tar.gz"],
];
const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const DIGEST = /^[a-f0-9]{64}$/;

/** Strict canonical six-line manifest: one stable tag and exactly five assets. */
export function renderAgentReleaseManifest(tag, assets) {
  if (!TAG.test(tag) || !Array.isArray(assets) || assets.length !== TARGETS.length) {
    throw Error("Invalid Agent Release manifest inputs.");
  }
  const names = new Set();
  const rows = ["rca-release-v1 " + tag];
  for (const [target, ext] of TARGETS) {
    const name = "remote-control-agent-" + tag + "-" + target + ext;
    const matching = assets.filter((item) => item?.name === name);
    if (matching.length !== 1 || names.has(name)) throw Error("Partial or duplicate manifest asset.");
    names.add(name);
    const asset = matching[0];
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 ||
        asset.size > 180_000_000 || !DIGEST.test(asset.sha256 ?? "")) {
      throw Error("Invalid manifest asset size or digest.");
    }
    rows.push(target + " " + asset.size + " " + asset.sha256);
  }
  if (new Set(assets.map((a) => a.name)).size !== TARGETS.length ||
      assets.some((a) => !names.has(a.name))) throw Error("Unexpected manifest asset.");
  return rows.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "generate") {
    process.stderr.write("Unknown manifest operation.\n");
    process.exit(2);
  }
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(renderAgentReleaseManifest(input.releaseTag, input.candidates));
  } catch (e) {
    process.stderr.write("Invalid immutable Release manifest input: " + e.message + "\n");
    process.exit(1);
  }
}
