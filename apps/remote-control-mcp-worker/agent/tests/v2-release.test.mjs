import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {readFileSync,realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir, symlink, copyFile, access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { parseArgs, runtimeSources, ensureNativeTarget, ensureRustCandidate,
  requiredGlibcVersion } from "../scripts/build-v2-release.mjs";
import { resolvePinnedRelease, downloadPinnedAsset, inspectTarGzip, extractVerifiedAsset, releaseAssetName } from "../scripts/verify-v2-release.mjs";

const tag="v0.1.0",target="linux-x64-glibc",commit="1".repeat(40);
const sha=b=>createHash("sha256").update(b).digest("hex");
function elf(machine) {
  const b=Buffer.alloc(80); b.writeUInt32BE(0x7f454c46,0);
  b[4]=2; b[5]=1; b.writeUInt16LE(machine,18);
  return b;
}
function macho(cpu) {
  const b=Buffer.alloc(80); b.writeUInt32LE(0xfeedfacf,0);
  b.writeUInt32LE(cpu,4); b.writeUInt32LE(2,12);
  return b;
}
function tar(entries) {
  const chunks=[];
  for(const {name,data=Buffer.alloc(0),type="0"} of entries) {
    const header=Buffer.alloc(512);
    header.write(name,0,"ascii");
    function writeOct(value,start,width){
      const v=value.toString(8).padStart(width-1,"0")+"\0";
      header.write(v,start,width,"ascii");
    }
    writeOct(0o600,100,8);writeOct(0,108,8);writeOct(0,116,8);
    writeOct(data.length,124,12);writeOct(0,136,12);
    header.fill(32,148,156);header.write(type,156,"ascii");
    header.write("ustar\0",257,"ascii");
    const sum=header.reduce((a,b)=>a+b,0);
    writeOct(sum,148,8);
    chunks.push(header,data,Buffer.alloc(Math.ceil(data.length/512)*512-data.length));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks),{mtime:0});
}
function fixture(extra=[],opts={}) {
  const manifest=Buffer.from(JSON.stringify({name:"remote-control-agent",artifact_schema:1,version:tag,target,node:"v24.21.0",modules:["v2-main.ts"],...opts}));
  return tar([
    {name:"bin/node",data:elf(62)},
    {name:"bundle.json",data:manifest},
    {name:"apps/remote-control-agent/package.json",data:Buffer.from('{"type":"module"}')},
    {name:"apps/remote-control-agent/src/v2-main.js",data:Buffer.from("console.log('ok')")},
    {name:"apps/remote-control-agent/scripts/install-v2.mjs",data:Buffer.from("export {}")},
    {name:"apps/remote-control-agent/.build/session-supervisor",data:elf(62)},
    ...extra,
  ]);
}
const api="https://api.github.com/repos/lirtual/remote-control-agent";
function mockGithub(buffer,{immutable=true,digest="sha256:"+sha(buffer),actualCommit=commit,assetSize=buffer.length,
  routeRedirect=null,repoEnabled=true,prerelease=false,releaseTag=tag}={}) {
  const assetName=releaseAssetName(releaseTag,target);
  const seen=[];
  async function send(url,init) {
    seen.push({url,init});
    const u=new URL(url);
    if(u.href===api+"/immutable-releases") return Response.json({enabled:repoEnabled});
    if(u.href===api+"/releases/tags/"+releaseTag) return Response.json({
      id:71,tag_name:releaseTag,draft:false,prerelease,immutable,assets:[
        {name:assetName,id:903,state:"uploaded",size:assetSize,
          digest,url:api+"/releases/assets/903"}]});
    if(u.href===api+"/git/ref/tags/"+releaseTag) return Response.json({
      ref:"refs/tags/"+releaseTag,object:{type:"commit",sha:actualCommit}});
    if(u.href===api+"/releases/assets/903") {
      if(routeRedirect) return new Response(null,{status:302,headers:{location:routeRedirect}});
      return new Response(buffer,{status:200,headers:{"content-type":"application/octet-stream"}});
    }
    if (u.hostname==="release-assets.githubusercontent.com") return new Response(buffer,{status:200});
    throw new Error("Unexpected URL "+url);
  }
  return {send,seen};
}

test("#73 release package build rejects unverified architectures and unpinned targets",async()=>{
  assert.deepEqual(parseArgs(["--version",tag,"--target",target,
    "--node-bin","/opt/node","--native","/opt/supervisor","--out","/tmp/archive",
    "--node-sha256","f".repeat(64),"--native-sha256","e".repeat(64)]),{
      version:tag,target,nodeBin:"/opt/node",native:"/opt/supervisor",out:"/tmp/archive",
      nodeSha256:"f".repeat(64),nativeSha256:"e".repeat(64)});
  for(const args of [
    ["--version","latest","--target",target,"--node-bin","/n","--native","/b","--out","/tmp/o"],
    ["--version",tag,"--target","linux-x64-musl","--node-bin","/n","--native","/b","--out","/tmp/o"],
    ["--version",tag,"--target",target,"--node-bin","node","--native","/b","--out","/tmp/o"],
  ]) assert.throws(()=>parseArgs(args));
  assert.ok(runtimeSources().includes("v2-main.ts"));
  assert.ok(runtimeSources().includes("upgrade-control.ts"));
  assert.ok(!runtimeSources().includes("main.ts"));
  assert.ok(!runtimeSources().includes("server.ts"));
  const candidateTag="v0.1.1-rust-candidate.1";
  const candidateArgs=parseArgs(["--version",candidateTag,"--target",target,
    "--node-bin","/opt/node","--native","/opt/supervisor","--out","/tmp/archive",
    "--node-sha256","f".repeat(64),"--native-sha256","e".repeat(64),
    "--rust-agent-bin","/opt/rca-agent","--rust-agent-sha256","d".repeat(64)]);
  assert.equal(candidateArgs.rustAgentBin,"/opt/rca-agent");
  assert.equal(candidateArgs.rustAgentSha256,"d".repeat(64));
  const darwinArgs=parseArgs(["--version","v0.1.57-rust-candidate.1","--target","darwin-arm64",
    "--node-bin","/opt/node","--native","/opt/supervisor","--out","/tmp/archive",
    "--node-sha256","f".repeat(64),"--native-sha256","e".repeat(64),
    "--rust-agent-bin","/opt/rca-darwin","--rust-agent-sha256","d".repeat(64)]);
  assert.equal(darwinArgs.target,"darwin-arm64");
  const darwinDir=await mkdtemp(path.join(os.tmpdir(),"rc-rust-darwin-gate-"));
  try{
    const binary=path.join(darwinDir,"rca-candidate");
    const bytes=macho(0x0100000c);await writeFile(binary,bytes,{mode:0o700});
    assert.throws(()=>ensureRustCandidate({target:"darwin-arm64",rustAgentBin:binary,
      rustAgentSha256:sha(bytes)}),/native matching Darwin Mach-O/);

  }finally{await rm(darwinDir,{recursive:true,force:true});}
  const rustDir=await mkdtemp(path.join(os.tmpdir(),"rc-rust-glibc-gate-"));
  try{
    const binary=path.join(rustDir,"rca-candidate");
    const bytes=elf(62);await writeFile(binary,bytes,{mode:0o700});
    const digest=sha(bytes);
    const readelf=version=>()=>({status:0,stdout:"Name: GLIBC_"+version});
    assert.equal(ensureRustCandidate({target,rustAgentBin:binary,rustAgentSha256:digest,
      maxGlibcMin:"2.34",invoke:readelf("2.34")}).glibcMin,"2.34");
    assert.throws(()=>ensureRustCandidate({target,rustAgentBin:binary,rustAgentSha256:digest,
      maxGlibcMin:"2.34",invoke:readelf("2.39")}),/exceeds the existing release glibc_min/);
    const link=path.join(rustDir,"linked-candidate");await symlink(binary,link);
    await assert.rejects(async()=>ensureRustCandidate({target,rustAgentBin:link,
      rustAgentSha256:digest,maxGlibcMin:"2.34",invoke:readelf("2.34")}),/nonlinked file/);
  }finally{await rm(rustDir,{recursive:true,force:true});}
  assert.throws(()=>parseArgs(["--version",tag,"--target",target,
    "--node-bin","/opt/node","--native","/opt/supervisor","--out","/tmp/archive",
    "--node-sha256","f".repeat(64),"--native-sha256","e".repeat(64),
    "--rust-agent-bin","/opt/rca-agent","--rust-agent-sha256","d".repeat(64)]),/packaging parameters|pinned version/);
  const candidateBytes=fixture([
    {name:"apps/remote-control-agent/.build/rca-standard-linux-candidate",data:elf(62)},
    {name:"apps/remote-control-agent/scripts/manage-v2.py",data:Buffer.from("inspection-only")},
  ],{version:candidateTag,agent_runtime:"rust-standard-linux-v1",
    candidate_profile:"standard-linux-rust-runtime-v1"});
  assert.ok(inspectTarGzip(candidateBytes,{tag:candidateTag,target})
    .has("apps/remote-control-agent/.build/rca-standard-linux-candidate"));
  assert.throws(()=>inspectTarGzip(fixture([
    {name:"apps/remote-control-agent/.build/rca-standard-linux-candidate",data:elf(62)},
  ],{version:candidateTag,agent_runtime:"rust-standard-linux-v1",
    candidate_profile:"standard-linux-rust-runtime-v1"}),{tag:candidateTag,target}),/runtime profile/,
  "Rust candidate cannot omit the exact reviewed Python local manager");
  const extractionParent=await mkdtemp(path.join(os.tmpdir(),"rc-rust-release-"));
  try{
    const destination=path.join(extractionParent,"candidate");
    const digest=sha(candidateBytes);
    await extractVerifiedAsset({tag:candidateTag,target,digest},candidateBytes,destination);
    const {mode}=await stat(
      path.join(destination,"apps/remote-control-agent/.build/rca-standard-linux-candidate"));
    assert.equal(mode&0o777,0o700);
  }finally{await rm(extractionParent,{recursive:true,force:true});}
  assert.throws(()=>inspectTarGzip(fixture([
    {name:"apps/remote-control-agent/.build/rca-standard-linux-candidate",data:elf(62)},
  ],{version:tag,agent_runtime:"rust-standard-linux-v1",
    candidate_profile:"standard-linux-rust-runtime-v1"}),{tag,target}),/runtime profile/);
  assert.throws(()=>inspectTarGzip(fixture([
    {name:"apps/remote-control-agent/.build/rca-standard-linux-candidate",data:elf(62)},
  ],{agent_runtime:"node-v2"}),{tag,target}),/runtime profile/);
  assert.throws(()=>inspectTarGzip(fixture([
    {name:"apps/remote-control-agent/scripts/manage-v2.py",data:Buffer.from("inspection-only")},
  ],{agent_runtime:"node-v2"}),{tag,target}),/runtime profile/,
  "Stable Node package must not silently gain the Rust-only Python manager");
  const candidateRelease=mockGithub(Buffer.alloc(2048,0x42),{prerelease:true,releaseTag:candidateTag});
  assert.equal((await resolvePinnedRelease({tag:candidateTag,commit,target,
    send:candidateRelease.send})).tag,candidateTag);
  const falselyStable=mockGithub(Buffer.alloc(2048,0x42),{prerelease:false,releaseTag:candidateTag});
  await assert.rejects(resolvePinnedRelease({tag:candidateTag,commit,target,
    send:falselyStable.send}),/published and immutable/);
  const mismatchedArch = process.arch === "arm64" ? "linux-x64-glibc" : "linux-arm64-glibc";
  assert.throws(()=>ensureNativeTarget({target:mismatchedArch,nodeBin:"/missing",native:"/missing"}),/architecture/);
});

test("#73 verifies immutable setting, tag commit, exact asset id and official digest",async()=>{
  const payload=Buffer.alloc(2048,0x52);
  const {send,seen}=mockGithub(payload);
  const info=await resolvePinnedRelease({tag,commit,target,send});
  assert.equal(info.assetId,903);
  assert.equal(info.bytes,payload.length);
  assert.equal(info.digest,sha(payload));
  const bytes=await downloadPinnedAsset(info,send);
  assert.deepEqual(bytes, payload);
  assert.equal(seen.some(x=>x.url.endsWith("/latest")),false);
  assert.ok(seen.every(x=>x.init.redirect==="manual"));
  assert.equal(seen.some(x=>x.url.endsWith("/immutable-releases")),false,
    "A public installer must not need GitHub admin credentials.");
  for(const options of [
    {immutable:false},{actualCommit:"2".repeat(40)},
    {digest:null},{digest:"sha256:"+"a".repeat(63)},
    {assetSize:MAX_NEGATIVE},
  ]) {
    await assert.rejects(resolvePinnedRelease({tag,commit,target,send:mockGithub(payload,options).send}));
  }
});
const MAX_NEGATIVE=250_000_000;

test("#73 refuses tampered bytes and redirects outside official GitHub HTTPS",async()=>{
  const payload=Buffer.alloc(2048,0x52);
  const tamper=mockGithub(payload,{digest:"sha256:"+"f".repeat(64)});
  const pinned=await resolvePinnedRelease({tag,commit,target,send:tamper.send});
  await assert.rejects(downloadPinnedAsset(pinned,tamper.send),/digest mismatch/);
  for(const url of ["http://release-assets.githubusercontent.com/artifact",
    "https://not-github.example/fake","file:///tmp/payload",
    "https://github.com.evil.invalid/file"]) {
    const m=mockGithub(payload,{routeRedirect:url});
    const info=await resolvePinnedRelease({tag,commit,target,send:m.send});
    await assert.rejects(downloadPinnedAsset(info,m.send),/outside GitHub HTTPS/);
  }
  const good=mockGithub(payload,{routeRedirect:"https://release-assets.githubusercontent.com/asset"});
  const info=await resolvePinnedRelease({tag,commit,target,send:good.send});
  assert.deepEqual(await downloadPinnedAsset(info,good.send),payload);
});

test("#73 rejects malicious archive entries, wrong CPU, version, duplicates and corruption before writing",()=>{
  const badEntries=[
    {name:"../../.ssh/id_rsa",data:Buffer.from("pwn")},
    {name:"/tmp/exploit",data:Buffer.from("bad")},
    {name:"apps/remote-control-agent/src/evil.js",type:"2"},
    {name:"apps/remote-control-agent/src/v2-main.js",data:Buffer.from("duplicate")},
    {name:"apps/remote-control-agent/tests/private.js",data:Buffer.from("oops")},
    {name:"apps/remote-control-agent/src/back\\slash.js",data:Buffer.from("oops")},
  ];
  assert.equal(inspectTarGzip(fixture(),{tag,target}).size,6);
  for (const bad of badEntries) {
    assert.throws(()=>inspectTarGzip(fixture([bad]),{tag,target}));
  }
  assert.throws(()=>inspectTarGzip(fixture(),{tag:"v0.2.0",target}));
  assert.throws(()=>inspectTarGzip(fixture(),{tag,target:"linux-arm64-glibc"}));
  assert.throws(()=>inspectTarGzip(Buffer.from("invalid gzip"),{tag,target}));
  assert.throws(()=>inspectTarGzip(fixture().subarray(0,25),{tag,target}));
});

test("#73 verified local staging is owner-only, leaves unrelated active version untouched",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"rc-release-safe-"));
  const dst=path.join(dir,"program");
  const archive=fixture();
  const meta={tag,target,digest:sha(archive)};
  try {
    await assert.rejects(extractVerifiedAsset({...meta,digest:"0".repeat(64)},archive,dst),/digest/);
    assert.deepEqual(await readdir(dir),[]);
    const result=await extractVerifiedAsset(meta,archive,dst);
    assert.equal(result.files,6);
    assert.equal((await readFile(path.join(dst,"bundle.json"),"utf8")).includes(tag),true);
    await assert.rejects(extractVerifiedAsset(meta,archive,dst));
    assert.equal((await readFile(path.join(dst,"bundle.json"),"utf8")).includes(tag),true);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("#73 builder selects maximum actual glibc version across ELF requirements",()=>{
  const probe = (_binary,args,opts) => ({status:0,stdout:
    "Version needs section: Name: GLIBC_2.28; Name: GLIBC_2.34; Name: GLIBC_2.2.5",
  });
  assert.equal(requiredGlibcVersion("/fake/supervisor",probe),"2.34");
  assert.throws(()=>requiredGlibcVersion("/fake/musl",()=>({status:0,stdout:""})),
    /no verifiable glibc/);
  assert.throws(()=>requiredGlibcVersion("/fake/readelf-fail",()=>({status:1,stdout:""})),
    /Cannot determine/);
});

test("GUI runtime manifest is rejected by the release verifier", () => {
  assert.throws(() => inspectTarGzip(fixture([], {browser_runtime: {name: "playwright-core"}}), {tag,target}),
    /Retired GUI runtime/);
});

test("#914 native-only Rust archive excludes bundled Node and every JS runtime file",async()=>{
  const candidateTag="v0.1.57-rust-candidate.1";
  const nativeManifest={name:"remote-control-agent",artifact_schema:1,
    version:candidateTag,target,agent_runtime:"rust-standard-linux-v1",
    artifact_profile:"rust-native-only-v1",candidate_profile:"standard-linux-rust-runtime-v1",
    glibc_min:"2.34",device_protocol:2,receipt_schema:1,
    upgrade_profile:"paired-full-v1",modules:[]};
  const nativeFiles=[
    {name:"bundle.json",data:Buffer.from(JSON.stringify(nativeManifest))},
    {name:"apps/remote-control-agent/.build/session-supervisor",data:elf(62)},
    {name:"apps/remote-control-agent/.build/rca-standard-linux-candidate",data:elf(62)},
    {name:"apps/remote-control-agent/scripts/bootstrap-v2.py",data:Buffer.from("reviewed bootstrap")},
    {name:"apps/remote-control-agent/scripts/manage-v2.py",data:Buffer.from("reviewed manager")},
    {name:"apps/remote-control-agent/scripts/rca.sh",data:Buffer.from("#!/bin/sh\n")},
  ];
  const bytes=tar(nativeFiles);
  const entries=inspectTarGzip(bytes,{tag:candidateTag,target});
  assert.equal(entries.size,nativeFiles.length);
  assert.equal([...entries.keys()].some(name=>name.startsWith("bin/") ||
    name.includes("/src/") || name.endsWith(".mjs")),false);
  const root=await mkdtemp(path.join(os.tmpdir(),"rc-rust-native-only-"));
  try{
    const dest=path.join(root,"version");
    await extractVerifiedAsset({tag:candidateTag,target,digest:sha(bytes)},bytes,dest);
    const executable=[
      "apps/remote-control-agent/.build/session-supervisor",
      "apps/remote-control-agent/.build/rca-standard-linux-candidate",
      "apps/remote-control-agent/scripts/rca.sh",
      "apps/remote-control-agent/scripts/manage-v2.py"
    ];
    for(const name of executable)
      assert.equal((await stat(path.join(dest,name))).mode&0o777,0o700,name);
    await assert.rejects(access(path.join(dest,"bin/node")),{code:"ENOENT"});
    await assert.rejects(access(path.join(dest,"apps/remote-control-agent/src/v2-main.js")),{code:"ENOENT"});
  } finally {await rm(root,{recursive:true,force:true});}
  const invalids=[
    {files:nativeFiles.filter(f=>!f.name.endsWith("manage-v2.py")),why:"missing manager"},
    {files:nativeFiles.filter(f=>!f.name.endsWith("rca.sh")),why:"missing launcher"},
    {files:[...nativeFiles,{name:"bin/node",data:elf(62)}],why:"Node payload"},
    {files:[...nativeFiles,{name:"apps/remote-control-agent/src/v2-main.js",
      data:Buffer.from("export {}")}],why:"JS payload"},
    {files:nativeFiles.map(f=>f.name.includes("rca-standard-linux-candidate") ?
      {...f,data:elf(183)}:f),why:"wrong ELF architecture"},
    {files:nativeFiles.map(f=>f.name==="bundle.json" ?
      {...f,data:Buffer.from(JSON.stringify({...nativeManifest,node:"v24.21.0"}))}:f),
      why:"hidden Node dependency"},
  ];
  for(const item of invalids)
    assert.throws(()=>inspectTarGzip(tar(item.files),{tag:candidateTag,target}),undefined,item.why);
  const sessionName="apps/remote-control-agent/.build/rca-session-linux-candidate";
  const declared=nativeFiles.map(f=>f.name==="bundle.json" ?
    {...f,data:Buffer.from(JSON.stringify({...nativeManifest,session_runtime:"rust-session-v1"}))}:f);
  const sessionBytes=tar([...declared,{name:sessionName,data:elf(62)}]);
  assert.ok(inspectTarGzip(sessionBytes,{tag:candidateTag,target}).has(sessionName));
  assert.throws(()=>inspectTarGzip(tar(declared),{tag:candidateTag,target}));
  assert.throws(()=>inspectTarGzip(tar([...nativeFiles,{name:sessionName,data:elf(62)}]),{tag:candidateTag,target}));
  assert.throws(()=>inspectTarGzip(tar([...declared,{name:sessionName,data:elf(183)}]),{tag:candidateTag,target}));
  const sessionRoot=await mkdtemp(path.join(os.tmpdir(),"rca-native-session-"));
  try {
    const dest=path.join(sessionRoot,"bundle");
    await extractVerifiedAsset({tag:candidateTag,target,digest:sha(sessionBytes)},sessionBytes,dest);
    assert.equal((await stat(path.join(dest,sessionName))).mode&0o777,0o700);
  } finally {await rm(sessionRoot,{recursive:true,force:true});}
  assert.throws(()=>inspectTarGzip(bytes,{tag:"v0.1.57",target}),/version|profile/i);
});

test("#914 native-only packaging is explicit and cannot target Node or Darwin",()=>{
  const args=["--version","v0.1.57-rust-candidate.1","--target",target,
    "--node-bin","/opt/node","--native","/opt/supervisor","--out","/tmp/release",
    "--node-sha256","a".repeat(64),"--native-sha256","b".repeat(64),
    "--rust-agent-bin","/opt/rca-native","--rust-agent-sha256","c".repeat(64),
    "--artifact-profile","rust-native-only-v1"];
  const selected=parseArgs(args);
  assert.equal(selected.artifactProfile,"rust-native-only-v1");
  const sessionArgs=["--rust-session-bin","/opt/rca-session","--rust-session-sha256","d".repeat(64)];
  assert.equal(parseArgs([...args,...sessionArgs]).rustSessionBin,"/opt/rca-session");
  assert.throws(()=>parseArgs([...args,...sessionArgs.slice(0,2)]));
  assert.throws(()=>parseArgs([...args.map(x=>x===target?"linux-arm64-glibc":x),...sessionArgs]));
  assert.throws(()=>parseArgs([...args.slice(0,-2),...sessionArgs]));

  assert.throws(()=>parseArgs(args.map(x=>x===target?"darwin-arm64":x)));
  assert.throws(()=>parseArgs(args.slice(0,-2).concat("--artifact-profile","anything")));
  assert.throws(()=>parseArgs(args.filter((_,i)=>i<args.length-4 ||
    i>=args.length-2)),"missing Rust signature must not pass");
});
