/**
 * GitHub Release supply-chain boundary (#73).
 * Pinned version + tag commit + official immutable Release + asset ID/digest.
 * Download with manual bounded HTTPS redirects; SHA256 and tar entries must
 * pass BEFORE any executable is installed or started. No npm/tar dependency.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const REPO="lirtual/remote-control-agent";
const API="https://api.github.com/repos/"+REPO;
const MAX_ARCHIVE=180*1024*1024;
const MAX_TAR=240*1024*1024;
const ALLOWED_TARGETS=new Set(["linux-x64-glibc","linux-arm64-glibc"]);
const sha=/^[a-f0-9]{40}$/;
const hex=/^[a-f0-9]{64}$/;
const vtag=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const apiHeaders={"accept":"application/vnd.github+json","x-github-api-version":"2026-03-10","user-agent":"mcp-workers-remote-control-agent-installer"};
export const releaseAssetName=(tag,target)=>"remote-control-agent-"+tag+"-"+target+".tar.gz";

function validateRequest({tag,commit,target}) {
  if (!vtag.test(tag) || !sha.test(commit) || !ALLOWED_TARGETS.has(target)) {
    throw new Error("Pinned release tag, commit SHA and supported target are mandatory.");
  }
}

function trustedAssetHost(url) {
  return url.protocol==="https:" && !url.username && !url.password && !url.hash &&
    ["api.github.com","github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"].includes(url.hostname) &&
    (!url.port || url.port==="443");
}
async function checkedFetch(url, accept, send, redirectLimit=3) {
  let current=new URL(url);
  for(let i=0;i<=redirectLimit;i++) {
    if (!trustedAssetHost(current)) throw new Error("Untrusted HTTPS release redirect.");
    const response=await send(current.toString(),{method:"GET",redirect:"manual",
      headers:{...apiHeaders,accept},signal:AbortSignal.timeout(20000)});
    if ([301,302,303,307,308].includes(response.status)) {
      if (i===redirectLimit) throw new Error("Too many Release redirects.");
      const location=response.headers.get("location");
      if (!location) throw new Error("Missing Release redirect location.");
      const next=new URL(location,current);
      if (!trustedAssetHost(next)) throw new Error("Release redirected outside GitHub HTTPS.");
      current=next;
      continue;
    }
    if (response.status!==200) throw new Error("Official GitHub Release response unavailable.");
    return response;
  }
  throw new Error("Unexpected Release redirect.");
}
async function readBounded(response,limit) {
  const declared=response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared)|| Number(declared)>limit))
    throw new Error("Release response exceeds size limit.");
  if (!response.body) throw new Error("Empty response.");
  const chunks=[];
  let size=0;
  for await (const chunk of response.body) {
    size+=chunk.length;
    if (size>limit) {
      await response.body.cancel().catch(()=>{});
      throw new Error("Release response exceeds size limit.");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks,size);
}
async function fetchJson(url,send) {
  // Metadata must stay on the official API origin, no cross-host redirects.
  const response=await send(url,{method:"GET",redirect:"manual",headers:apiHeaders,
    signal:AbortSignal.timeout(15000)});
  if (response.status!==200) throw new Error("Pinned GitHub metadata unavailable or redirected.");
  return JSON.parse((await readBounded(response,1024*1024)).toString("utf8"));
}

/** No mutable 'latest'; verify the release's immutable property AND exact tag target. */
export async function resolvePinnedRelease({tag,commit,target,send=fetch}) {
  validateRequest({tag,commit,target});
  // Repository immutable-release settings require GitHub authentication.
  // A clean public Agent must not need a maintainer token.
  // The published Release exposes its own public immutable=true property.
  const release=await fetchJson(API+"/releases/tags/"+encodeURIComponent(tag),send);
  if (release.immutable!==true || release.draft!==false || release.tag_name!==tag ||
      !Number.isSafeInteger(release.id) || !Array.isArray(release.assets)) {
    throw new Error("Pinned Release is not published and immutable.");
  }
  const ref=await fetchJson(API+"/git/ref/tags/"+encodeURIComponent(tag),send);
  if (ref.ref!=="refs/tags/"+tag || !ref.object || !sha.test(ref.object.sha)) {
    throw new Error("Pinned Git tag cannot be verified.");
  }
  let pointer=ref.object;
  if(pointer.type==="tag") {
    const annotated=await fetchJson(API+"/git/tags/"+pointer.sha,send);
    pointer=annotated.object;
  }
  if (pointer?.type!=="commit" || pointer.sha!==commit) {
    throw new Error("Release tag does not resolve to the pinned commit.");
  }
  const name=releaseAssetName(tag,target);
  const matches=release.assets.filter(asset=>asset.name===name);
  if(matches.length!==1) throw new Error("Missing or duplicate qualified Release asset.");
  const asset=matches[0];
  if(!Number.isSafeInteger(asset.id) || asset.id<1 || asset.state!=="uploaded" ||
      !Number.isSafeInteger(asset.size) || asset.size<1024 || asset.size>MAX_ARCHIVE ||
      typeof asset.digest!=="string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      asset.url!==API+"/releases/assets/"+asset.id) {
    throw new Error("Release asset ID, size or official SHA-256 digest is invalid.");
  }
  return Object.freeze({tag,commit,target,releaseId:release.id,assetId:asset.id,
    name,bytes:asset.size,digest:asset.digest.slice(7)});
}
/** Resolve immutable stable Latest on the owner device's bundled Node runtime.
 * Validate five assets before download; no Cloudflare API egress dependency. */
const CURRENT_LATEST_API="https://api.github.com/repos/lirtual/mcp-workers/releases/latest";
const CURRENT_RELEASE_TAG=/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CURRENT_ASSETS=[
  ["linux-x64-glibc","tar.gz"],["linux-arm64-glibc","tar.gz"],
  ["windows-x64","zip"],["darwin-arm64","tar.gz"],["darwin-x64","tar.gz"],
];
const PLATFORM_ASSET=/^remote-control-agent-v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?-(?:linux-x64-glibc|linux-arm64-glibc|windows-x64|darwin-arm64|darwin-x64)\.(?:tar\.gz|zip)$/;

export async function resolveLatestAgentRelease({send=fetch}={}){
  const release=await fetchJson(CURRENT_LATEST_API,send);
  if(!release||!CURRENT_RELEASE_TAG.test(release.tag_name)||
      release.immutable!==true||release.draft!==false||
      release.prerelease!==false||
      release.html_url!=="https://github.com/lirtual/mcp-workers/releases/tag/"+release.tag_name||
      !Array.isArray(release.assets)){
    throw Error("No valid immutable stable latest Agent Release.");
  }
  const tag=release.tag_name;
  const expected=new Map(CURRENT_ASSETS.map(([target,ext])=>[
    "remote-control-agent-"+tag+"-"+target+"."+ext,target]));
  const selected=new Map();
  for(const asset of release.assets){
    if(!asset||typeof asset.name!=="string")
      throw Error("Malformed latest Release asset.");
    const target=expected.get(asset.name);
    if(!target){
      if(PLATFORM_ASSET.test(asset.name))
        throw Error("Release mixes incompatible platform assets.");
      continue;
    }
    if(selected.has(target)||asset.state!=="uploaded"||
        !Number.isSafeInteger(asset.size)||asset.size<1024||asset.size>180_000_000||
        typeof asset.digest!=="string"||!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||
        asset.browser_download_url!==
          "https://github.com/lirtual/mcp-workers/releases/download/"+tag+"/"+asset.name)
      throw Error("Invalid or duplicate immutable latest Release asset.");
    selected.set(target,Object.freeze({
      url:asset.browser_download_url,
      sha256:asset.digest.slice(7),
      size:asset.size,
    }));
  }
  if(selected.size!==CURRENT_ASSETS.length)
    throw Error("Latest Agent Release is missing a platform.");
  return Object.freeze({
    tag,x64:selected.get("linux-x64-glibc"),arm64:selected.get("linux-arm64-glibc"),
  });
}

function selectedLinuxAssetUrl(url) {
  let parsed;
  try { parsed=new URL(url); }
  catch { throw new Error("Untrusted Release asset URL."); }
  if (parsed.protocol!=="https:" || parsed.username || parsed.password || parsed.search ||
      parsed.hash || parsed.port || parsed.hostname!=="github.com" ||
      !/^\/lirtual\/mcp-workers\/releases\/download\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/remote-control-agent-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-linux-(?:x64|arm64)-glibc\.tar\.gz$/.test(parsed.pathname)) {
    throw new Error("Untrusted Release asset URL.");
  }
  return parsed;
}
function allowedAssetRedirect(next, original) {
  if (next.protocol!=="https:" || next.username || next.password || next.hash ||
      (next.port && next.port!=="443")) return false;
  if (next.toString()===original.toString()) return true;
  return next.hostname==="release-assets.githubusercontent.com" ||
    next.hostname==="objects.githubusercontent.com";
}
/**
 * Download one asset already chosen from the current repository's latest
 * stable Release. One redirect chain, no retry, and no old-repository URL.
 */
export async function downloadSelectedReleaseAsset(asset,send=fetch) {
  if (!asset || !hex.test(asset.digest) || !Number.isSafeInteger(asset.bytes) ||
      asset.bytes<1024 || asset.bytes>MAX_ARCHIVE) {
    throw new Error("Selected Release asset is incomplete.");
  }
  const original=selectedLinuxAssetUrl(asset.url);
  let current=original;
  for (let hop=0;;hop++) {
    const response=await send(current.toString(),{method:"GET",redirect:"manual",
      headers:{...apiHeaders,accept:"application/octet-stream"},
      signal:AbortSignal.timeout(20000)});
    if ([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel?.().catch(()=>{});
      if (hop===3) throw new Error("Too many Release redirects.");
      const location=response.headers.get("location");
      if (!location) throw new Error("Missing Release redirect location.");
      const next=new URL(location,current);
      if (!allowedAssetRedirect(next,original)) throw new Error("Release redirected outside GitHub HTTPS.");
      current=next;
      continue;
    }
    if (response.status===403 || response.status===429) {
      await response.body?.cancel?.().catch(()=>{});
      throw new Error(response.status===403 ?
        "GitHub refused the Agent download." :
        "GitHub rate limit blocked the Agent download.");
    }
    if (response.status!==200) throw new Error("Official GitHub Release response unavailable.");
    const bytes=await readBounded(response,asset.bytes);
    if (bytes.length!==asset.bytes) throw new Error("Incomplete or unexpected asset length.");
    const actual=createHash("sha256").update(bytes).digest();
    if (!timingSafeEqual(actual,Buffer.from(asset.digest,"hex"))) {
      throw new Error("GitHub official SHA-256 digest mismatch.");
    }
    return bytes;
  }
}
export async function downloadPinnedAsset(pinned,send=fetch) {
  const assetUrl=API+"/releases/assets/"+pinned.assetId;
  const response=await checkedFetch(assetUrl,"application/octet-stream",send);
  if (response.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("Release API returned metadata instead of the asset.");
  const bytes=await readBounded(response,MAX_ARCHIVE);
  if(bytes.length!==pinned.bytes) throw new Error("Incomplete or unexpected asset length.");
  const actual=createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(actual,Buffer.from(pinned.digest,"hex"))) {
    throw new Error("GitHub official SHA-256 digest mismatch.");
  }
  return bytes;
}
function octal(bytes) {
  const s=Buffer.from(bytes).toString("ascii").replace(/\0.*$/,"").trim();
  if(!/^[0-7]+$/.test(s)) throw new Error("Invalid tar numeric field.");
  const n=parseInt(s,8);
  if(!Number.isSafeInteger(n)) throw new Error("Invalid tar size.");
  return n;
}
function ascii(bytes) {
  if(bytes.some(x=>x>127)) throw new Error("Invalid tar pathname.");
  return Buffer.from(bytes).toString("ascii").replace(/\0.*$/,"");
}
function safePath(name,directory) {
  const n=directory && name.endsWith("/") ? name.slice(0,-1) : name;
  if(n.length<1 || n.length>160 || n.startsWith("/") || n.includes("\\") ||
    n.split("/").some(part=>part==="" || part==="." || part==="..") ||
    !/^[A-Za-z0-9._/-]+$/.test(n)) throw new Error("Unsafe tar entry path.");
  if (/^apps\/remote-control-agent\/src\/(?:browser-|desktop-)/.test(n) ||
      n === "apps/remote-control-agent/scripts/windows-capture.ps1") {
    throw Error("Retired GUI module is forbidden.");
  }
  if(!directory && !(
    n==="bin/node" || n==="bundle.json" ||
    n==="apps/remote-control-agent/package.json" ||
    n==="apps/remote-control-agent/scripts/install-v2.mjs" ||
    ["bootstrap-node.mjs","manage-v2.mjs","lifecycle-v2.mjs",
     "upgrade-v2.mjs","upgrade-existing-service.mjs",
     "bootstrap-v2.py","linux-upgrade-detached.mjs","linux-upgrade-watchdog.mjs",
     "verify-v2-release.mjs","rca.sh"].some(name=>
       n==="apps/remote-control-agent/scripts/"+name) ||
    n==="apps/remote-control-agent/.build/session-supervisor" ||
    /^apps\/remote-control-agent\/src\/[a-z0-9-]+\.js$/.test(n))) {
    throw new Error("Unreviewed archive file.");
  }
  if(directory && !["bin","apps","apps/remote-control-agent",
      "apps/remote-control-agent/src","apps/remote-control-agent/scripts",
      "apps/remote-control-agent/.build"].includes(n)) {
    throw new Error("Unreviewed archive directory.");
  }
  return n;
}

/** Entire table validated before any archive file is written. Reject links/PAX/devices. */
export function inspectTarGzip(gzip,{tag,target}) {
  if (!Buffer.isBuffer(gzip) || gzip.length>MAX_ARCHIVE) throw new Error("Oversized release archive.");
  let tar;
  try { tar=gunzipSync(gzip,{maxOutputLength:MAX_TAR}); }
  catch { throw new Error("Invalid or oversized gzip stream."); }
  const entries=new Map();
  let cursor=0,end=false;
  while(cursor+512<=tar.length) {
    const header=tar.subarray(cursor,cursor+512);
    if(header.every(b=>b===0)) {end=true;break;}
    if(ascii(header.subarray(257,263))!=="ustar") throw new Error("Expected ustar archive.");
    const sum=octal(header.subarray(148,156));
    let check=0;
    for(let i=0;i<512;i++) check+=i>=148&&i<156 ? 32:header[i];
    if(sum!==check) throw new Error("Tar checksum failure.");
    const type=header[156];
    const directory=type===53;
    if(type!==0 && type!==48 && !directory) throw new Error("Symlink, hardlink or special tar entry refused.");
    if(header.subarray(157,257).some(x=>x!==0)) throw new Error("Tar link target refused.");
    const prefix=ascii(header.subarray(345,500));
    const name=(prefix ? prefix+"/" : "")+ascii(header.subarray(0,100));
    const safe=safePath(name,directory);
    if(entries.has(safe)) throw new Error("Duplicate tar entry.");
    const size=octal(header.subarray(124,136));
    if(directory && size!==0) throw new Error("Directory contains payload.");
    if(size>MAX_TAR || cursor+512+size>tar.length) throw new Error("Truncated tar entry.");
    entries.set(safe,{directory, data:Buffer.from(tar.subarray(cursor+512,cursor+512+size))});
    cursor+=512+Math.ceil(size/512)*512;
    if(entries.size>80) throw new Error("Too many archive entries.");
  }
  if(!end || tar.subarray(cursor).some(b=>b!==0)) throw new Error("Invalid tar trailer.");
  for(const required of ["bin/node","bundle.json","apps/remote-control-agent/package.json",
    "apps/remote-control-agent/src/v2-main.js",
    "apps/remote-control-agent/scripts/install-v2.mjs",
    "apps/remote-control-agent/.build/session-supervisor"]) {
    if(!entries.has(required)||entries.get(required).directory) throw new Error("Incomplete release artifact.");
  }
  let manifest;
  try { manifest=JSON.parse(entries.get("bundle.json").data.toString("utf8")); }
  catch { throw new Error("Invalid Release manifest."); }
  if(manifest.version!==tag || manifest.target!==target || !/^v24\.\d+\.\d+$/.test(manifest.node) ||
      manifest.name!=="remote-control-agent" || manifest.artifact_schema!==1 ||
      !Array.isArray(manifest.modules)) throw new Error("Unexpected Release version or architecture.");
  // Historical local-only Releases remain readable. An archive advertising
  // owner-one-shot must contain the actual Linux stage and recovery runtime.
  if(manifest.upgrade_protocol!==undefined &&
     (manifest.upgrade_protocol!=="owner-one-shot-v1" ||
      ["bootstrap-v2.py","linux-upgrade-detached.mjs","linux-upgrade-watchdog.mjs"]
        .some(name=>!entries.has("apps/remote-control-agent/scripts/"+name) ||
                    entries.get("apps/remote-control-agent/scripts/"+name).directory)))
    throw new Error("Incomplete reviewed Linux one-shot Release.");
  // No GUI-only modules or optional browser runtime can enter a new RCA release.
  if (manifest.browser_runtime !== undefined ||
      [...entries.keys()].some(name => name.includes("playwright-core") || name.includes("/candidates/"))) {
    throw Error("Retired GUI runtime is forbidden in RCA releases.");
  }
  const expected=target==="linux-x64-glibc" ? 62 : 183;
  for(const name of ["bin/node","apps/remote-control-agent/.build/session-supervisor"]) {
    const b=entries.get(name).data;
    if(b.length<64 || b.toString("hex",0,4)!=="7f454c46" ||
      b[4]!==2 || b[5]!==1 || b.readUInt16LE(18)!==expected)
      throw new Error("Release binary architecture mismatch.");
  }
  return entries;
}

export async function extractVerifiedAsset(pinned,bytes,root) {
  if(!pinned || !hex.test(pinned.digest) || !path.isAbsolute(root)) throw new Error("Invalid installation destination.");
  if(createHash("sha256").update(bytes).digest("hex")!==pinned.digest)
    throw new Error("Archive digest mismatch before extraction.");
  const entries=inspectTarGzip(bytes,{tag:pinned.tag,target:pinned.target});
  const parent=path.dirname(root);
  const meta=await lstat(parent);
  if(!meta.isDirectory() || meta.isSymbolicLink() || meta.uid!==process.getuid() ||
      (meta.mode&0o077)!==0) throw new Error("Install parent must be an owner-only directory.");
  // The target must not already exist; prior installs may never be overwritten.
  try { await lstat(root); throw new Error("An existing program directory cannot be replaced."); }
  catch(error) { if(error.code!=="ENOENT") throw error; }
  const stage=await mkdtemp(path.join(parent,".rc-v2-verify-"));
  try {
    await chmod(stage,0o700);
    for(const [name,entry] of entries) {
      const dest=path.join(stage,name);
      if(entry.directory) {await mkdir(dest,{recursive:true,mode:0o700}); continue;}
      await mkdir(path.dirname(dest),{recursive:true,mode:0o700});
      const fd=await open(dest,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await fd.writeFile(entry.data);await fd.sync();}finally{await fd.close();}
      if(name==="bin/node"||name==="apps/remote-control-agent/.build/session-supervisor") await chmod(dest,0o700);
    }
    await rename(stage,root); // Never overwrite an installed program.
  } catch(error) {
    await rm(stage,{recursive:true,force:true});
    throw error;
  }
  return {root,files:entries.size};
}
export async function fetchAndStagePinnedRelease({tag,commit,target,destination,send=fetch}) {
  const pinned=await resolvePinnedRelease({tag,commit,target,send});
  const bytes=await downloadPinnedAsset(pinned,send);
  const result=await extractVerifiedAsset(pinned,bytes,destination);
  return { ...result,pinned };
}
