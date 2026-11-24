/** Windows x64 Rust-native archive staging only; never publishes a Release. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digestPattern = /^[a-f0-9]{64}$/;
function rustBuildVersion(version) {
  return /^v0\.[1-9][0-9]*\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?$/.test(version);
}

export function parseWindowsPreviewBuildArgs(argv) {
  const keys = new Map([
    ["--version", "version"], ["--out", "out"], ["--background-bin", "backgroundBin"],
    ["--rust-agent-bin", "rustAgentBin"], ["--rust-agent-sha256", "rustAgentSha256"],
    ["--artifact-profile", "artifactProfile"],
    ["--rust-session-bin", "rustSessionBin"], ["--rust-session-sha256", "rustSessionSha256"],
  ]);
  const args = {};
  if (![12, 16].includes(argv.length)) throw Error("Windows packaging requires the Rust native-only profile.");
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys.get(argv[i]);
    if (!key || args[key] !== undefined || !argv[i + 1]) throw Error("Unsafe packaging arguments.");
    args[key] = argv[i + 1];
  }
  validateNativeInputs(args);
  return args;
}

function validateNativeInputs(args) {
  if (args.artifactProfile !== "rust-native-only-v1" || !rustBuildVersion(args.version) ||
      ![args.out, args.backgroundBin, args.rustAgentBin].every(value => typeof value === "string" && path.isAbsolute(value)) ||
      !digestPattern.test(args.rustAgentSha256) || args.nodeBin !== undefined || args.nodeSha256 !== undefined ||
      ((args.rustSessionBin === undefined) !== (args.rustSessionSha256 === undefined)) ||
      (args.rustSessionBin !== undefined && (!path.isAbsolute(args.rustSessionBin) || !digestPattern.test(args.rustSessionSha256)))) {
    throw Error("Windows packaging requires reviewed Rust native-only inputs.");
  }
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function buildWindowsPreview(args) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("Windows x64 native packaging is required.");
  validateNativeInputs(args);
  const launcher = readFileSync(args.backgroundBin);
  const header = launcher.length >= 256 ? launcher.readUInt32LE(0x3c) : 0;
  if (launcher.toString("ascii", 0, 2) !== "MZ" || header < 64 ||
      header + 96 > launcher.length || launcher.readUInt32LE(header) !== 0x00004550 ||
      launcher.readUInt16LE(header + 24 + 68) !== 2) {
    throw Error("Native background launcher must have a real Windows GUI subsystem.");
  }
  if (existsSync(args.out) && readdirSync(args.out).length !== 0)
    throw Error("Untrusted non-empty candidate output directory.");
  mkdirSync(args.out, { recursive: true, mode: 0o700 });
  const stage = path.join(args.out, "remote-control-agent-" + args.version + "-windows-x64");
  for (const relative of ["bin", "apps/remote-control-agent/scripts"]) {
    mkdirSync(path.join(stage, relative), { recursive: true, mode: 0o700 });
  }
  copyFileSync(args.backgroundBin, path.join(stage, "bin/rca-background.exe"));
  const hasSession = Boolean(args.rustSessionBin || args.rustSessionSha256);
  function checkedRustBinary(binary,expected) {
    const rustAgent = readFileSync(binary);
    const pe = rustAgent.length >= 256 ? rustAgent.readUInt32LE(0x3c) : 0;
    if (digest(rustAgent) !== expected || rustAgent.toString("ascii",0,2) !== "MZ" ||
        pe < 64 || pe + 96 > rustAgent.length || rustAgent.readUInt32LE(pe) !== 0x00004550 ||
        rustAgent.readUInt16LE(pe + 4) !== 0x8664) {
      throw Error("Rust candidate must be a hash-verified native Windows x64 PE executable.");
    }
    return rustAgent;
  }
  const rustAgent = checkedRustBinary(args.rustAgentBin,args.rustAgentSha256);
  mkdirSync(path.join(stage,"apps/remote-control-agent/.build"),{recursive:true,mode:0o700});
  writeFileSync(path.join(stage,"apps/remote-control-agent/.build/rca-standard-windows-candidate.exe"),rustAgent);
  const rustAgentHash=digest(rustAgent);
  let rustSessionHash;
  if (hasSession) {
    const binary=checkedRustBinary(args.rustSessionBin,args.rustSessionSha256);
    writeFileSync(path.join(stage,"apps/remote-control-agent/.build/rca-session-windows-candidate.exe"),binary);
    rustSessionHash=digest(binary);
  }
  const hashes = {
    "bin/rca-background.exe": digest(launcher),
    "apps/remote-control-agent/.build/rca-standard-windows-candidate.exe": rustAgentHash,
  };
  if (rustSessionHash) hashes["apps/remote-control-agent/.build/rca-session-windows-candidate.exe"] = rustSessionHash;
  const launcherSource = '@echo off\nsetlocal DisableDelayedExpansion\n"%~dp0apps\\remote-control-agent\\.build\\rca-standard-windows-candidate.exe" --cli %*\nexit /b %ERRORLEVEL%\n';
  const launcherBytes = Buffer.from(launcherSource.replace(/\r?\n/g, "\r\n"));
  writeFileSync(path.join(stage, "rca.cmd"), launcherBytes, { mode: 0o600 });
  hashes["rca.cmd"] = digest(launcherBytes);
  // Bundle the same reviewed installer for staging and pinned candidate onboarding.
  // One immutable source for Release/JWT-independent checks; do not fetch or
  // execute a remote PowerShell script at upgrade time.
  const stageInstaller = "apps/remote-control-agent/scripts/windows-stage-install.ps1";
  const installerBytes = readFileSync(path.join(root, "install.ps1"));
  writeFileSync(path.join(stage, stageInstaller), installerBytes, { mode: 0o600 });
  hashes[stageInstaller] = digest(installerBytes);
  const scripts = ["windows-private-store.ps1", "windows-user-task.ps1", "verify-windows-native.ps1"];
  for (const name of scripts) {
    const relative = "apps/remote-control-agent/scripts/" + name;
    const bytes = readFileSync(path.join(root, "scripts", name));
    writeFileSync(path.join(stage, relative), bytes, { mode: 0o600 });
    hashes[relative] = digest(bytes);
  }
  writeFileSync(path.join(stage, "bundle.json"), JSON.stringify({
    name: "remote-control-agent", version: args.version, target: "windows-x64",
    artifact_profile:"rust-native-only-v1",
    device_protocol: 2, artifact_schema: 1,
    upgrade_profile: "paired-full-v1",
    agent_runtime:"rust-standard-windows-v1",
    runtime_profile:"standard-windows-rust-runtime-v1",
    ...(rustSessionHash ? {session_runtime:"rust-session-v1"} : {}),
    preview: true, modules: [], hashes,
  }, null, 2) + "\n", { mode: 0o600 });
  return {
    stage, target: "windows-x64", modules: 0,
    artifact_profile:"rust-native-only-v1",
    releasePublished: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildWindowsPreview(parseWindowsPreviewBuildArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write("Windows bundle candidate refused: untrusted native input.\n");
    process.exitCode = 1;
  }
}
