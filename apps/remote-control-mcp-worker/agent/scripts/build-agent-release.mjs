import { renderPackagedMacUpdateShell } from "../../src/install-macos-latest.ts";
/**
 * Offline reviewed native-host packaging. Linux emits only the Rust-native
 * profile; Darwin retains Node v2 and its opt-in Rust prototype.
 * Produces deterministic unpublished archives, never downloads or publishes.
 * Linux uses the existing glibc 2.34 support boundary; only Darwin bundles Node.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Nested package: apps/remote-control-mcp-worker/agent. Git identity is the monorepo root. */
export function darwinGitRoot(packageRoot = root) {
  return path.resolve(packageRoot, "../../..");
}
const ALLOWED = new Set(["linux-x64-glibc", "linux-arm64-glibc", "darwin-arm64", "darwin-x64"]);
const source = path.join(root, "src");

export function parseArgs(argv) {
  const params = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--version", "--target", "--node-bin", "--native", "--out", "--node-sha256", "--native-sha256",
      "--rust-agent-bin", "--rust-agent-sha256", "--artifact-profile", "--rust-session-bin", "--rust-session-sha256"].includes(argv[i]) ||
      !argv[i+1] || argv.slice(0,i).filter((_,j)=>j%2===0).includes(argv[i])) throw new Error("Invalid packaging parameters.");
    params[{"--node-bin":"nodeBin","--node-sha256":"nodeSha256","--native-sha256":"nativeSha256",
      "--rust-agent-bin":"rustAgentBin","--rust-agent-sha256":"rustAgentSha256",
      "--artifact-profile":"artifactProfile", "--rust-session-bin":"rustSessionBin", "--rust-session-sha256":"rustSessionSha256"}[argv[i]] ?? argv[i].slice(2)] = argv[i+1];
  }
  const hasRustCandidate = Boolean(params.rustAgentBin || params.rustAgentSha256);
  const nativeOnly = params.artifactProfile === "rust-native-only-v1";
  const hasSession = Boolean(params.rustSessionBin || params.rustSessionSha256);
  const linux = params.target?.startsWith("linux-");
  if (linux && !nativeOnly)
    throw new Error("Linux packaging requires the Rust native-only profile.");
  const absolute = value => typeof value === "string" && path.isAbsolute(value);
  if (!ALLOWED.has(params.target) ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(params.version) ||
      !absolute(params.native) || !absolute(params.out) ||
      !/^[a-f0-9]{64}$/.test(params.nativeSha256) ||
      (nativeOnly && (params.nodeBin !== undefined || params.nodeSha256 !== undefined)) ||
      (!nativeOnly && (!absolute(params.nodeBin) || !/^[a-f0-9]{64}$/.test(params.nodeSha256))) ||
      (params.artifactProfile !== undefined && !nativeOnly) ||
      (nativeOnly && !hasRustCandidate) ||
      (hasRustCandidate && (!absolute(params.rustAgentBin) ||
        !/^[a-f0-9]{64}$/.test(params.rustAgentSha256) ||
        !(nativeOnly ? /^v0\.[1-9][0-9]*\.[0-9]+$/.test(params.version)
          : /^v0\.[1-9][0-9]*\.[0-9]+-rust-candidate\.[1-9][0-9]*$/.test(params.version)))) ||
      (hasSession && (!nativeOnly || params.target !== "linux-x64-glibc" ||
        !absolute(params.rustSessionBin) || !/^[a-f0-9]{64}$/.test(params.rustSessionSha256)))) {
    throw new Error("Specify a pinned version, supported target, absolute native paths and digests; Node input is Darwin-only.");
  }
  return params;
}

function machine(binary) {
  const b = readFileSync(binary);
  if (b.length < 64 || b.toString("hex", 0, 4) !== "7f454c46" ||
      b[4] !== 2 || b[5] !== 1) throw new Error("Expected a 64-bit little-endian ELF executable.");
  return b.readUInt16LE(18);
}

/** Native 64-bit little-endian Mach-O only; reject FAT/Rosetta and ELF. */
export function machOMachine(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(12) !== 2) throw new Error("Expected a native 64-bit Mach-O executable.");
  const cpu = bytes.readUInt32LE(4);
  if (cpu === 0x0100000c) return "arm64";
  if (cpu === 0x01000007) return "x64";
  throw new Error("Unsupported Mach-O CPU.");
}

export function ensureRustCandidate({target, rustAgentBin, rustAgentSha256, maxGlibcMin,
  invoke = spawnSync}) {
  const darwin = target === "darwin-arm64" || target === "darwin-x64";
  const linux = target === "linux-x64-glibc" || target === "linux-arm64-glibc";
  if ((!darwin && !linux) || !path.isAbsolute(rustAgentBin) ||
      !/^[a-f0-9]{64}$/.test(rustAgentSha256) ||
      (linux && !/^[0-9]+\.[0-9]+$/.test(maxGlibcMin ?? ""))) {
    throw new Error("Rust Agent candidate requires a pinned native binary and platform ABI constraints.");
  }
  const info = lstatSync(rustAgentBin);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Rust Agent candidate must be a regular, nonlinked file.");
  }
  const digest = createHash("sha256").update(readFileSync(rustAgentBin)).digest("hex");
  if (digest !== rustAgentSha256) throw new Error("Rust Agent candidate SHA-256 mismatch.");
  if (darwin) {
    const arch = target.slice("darwin-".length);
    if (process.platform !== "darwin" || process.arch !== arch ||
        machOMachine(readFileSync(rustAgentBin)) !== arch) {
      throw new Error("Rust Agent candidate requires a native matching Darwin Mach-O binary.");
    }
    return {};
  }
  const expected = target === "linux-x64-glibc" ? 62 : 183;
  if (machine(rustAgentBin) !== expected) throw new Error("Rust Agent candidate architecture mismatch.");
  const glibcMin = requiredGlibcVersion(rustAgentBin, invoke);
  const parts = value => value.split(".").map(Number);
  const [candidateMajor,candidateMinor] = parts(glibcMin);
  const [limitMajor,limitMinor] = parts(maxGlibcMin);
  if (candidateMajor > limitMajor ||
      (candidateMajor === limitMajor && candidateMinor > limitMinor)) {
    throw new Error("Rust Agent candidate exceeds the existing release glibc_min; build with a compatible toolchain.");
  }
  return {glibcMin};
}

export function requiredGlibcVersion(binary, invoke = spawnSync) {
  const result = invoke("readelf", ["--version-info", binary], {
    encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Cannot determine native ELF glibc ABI; readelf is required on build host.");
  }
  const versions = [...result.stdout.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)]
    .map(match => [Number(match[1]), Number(match[2])]);
  if (!versions.length) {
    throw new Error("ELF binary has no verifiable glibc version requirements.");
  }
  versions.sort((a,b) => a[0] - b[0] || a[1] - b[1]);
  return versions.at(-1).join(".");
}

export function ensureNativeTarget({ target, nodeBin, native, nodeSha256, nativeSha256, artifactProfile }) {
  if (target === "darwin-arm64" || target === "darwin-x64") {
    const arch = target.slice("darwin-".length);
    // Never count a Rosetta-translated x64 process as an Intel build host.
    const translated = arch === "x64" && spawnSync("/usr/sbin/sysctl",
      ["-n","hw.optional.arm64"],{encoding:"utf8",timeout:2000});
    if (process.platform !== "darwin" || process.arch !== arch ||
        (translated && translated.status === 0 && translated.stdout.trim() === "1") ||
        Number(os.release().split(".")[0]) < 24) {
      throw new Error("Darwin candidate requires a native macOS 15+ build host matching the target CPU.");
    }
    let nodeVersion;
    if (artifactProfile === "rust-native-only-v1") {
      if (nodeBin !== undefined || nodeSha256 !== undefined)
        throw Error("Native-only packaging must not depend on Node.");
    } else {
      const st = statSync(nodeBin);
      if (!st.isFile() || (st.mode & 0o111) === 0 ||
          machOMachine(readFileSync(nodeBin)) !== arch ||
          createHash("sha256").update(readFileSync(nodeBin)).digest("hex") !== nodeSha256) {
        throw new Error("Pinned native Mach-O Node checksum or architecture mismatch.");
      }
      const version = spawnSync(nodeBin, ["--version"], { encoding:"utf8", timeout:5000 });
      if (version.error || version.status !== 0 || !/^v24\.[0-9]+\.[0-9]+\s*$/.test(version.stdout)) {
        throw new Error("Candidate requires native Node 24.");
      }
      nodeVersion=version.stdout.trim();
    }
    const helper=lstatSync(native);
    if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111)===0 ||
        machOMachine(readFileSync(native))!==arch ||
        createHash("sha256").update(readFileSync(native)).digest("hex")!==nativeSha256) {
      throw new Error("Darwin owned-group supervisor Mach-O architecture or digest mismatch.");
    }
    return { arch, nodeVersion, libc:undefined, glibcMin:undefined };
  }
  const arch = target === "linux-x64-glibc" ? "x64" : "arm64";
  const id = arch === "x64" ? 62 : 183;
  if (process.platform !== "linux" || process.arch !== arch ||
      !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error("Release must be assembled and tested on its native glibc Linux architecture.");
  }
  if (nodeBin !== undefined || nodeSha256 !== undefined)
    throw new Error("Linux packaging must not depend on Node.");
  const st = lstatSync(native);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o111) === 0)
    throw new Error("Required executable is not a regular file.");
  if (machine(native) !== id) throw new Error("ELF architecture mismatch.");
  if (!/^[a-f0-9]{64}$/.test(nativeSha256) ||
      createHash("sha256").update(readFileSync(native)).digest("hex") !== nativeSha256)
    throw new Error("Pinned native binary checksum mismatch.");
  // Actual native group-pidfd probe: no command or separate process signaled.
  const probe = spawnSync(native, ["--probe"], { detached:true, stdio:"ignore", timeout:5000 });
  if (probe.error || probe.status !== 0) throw new Error("Native Supervisor pidfd ABI is unavailable.");
  // Preserve the actual published native ABI support boundary independently
  // of a retired Node executable. The manifest reports the actual max below.
  const [major, minor] = requiredGlibcVersion(native).split(".").map(Number);
  if (major > 2 || (major === 2 && minor > 34))
    throw Error("Native supervisor exceeds the supported glibc 2.34 ABI.");
  return { arch, glibcMin: "2.34", libc: process.report.getReport().header.glibcVersionRuntime };

}

function rewriteExtensions(text) {
  return text.replace(/(\b(?:from\s*|import\s*\(\s*)["'][^"']+)\.ts(["'])/g, "$1.js$2");
}

/** Follow static source dependency graph, no tests, checkout or node_modules copied. */
export function runtimeSources(entries) {
  const visited = new Set();
  function walk(name) {
    if (!/^[a-z0-9-]+\.ts$/.test(name)) throw new Error("Unreviewed runtime import: " + name);
    if (visited.has(name)) return;
    const file = path.join(source, name);
    if (!existsSync(file) || !realpathSync(file).startsWith(realpathSync(source) + path.sep)) {
      throw new Error("Missing or linked runtime source: " + name);
    }
    visited.add(name);
    const src = readFileSync(file, "utf8");
    const pp = ts.preProcessFile(src, true, true);
    for (const imp of pp.importedFiles) {
      const dependency = imp.fileName;
      if (dependency.startsWith("node:")) continue;
      if (!dependency.startsWith("./") || !dependency.endsWith(".ts")) {
        throw new Error("An external dependency needs separate review: " + dependency);
      }
      walk(dependency.slice(2));
    }
  }
  for (const e of entries) walk(e);
  return [...visited].sort();
}

/** macOS has BSD tar; produce the same canonical, private USTAR without GNU tar. */
function tarballDarwin(dir, file) {
  const chunks = [];
  const entries = [];
  function visit(relative) {
    for (const name of readdirSync(path.join(dir,relative)).sort()) {
      const next = relative ? relative + "/" + name : name;
      const st = lstatSync(path.join(dir,next));
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw Error("Unsafe bundle member.");
      entries.push({ name:next, directory:st.isDirectory() });
      if (st.isDirectory()) visit(next);
    }
  }
  visit("");
  function oct(header, offset, width, value) {
    const encoded = value.toString(8).padStart(width-1,"0")+"\0";
    if (encoded.length > width) throw Error("USTAR field overflow.");
    header.write(encoded,offset,width,"ascii");
  }
  for (const entry of entries) {
    const name = entry.name;
    if (Buffer.byteLength(name,"ascii") > 100 || !/^[A-Za-z0-9._/-]+$/.test(name))
      throw Error("Invalid candidate USTAR path.");
    const data = entry.directory ? Buffer.alloc(0) : readFileSync(path.join(dir,name));
    const header = Buffer.alloc(512);
    header.write(name,0,"ascii");
    const mode = entry.directory || name === "bin/node" ||
      name === "apps/remote-control-agent/.build/darwin-session-supervisor" ||
      name === "apps/remote-control-agent/.build/rca-standard-darwin-candidate" ? 0o700 : 0o600;
    oct(header,100,8,mode);oct(header,108,8,0);oct(header,116,8,0);
    oct(header,124,12,data.length);oct(header,136,12,0);
    header.fill(32,148,156); header.write(entry.directory ? "5" : "0",156,"ascii");
    header.write("ustar\0",257,"ascii"); header.write("00",263,"ascii");
    oct(header,148,8,header.reduce((sum,n)=>sum+n,0));
    chunks.push(header,data);
    if (data.length%512) chunks.push(Buffer.alloc(512-data.length%512));
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(file,gzipSync(Buffer.concat(chunks),{level:9,mtime:0}),{flag:"wx",mode:0o600});
}

function tarball(dir, file, nativeOnly = false) {
  const args = ["--format=ustar", "--sort=name", "--owner=0", "--group=0",
    "--numeric-owner", "--mtime=@0", "--mode=u+rwX,go-rwx", "-cf", "-",
    ...(nativeOnly ? [] : ["bin"]), "apps", "bundle.json"];
  const tar = spawnSync("tar", args, { cwd:dir, maxBuffer:220*1024*1024 });
  if (tar.status !== 0 || tar.error) throw new Error("Deterministic tar creation failed.");
  const gzip = spawnSync("gzip", ["-n", "-9"], { input:tar.stdout, maxBuffer:220*1024*1024 });
  if (gzip.status !== 0 || gzip.error) throw new Error("Deterministic gzip failed.");
  writeFileSync(file, gzip.stdout, {flag:"wx", mode:0o600});
}

export function build(args) {
  const { arch, nodeVersion, libc, glibcMin } = ensureNativeTarget(args);
  const rustCandidate = args.rustAgentBin
    ? ensureRustCandidate({...args,maxGlibcMin:glibcMin}) : null;
  const darwin = args.target === "darwin-arm64" || args.target === "darwin-x64";
  const nativeOnly = args.artifactProfile === "rust-native-only-v1";
  if ((!darwin && !nativeOnly) || (nativeOnly && !rustCandidate))
    throw Error("Native-only packaging requires reviewed Rust binaries.");
  const hasSession = Boolean(args.rustSessionBin || args.rustSessionSha256);
  if (hasSession && (!nativeOnly || args.target !== "linux-x64-glibc"))
    throw Error("Packaged Session entry requires reviewed Linux x64 native-only archive.");
  const sessionCandidate = hasSession ? ensureRustCandidate({
    target:args.target, rustAgentBin:args.rustSessionBin,
    rustAgentSha256:args.rustSessionSha256,maxGlibcMin:glibcMin,
  }) : null;
  // No runtime Node symbols may determine the ABI floor of a Node-free archive.
  const effectiveGlibcMin = nativeOnly && !darwin
    ? [requiredGlibcVersion(args.native),rustCandidate.glibcMin,
      ...(sessionCandidate ? [sessionCandidate.glibcMin] : [])].sort((a,b)=>{
      const [am,an]=a.split(".").map(Number),[bm,bn]=b.split(".").map(Number);
      return am-bm || an-bn;
    }).at(-1) : glibcMin;
  if (existsSync(args.out) && readdirSync(args.out).length) {
    throw new Error("Output must be a new or empty directory.");
  }
  mkdirSync(args.out, {recursive:true, mode:0o700});
  const work = path.join(args.out, "bundle");
  if (!nativeOnly) {
    mkdirSync(path.join(work, "bin"), {recursive:true,mode:0o700});
    mkdirSync(path.join(work, "apps/remote-control-agent/src"), {recursive:true,mode:0o700});
  }
  if (!darwin || !nativeOnly) mkdirSync(path.join(work, "apps/remote-control-agent/scripts"), {recursive:true,mode:0o700});
  mkdirSync(path.join(work, "apps/remote-control-agent/.build"), {recursive:true,mode:0o700});
  if (!nativeOnly) copyFileSync(args.nodeBin, path.join(work, "bin/node"));
  const helperFile=darwin ? "darwin-session-supervisor" : "session-supervisor";
  copyFileSync(args.native, path.join(work, "apps/remote-control-agent/.build",helperFile));
  if (rustCandidate) {
    const candidateName = darwin ? "rca-standard-darwin-candidate" : "rca-standard-linux-candidate";
    copyFileSync(args.rustAgentBin,
      path.join(work, "apps/remote-control-agent/.build",candidateName));
  }
  if (sessionCandidate) {
    const dest=path.join(work,"apps/remote-control-agent/.build/rca-session-linux-candidate");
    copyFileSync(args.rustSessionBin,dest);
    chmodSync(dest,0o700);
  }
  for (const relative of [...(nativeOnly ? [] : ["bin/node"]),
      "apps/remote-control-agent/.build/"+helperFile,
      ...(rustCandidate ? ["apps/remote-control-agent/.build/"+
        (darwin ? "rca-standard-darwin-candidate" : "rca-standard-linux-candidate")] : [])]) {
    chmodSync(path.join(work,relative),0o700);
  }
  // Retain the actual shared macOS full-tool and freeze gate, without depending on the retired Linux entry.
  const lifecycleSource=darwin && !nativeOnly ? readFileSync(path.join(source,"v2-connection-lifecycle.ts"),"utf8") : "";
  if(darwin && !nativeOnly && (!/const full = options\.capability !== "read-only"/.test(lifecycleSource) ||
     !/receiptDirectory:\s*options\.receiptDirectory/.test(lifecycleSource) ||
     !/startUpgradeControl\(execution(?:!)?, keyPath, \(\) => authenticatedOnline && !signal\.aborted && !options\.sessionIdle\)/.test(lifecycleSource) ||
     !/executeV2FileOperation\(execution,/.test(lifecycleSource) ||
     !/executeV2SessionRead\(execution,/.test(lifecycleSource))) {
    throw new Error("Reviewed paired full-tools release profile is not proven.");
  }
  const modules = nativeOnly ? [] : runtimeSources(["macos-temporary.ts", "macos-permanent.ts"]);
  for(const file of modules){
    const src=readFileSync(path.join(source,file),"utf8");
    const compiled=ts.transpileModule(src,{fileName:file,reportDiagnostics:true,
      compilerOptions:{ module:ts.ModuleKind.ESNext, target:ts.ScriptTarget.ES2022, removeComments:false }});
    const errors=(compiled.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
    if(errors.length) throw new Error("TS compilation error in "+file);
    writeFileSync(path.join(work,"apps/remote-control-agent/src",file.replace(/\.ts$/,".js")),
      rewriteExtensions(compiled.outputText),{mode:0o600});
  }
  if (darwin && !nativeOnly) {
    const local=path.join(root,"scripts/macos-local.mjs");
    const localDest=path.join(work,"apps/remote-control-agent/scripts/macos-local.mjs");
    const remoteDest=path.join(work,"apps/remote-control-agent/scripts/macos-remote-upgrade.mjs");
    copyFileSync(local,localDest);
    copyFileSync(path.join(root,"scripts/macos-remote-upgrade.mjs"),remoteDest);
    chmodSync(localDest,0o600);
    chmodSync(remoteDest,0o600);
    writeFileSync(path.join(work,"apps/remote-control-agent/scripts/macos-update.sh"),
      renderPackagedMacUpdateShell(),{mode:0o600});
  }
  if (!darwin) {
    for (const name of ["bootstrap-v2.py", "manage-v2.py", "rca.sh"]) {
      const dest = path.join(work, "apps/remote-control-agent/scripts", name);
      copyFileSync(path.join(root, "scripts", name), dest);
      chmodSync(dest, ["rca.sh", "manage-v2.py"].includes(name) ? 0o700 : 0o600);
    }
  }
  if (!nativeOnly) writeFileSync(path.join(work,"apps/remote-control-agent/package.json"),
    JSON.stringify({type:"module"})+"\n",{mode:0o600});
  const sourceCommit=darwin ? spawnSync("git",["rev-parse","HEAD"],{
    cwd:darwinGitRoot(root),encoding:"utf8",timeout:5000,
  }) : null;
  if (darwin && (sourceCommit.error || sourceCommit.status!==0 ||
      !/^[a-f0-9]{40}\s*$/.test(sourceCommit.stdout)))
    throw new Error("Cannot prove reviewed Darwin source commit.");
  writeFileSync(path.join(work,"bundle.json"),JSON.stringify({
    name:"remote-control-agent",version:args.version,target:args.target,
    ...(nativeOnly ? {artifact_profile:"rust-native-only-v1"} : {node:nodeVersion}),
    ...(rustCandidate ? (darwin ? {
      agent_runtime:"rust-standard-darwin-v1",
      runtime_profile:"standard-darwin-rust-runtime-v1",
    } : {agent_runtime:"rust-standard-linux-v1",
      candidate_profile:"standard-linux-rust-runtime-v1"}) : {agent_runtime:"node-v2"}),
    ...(darwin ? {candidate_profile:"darwin-permanent-local-v1",native_supervisor:"darwin-owned-group-v1",source_commit:sourceCommit.stdout.trim()} :
      {glibc_build:libc,glibc_min:effectiveGlibcMin}),modules,
    ...(sessionCandidate ? {session_runtime:"rust-session-v1"} : {}),
    artifact_schema:1,device_protocol:2,receipt_schema:1,
    ...(!darwin ? {upgrade_profile:"paired-full-v1"} : {})
  })+"\n",{mode:0o600});
  const name="remote-control-agent-"+args.version+"-"+args.target+".tar.gz";
  if (darwin) tarballDarwin(work,path.join(args.out,name));
  else tarball(work,path.join(args.out,name),nativeOnly);
  const artifact=readFileSync(path.join(args.out,name));
  return {file:path.join(args.out,name),sha256:createHash("sha256").update(artifact).digest("hex"),
    bytes:artifact.length,arch,
    ...(nativeOnly ? {artifact_profile:"rust-native-only-v1"} : {nodeVersion}),
    libc,glibcMin:effectiveGlibcMin,modules};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(build(parseArgs(process.argv.slice(2))))); }
  catch(error){ process.stderr.write("Local release package blocked: "+error.message+"\n"); process.exitCode=1; }
}
