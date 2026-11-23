/**
 * Windows x64 portable preview staging only. No upload or Release publishing.
 * CI must pass the independently pinned Node.js 24.21.0 node.exe SHA-256.
 * Only the static runtime dependency graph and the ACL helper are included.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runtimeSources } from "./build-v2-release.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_NODE_VERSION = "v24.21.0";
const EXPECTED_NODE_SHA256 =
  "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32";

export function parseWindowsPreviewBuildArgs(argv) {
  const keys = new Map([
    ["--version", "version"], ["--node-bin", "nodeBin"], ["--node-sha256", "nodeSha256"],
    ["--out", "out"], ["--background-bin", "backgroundBin"],
    ["--rust-agent-bin", "rustAgentBin"], ["--rust-agent-sha256", "rustAgentSha256"],
    ["--artifact-profile", "artifactProfile"],
  ]);
  const out = {};
  if (![10, 14, 16].includes(argv.length)) throw Error("Windows candidate requires five pinned inputs and an optional Rust candidate pair.");
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys.get(argv[i]);
    if (!key || out[key] !== undefined || !argv[i + 1]) throw Error("Unsafe packaging arguments.");
    out[key] = argv[i + 1];
  }
  if ((out.artifactProfile !== undefined && (out.artifactProfile !== "rust-native-only-v1" || !out.rustAgentBin)) ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(out.version) ||
      !/^[a-f0-9]{64}$/.test(out.nodeSha256) ||
      out.nodeSha256 !== EXPECTED_NODE_SHA256 ||
      !path.isAbsolute(out.nodeBin) || !path.isAbsolute(out.backgroundBin) || !path.isAbsolute(out.out) ||
      ((out.rustAgentBin === undefined) !== (out.rustAgentSha256 === undefined)) ||
      (out.rustAgentBin !== undefined && (!path.isAbsolute(out.rustAgentBin) ||
        !/^[a-f0-9]{64}$/.test(out.rustAgentSha256) ||
        !/-rust-candidate\.[1-9][0-9]*$/.test(out.version)))) {
    throw Error("A reviewed version, paths and official pinned node.exe digest are required.");
  }
  return out;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function rewriteImports(source) {
  return source.replace(/(\b(?:from\s*|import\s*\(\s*)["'][^"']+)\.ts(["'])/g, "$1.js$2");
}

export function buildWindowsPreview(args) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw Error("Windows x64 native packaging is required.");
  const nativeOnly = args.artifactProfile === "rust-native-only-v1";
  if (nativeOnly && (!args.rustAgentBin || !/-rust-candidate\.[1-9][0-9]*$/.test(args.version)))
    throw Error("Native-only packaging is restricted to reviewed Rust prerelease candidates.");
  if (!statSync(args.nodeBin).isFile() ||
      digest(readFileSync(args.nodeBin)) !== EXPECTED_NODE_SHA256)
    throw Error("Official Node.js Windows x64 checksum mismatch.");
  const version = spawnSync(args.nodeBin, ["--version"], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  if (version.error || version.status !== 0 || version.stdout.trim() !== EXPECTED_NODE_VERSION)
    throw Error("Pinned native Windows Node.js 24 executable unavailable.");
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
  for (const relative of ["bin", "apps/remote-control-agent/scripts", ...(nativeOnly ? [] : ["apps/remote-control-agent/src"])]) {
    mkdirSync(path.join(stage, relative), { recursive: true, mode: 0o700 });
  }
  if (!nativeOnly) copyFileSync(args.nodeBin, path.join(stage, "bin/node.exe"));
  copyFileSync(args.backgroundBin, path.join(stage, "bin/rca-background.exe"));
  let rustAgentHash;
  if (args.rustAgentBin) {
    const rustAgent = readFileSync(args.rustAgentBin);
    const pe = rustAgent.length >= 256 ? rustAgent.readUInt32LE(0x3c) : 0;
    if (digest(rustAgent) !== args.rustAgentSha256 || rustAgent.toString("ascii",0,2) !== "MZ" ||
        pe < 64 || pe + 96 > rustAgent.length || rustAgent.readUInt32LE(pe) !== 0x00004550 ||
        rustAgent.readUInt16LE(pe + 4) !== 0x8664) {
      throw Error("Rust candidate must be a hash-verified native Windows x64 PE executable.");
    }
    mkdirSync(path.join(stage,"apps/remote-control-agent/.build"),{recursive:true,mode:0o700});
    copyFileSync(args.rustAgentBin,path.join(stage,"apps/remote-control-agent/.build/rca-standard-windows-candidate.exe"));
    rustAgentHash=digest(rustAgent);
  }
  const modules = nativeOnly ? [] : runtimeSources(["windows-v2.ts", "session-rca-windows.ts"]);
  const hashes = {
    ...(!nativeOnly ? {"bin/node.exe": EXPECTED_NODE_SHA256} : {}),
    "bin/rca-background.exe": digest(launcher),
  };
  if (rustAgentHash) hashes["apps/remote-control-agent/.build/rca-standard-windows-candidate.exe"] = rustAgentHash;
  for (const file of modules) {
    const src = readFileSync(path.join(root, "src", file), "utf8");
    const compiled = ts.transpileModule(src, {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    if ((compiled.diagnostics || []).some(item => item.category === ts.DiagnosticCategory.Error))
      throw Error("Windows runtime TypeScript compilation failed.");
    const name = "apps/remote-control-agent/src/" + file.replace(/\.ts$/, ".js");
    const content = rewriteImports(compiled.outputText);
    writeFileSync(path.join(stage, name), content, { mode: 0o600 });
    hashes[name] = digest(Buffer.from(content));
  }
  // Preserve the same rca.cmd entry; the native candidate currently
  // exposes only status and refuses unsupported management operations.
  const launcherSource = nativeOnly
    ? '@echo off\nsetlocal DisableDelayedExpansion\n"%~dp0apps\\remote-control-agent\\.build\\rca-standard-windows-candidate.exe" --cli %*\nexit /b %ERRORLEVEL%\n'
    : readFileSync(path.join(root, "scripts/windows-rca.cmd"), "utf8");
  const launcherBytes = Buffer.from(launcherSource.replace(/\r?\n/g, "\r\n"));
  writeFileSync(path.join(stage, "rca.cmd"), launcherBytes, { mode: 0o600 });
  hashes["rca.cmd"] = digest(launcherBytes);
  // Bundle the already-reviewed public installer itself for StageOnly use.
  // One immutable source for Release/JWT-independent checks; do not fetch or
  // execute a remote PowerShell script at upgrade time.
  const stageInstaller = "apps/remote-control-agent/scripts/windows-stage-install.ps1";
  const installerBytes = readFileSync(path.join(root, "install.ps1"));
  writeFileSync(path.join(stage, stageInstaller), installerBytes, { mode: 0o600 });
  hashes[stageInstaller] = digest(installerBytes);
  const scripts = nativeOnly
    ? ["windows-private-store.ps1", "windows-user-task.ps1", "verify-windows-native.ps1"]
    : ["windows-private-store.ps1", "windows-session-private-store.ps1", "windows-user-task.ps1", "verify-windows-preview.mjs"];
  for (const name of scripts) {
    const relative = "apps/remote-control-agent/scripts/" + name;
    const bytes = readFileSync(path.join(root, "scripts", name));
    writeFileSync(path.join(stage, relative), bytes, { mode: 0o600 });
    hashes[relative] = digest(bytes);
  }
  if (!nativeOnly) {
    const packageJson = Buffer.from('{"type":"module"}\n');
    const packagePath = "apps/remote-control-agent/package.json";
    writeFileSync(path.join(stage, packagePath), packageJson, { mode: 0o600 });
    hashes[packagePath] = digest(packageJson);
  }
  writeFileSync(path.join(stage, "bundle.json"), JSON.stringify({
    name: "remote-control-agent", version: args.version, target: "windows-x64",
    ...(nativeOnly ? {artifact_profile:"rust-native-only-v1"} : {node:EXPECTED_NODE_VERSION}),
    device_protocol: 2, artifact_schema: 1,
    upgrade_profile: "paired-full-v1",
    ...(rustAgentHash ? {agent_runtime:"rust-standard-windows-v1",
      runtime_profile:"standard-windows-rust-runtime-v1"} : {agent_runtime:"node-standard-windows-v2"}),
    preview: true, modules, hashes,
  }, null, 2) + "\n", { mode: 0o600 });
  return {
    stage, target: "windows-x64", modules: modules.length,
    ...(nativeOnly ? {artifact_profile:"rust-native-only-v1"} : {nodeSha256:EXPECTED_NODE_SHA256}),
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
