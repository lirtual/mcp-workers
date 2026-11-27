import { renderPackagedMacUpdateShell } from "../../src/install-macos-latest.ts";
/**
 * Offline reviewed native-host packaging for Rust-only Linux and Darwin releases.
 * Produces deterministic unpublished archives; it never downloads or publishes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Nested package: apps/remote-control-mcp-worker/agent. Git identity is the monorepo root. */
export function darwinGitRoot(packageRoot = root) {
  return path.resolve(packageRoot, "../../..");
}
const ALLOWED = new Set(["linux-x64-glibc", "linux-arm64-glibc", "darwin-arm64", "darwin-x64"]);

export function parseArgs(argv) {
  const params = {};
  const names = new Map([
    ["--version","version"],["--target","target"],["--native","native"],
    ["--out","out"],["--native-sha256","nativeSha256"],
    ["--rust-agent-bin","rustAgentBin"],["--rust-agent-sha256","rustAgentSha256"],
    ["--artifact-profile","artifactProfile"],["--rust-session-bin","rustSessionBin"],
    ["--rust-session-sha256","rustSessionSha256"],
  ]);
  for (let i=0;i<argv.length;i+=2) {
    const key=names.get(argv[i]);
    if (!key || !argv[i+1] || Object.hasOwn(params,key)) throw new Error("Invalid packaging parameters.");
    params[key]=argv[i+1];
  }
  const absolute=value=>typeof value==="string" && path.isAbsolute(value);
  const hasSession=Boolean(params.rustSessionBin || params.rustSessionSha256);
  if (!ALLOWED.has(params.target) ||
      !/^v0\.[1-9][0-9]*\.[0-9]+$/.test(params.version) ||
      !absolute(params.native) || !absolute(params.out) ||
      !/^[a-f0-9]{64}$/.test(params.nativeSha256) ||
      params.artifactProfile!=="rust-native-only-v1" ||
      !absolute(params.rustAgentBin) || !/^[a-f0-9]{64}$/.test(params.rustAgentSha256) ||
      (hasSession && (params.target!=="linux-x64-glibc" ||
        !absolute(params.rustSessionBin) || !/^[a-f0-9]{64}$/.test(params.rustSessionSha256)))) {
    throw new Error("Rust-only packaging requires a stable tag, supported target, native binaries and SHA-256 digests.");
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

export function ensureNativeTarget({ target, native, nativeSha256, artifactProfile }) {
  if (artifactProfile!=="rust-native-only-v1" ||
      !/^[a-f0-9]{64}$/.test(nativeSha256 ?? "")) {
    throw new Error("All supported Agent packages must use verified Rust-only inputs.");
  }
  if (target==="darwin-arm64" || target==="darwin-x64") {
    const arch=target.slice("darwin-".length);
    const translated=arch==="x64" ? spawnSync("/usr/sbin/sysctl",
      ["-n","hw.optional.arm64"],{encoding:"utf8",timeout:2000}) : null;
    if (process.platform!=="darwin" || process.arch!==arch ||
        (translated && translated.status===0 && translated.stdout.trim()==="1") ||
        Number(os.release().split(".")[0])<24) {
      throw new Error("Darwin candidate requires a native macOS 15+ build host matching the target CPU.");
    }
    const helper=lstatSync(native);
    if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111)===0 ||
        machOMachine(readFileSync(native))!==arch ||
        createHash("sha256").update(readFileSync(native)).digest("hex")!==nativeSha256) {
      throw new Error("Darwin owned-group supervisor Mach-O architecture or digest mismatch.");
    }
    return {arch,libc:undefined,glibcMin:undefined};
  }
  const arch=target==="linux-x64-glibc" ? "x64" : "arm64";
  const id=arch==="x64" ? 62 : 183;
  if (process.platform!=="linux" || process.arch!==arch ||
      !process.report.getReport().header.glibcVersionRuntime) {
    throw new Error("Release must be assembled and tested on its native glibc Linux architecture.");
  }
  const st=lstatSync(native);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o111)===0)
    throw new Error("Required executable is not a regular file.");
  if (machine(native)!==id || createHash("sha256").update(readFileSync(native)).digest("hex")!==nativeSha256)
    throw new Error("Native supervisor architecture or checksum mismatch.");
  const probe=spawnSync(native,["--probe"],{detached:true,stdio:"ignore",timeout:5000});
  if (probe.error || probe.status!==0) throw new Error("Native Supervisor pidfd ABI is unavailable.");
  const [major,minor]=requiredGlibcVersion(native).split(".").map(Number);
  if (major>2 || (major===2 && minor>34)) throw new Error("Native supervisor exceeds the supported glibc 2.34 ABI.");
  return {arch,libc:process.report.getReport().header.glibcVersionRuntime,glibcMin:requiredGlibcVersion(native)};
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
    const mode = entry.directory ||
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

function tarball(dir, file) {
  const args=["--format=ustar","--sort=name","--owner=0","--group=0",
    "--numeric-owner","--mtime=@0","--mode=u+rwX,go-rwx","-cf","-","apps","bundle.json"];
  const tar=spawnSync("tar",args,{cwd:dir,maxBuffer:220*1024*1024});
  if (tar.status!==0 || tar.error) throw new Error("Deterministic tar creation failed.");
  const gzip=spawnSync("gzip",["-n","-9"],{input:tar.stdout,maxBuffer:220*1024*1024});
  if (gzip.status!==0 || gzip.error) throw new Error("Deterministic gzip failed.");
  writeFileSync(file,gzip.stdout,{flag:"wx",mode:0o600});
}

export function build(args) {
  const {arch,libc,glibcMin}=ensureNativeTarget(args);
  const rustCandidate=ensureRustCandidate({...args,maxGlibcMin:glibcMin});
  const darwin=args.target==="darwin-arm64" || args.target==="darwin-x64";
  const hasSession=Boolean(args.rustSessionBin || args.rustSessionSha256);
  if (hasSession && args.target!=="linux-x64-glibc")
    throw Error("Packaged Session entry is supported only in the Linux x64 Rust archive.");
  const sessionCandidate=hasSession ? ensureRustCandidate({
    target:args.target,rustAgentBin:args.rustSessionBin,
    rustAgentSha256:args.rustSessionSha256,maxGlibcMin:glibcMin,
  }) : null;
  const effectiveGlibcMin=darwin ? undefined :
    [requiredGlibcVersion(args.native),rustCandidate.glibcMin,
      ...(sessionCandidate ? [sessionCandidate.glibcMin] : [])].sort((a,b)=>{
        const [am,an]=a.split(".").map(Number),[bm,bn]=b.split(".").map(Number);
        return am-bm || an-bn;
      }).at(-1);
  if (existsSync(args.out) && readdirSync(args.out).length)
    throw new Error("Output must be a new or empty directory.");
  mkdirSync(args.out,{recursive:true,mode:0o700});
  const work=path.join(args.out,"bundle");
  mkdirSync(path.join(work,"apps/remote-control-agent/scripts"),{recursive:true,mode:0o700});
  mkdirSync(path.join(work,"apps/remote-control-agent/.build"),{recursive:true,mode:0o700});
  const helperFile=darwin ? "darwin-session-supervisor" : "session-supervisor";
  copyFileSync(args.native,path.join(work,"apps/remote-control-agent/.build",helperFile));
  const candidateName=darwin ? "rca-standard-darwin-candidate" : "rca-standard-linux-candidate";
  copyFileSync(args.rustAgentBin,path.join(work,"apps/remote-control-agent/.build",candidateName));
  if (sessionCandidate) {
    const dest=path.join(work,"apps/remote-control-agent/.build/rca-session-linux-candidate");
    copyFileSync(args.rustSessionBin,dest);
    chmodSync(dest,0o700);
  }
  for (const relative of ["apps/remote-control-agent/.build/"+helperFile,
      "apps/remote-control-agent/.build/"+candidateName]) {
    chmodSync(path.join(work,relative),0o700);
  }
  if (darwin) {
    writeFileSync(path.join(work,"apps/remote-control-agent/scripts/macos-update.sh"),
      renderPackagedMacUpdateShell(),{mode:0o600});
  } else {
    for (const name of ["bootstrap-v2.py","manage-v2.py","rca.sh"]) {
      const dest=path.join(work,"apps/remote-control-agent/scripts",name);
      copyFileSync(path.join(root,"scripts",name),dest);
      chmodSync(dest,["rca.sh","manage-v2.py"].includes(name) ? 0o700 : 0o600);
    }
  }
  const sourceCommit=darwin ? spawnSync("git",["rev-parse","HEAD"],{
    cwd:darwinGitRoot(root),encoding:"utf8",timeout:5000,
  }) : null;
  if (darwin && (sourceCommit.error || sourceCommit.status!==0 ||
      !/^[a-f0-9]{40}\s*$/.test(sourceCommit.stdout)))
    throw new Error("Cannot prove reviewed Darwin source commit.");
  const manifest={
    name:"remote-control-agent",version:args.version,target:args.target,
    artifact_profile:"rust-native-only-v1",
    agent_runtime:darwin ? "rust-standard-darwin-v1" : "rust-standard-linux-v1",
    ...(darwin ? {
      runtime_profile:"standard-darwin-rust-runtime-v1",
      candidate_profile:"darwin-permanent-local-v1",
      native_supervisor:"darwin-owned-group-v1",
      source_commit:sourceCommit.stdout.trim(),
    } : {
      candidate_profile:"standard-linux-rust-runtime-v1",
      glibc_build:libc,glibc_min:effectiveGlibcMin,
      upgrade_profile:"paired-full-v1",
    }),
    modules:[],
    ...(sessionCandidate ? {session_runtime:"rust-session-v1"} : {}),
    artifact_schema:1,device_protocol:2,receipt_schema:1,
  };
  writeFileSync(path.join(work,"bundle.json"),JSON.stringify(manifest)+"\n",{mode:0o600});
  const name="remote-control-agent-"+args.version+"-"+args.target+".tar.gz";
  const archivePath=path.join(args.out,name);
  if (darwin) tarballDarwin(work,archivePath);
  else tarball(work,archivePath);
  const artifact=readFileSync(archivePath);
  return {file:archivePath,sha256:createHash("sha256").update(artifact).digest("hex"),
    bytes:artifact.length,arch,artifact_profile:"rust-native-only-v1",
    libc,glibcMin:effectiveGlibcMin,modules:[]};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(build(parseArgs(process.argv.slice(2))))); }
  catch(error){ process.stderr.write("Local release package blocked: "+error.message+"\n"); process.exitCode=1; }
}
