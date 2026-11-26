/** Independent in-memory inspection of the native Linux and Darwin release archives.
 * Used by CI before release; installation/download are owned by bootstrap-v2.py.
 */
import { gunzipSync } from "node:zlib";

const MAX_ARCHIVE=180*1024*1024;
const MAX_TAR=240*1024*1024;
const APP="apps/remote-control-agent";
const NATIVE_FILES=new Set(["bundle.json",APP+"/.build/session-supervisor",
  APP+"/.build/rca-standard-linux-candidate",APP+"/scripts/bootstrap-v2.py",
  APP+"/scripts/manage-v2.py",APP+"/scripts/rca.sh"]);
const SESSION_ENTRY=APP+"/.build/rca-session-linux-candidate";
const DARWIN_FILES=new Set(["bundle.json",APP+"/.build/darwin-session-supervisor",
  APP+"/.build/rca-standard-darwin-candidate"]);
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
function safePath(name,directory,darwin) {
  const n=directory && name.endsWith("/") ? name.slice(0,-1) : name;
  if(n.length<1 || n.length>160 || n.startsWith("/") || n.includes("\\") ||
    n.split("/").some(part=>part==="" || part==="." || part==="..") ||
    !/^[A-Za-z0-9._/-]+$/.test(n)) throw new Error("Unsafe tar entry path.");
  if(!directory && !(darwin ? DARWIN_FILES.has(n) : NATIVE_FILES.has(n) || n===SESSION_ENTRY))
    throw new Error("Native-only archive contains an unreviewed runtime file.");
  if(directory && !(darwin ? ["apps",APP,APP+"/.build"] : ["apps",APP,APP+"/scripts",APP+"/.build"]).includes(n))
    throw new Error("Unreviewed archive directory.");
  return n;
}

/** Entire table validated before any archive file is written. Reject links/PAX/devices. */
export function inspectTarGzip(gzip,{tag,target}) {
  if (!Buffer.isBuffer(gzip) || gzip.length>MAX_ARCHIVE) throw new Error("Oversized release archive.");
  let tar;
  try { tar=gunzipSync(gzip,{maxOutputLength:MAX_TAR}); }
  catch { throw new Error("Invalid or oversized gzip stream."); }
  const darwin=/^darwin-(?:arm64|x64)$/.test(target);
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
    const safe=safePath(name,directory,darwin);
    if(entries.has(safe)) throw new Error("Duplicate tar entry.");
    const size=octal(header.subarray(124,136));
    if(directory && size!==0) throw new Error("Directory contains payload.");
    if(darwin) {
      // Match the native package verifier and deterministic Darwin builder.
      if(octal(header.subarray(100,108))!==(safe==="bundle.json"?0o600:0o700))
        throw Error("Unexpected native Darwin archive permission.");
      if(safe==="bundle.json" && (size===0 || size>65536))
        throw Error("Unexpected native Darwin manifest size.");
      if(!directory && safe!=="bundle.json" && size>180_000_000)
        throw Error("Unexpected native Darwin executable size.");
    }
    if(size>MAX_TAR || cursor+512+size>tar.length) throw new Error("Truncated tar entry.");
    entries.set(safe,{directory, data:Buffer.from(tar.subarray(cursor+512,cursor+512+size))});
    cursor+=512+Math.ceil(size/512)*512;
    if(entries.size>80) throw new Error("Too many archive entries.");
  }
  if(!end || tar.subarray(cursor).some(b=>b!==0)) throw new Error("Invalid tar trailer.");
  if(!entries.has("bundle.json")||entries.get("bundle.json").directory)
    throw new Error("Missing Agent manifest.");
  let manifest;
  try { manifest=JSON.parse(entries.get("bundle.json").data.toString("utf8")); }
  catch { throw new Error("Invalid Release manifest."); }
  if(darwin) {
    if(!manifest || manifest.name!=="remote-control-agent" || manifest.version!==tag ||
        manifest.target!==target || !/^v0\.[1-9][0-9]*\.[0-9]+(?:-rust-candidate\.[1-9][0-9]*)?$/.test(tag) ||
        manifest.artifact_schema!==1 || manifest.device_protocol!==2 || manifest.receipt_schema!==1 ||
        manifest.artifact_profile!=="rust-native-only-v1" ||
        manifest.agent_runtime!=="rust-standard-darwin-v1" ||
        manifest.runtime_profile!=="standard-darwin-rust-runtime-v1" ||
        manifest.candidate_profile!=="darwin-permanent-local-v1" ||
        manifest.native_supervisor!=="darwin-owned-group-v1" ||
        !/^[a-f0-9]{40}$/.test(manifest.source_commit||"") ||
        manifest.node!==undefined || manifest.browser_runtime!==undefined ||
        manifest.session_runtime!==undefined || manifest.upgrade_protocol!==undefined ||
        manifest.upgrade_profile!==undefined ||
        !Array.isArray(manifest.modules) || manifest.modules.length!==0)
      throw Error("Unexpected native Darwin Release identity.");
    if([...DARWIN_FILES].some(file=>!entries.has(file)||entries.get(file).directory))
      throw Error("Incomplete native Darwin release artifact.");
    const cpu=target==="darwin-arm64" ? 0x0100000c : 0x01000007;
    for(const file of DARWIN_FILES) {
      if(file==="bundle.json")continue;
      const b=entries.get(file).data;
      if(b.length<32||b.readUInt32LE(0)!==0xfeedfacf||b.readUInt32LE(4)!==cpu||b.readUInt32LE(12)!==2)
        throw Error("Release binary architecture mismatch.");
    }
    return entries;
  }
  if(!manifest || manifest.version!==tag || manifest.target!==target ||
      !/^linux-(?:x64|arm64)-glibc$/.test(target) ||
      !(/^v0\.[1-9][0-9]*\.[0-9]+$/.test(tag) ||
        /-rust-candidate(?:\.|$)/.test(tag)) ||
      manifest.name!=="remote-control-agent" || manifest.artifact_schema!==1 ||
      manifest.artifact_profile!=="rust-native-only-v1" ||
      manifest.agent_runtime!=="rust-standard-linux-v1" ||
      manifest.candidate_profile!=="standard-linux-rust-runtime-v1" ||
      manifest.node!==undefined || manifest.upgrade_protocol!==undefined ||
      !Array.isArray(manifest.modules) || manifest.modules.length!==0 ||
      !/^\d+\.\d+$/.test(manifest.glibc_min||"")) {
    throw new Error("Unexpected Release version, runtime profile, or architecture.");
  }
  if(manifest.browser_runtime!==undefined)
    throw Error("Retired GUI runtime is forbidden in RCA releases.");
  const required=new Set(NATIVE_FILES);
  if(manifest.session_runtime!==undefined) {
    if(target!=="linux-x64-glibc" || manifest.session_runtime!=="rust-session-v1")
      throw Error("Unreviewed packaged Session runtime.");
    required.add(SESSION_ENTRY);
  }
  if([...required].some(file=>!entries.has(file)||entries.get(file).directory))
    throw new Error("Incomplete release artifact.");
  if([...entries].some(([name,entry])=>!entry.directory&&!required.has(name)))
    throw new Error("Native-only archive contains an unreviewed runtime file.");
  const expected=target==="linux-x64-glibc" ? 62 : 183;
  for(const name of [APP+"/.build/session-supervisor",
      APP+"/.build/rca-standard-linux-candidate",
      ...(manifest.session_runtime ? [SESSION_ENTRY] : [])]) {
    const b=entries.get(name).data;
    if(b.length<64 || b.toString("hex",0,4)!=="7f454c46" ||
      b[4]!==2 || b[5]!==1 || b.readUInt16LE(18)!==expected)
      throw new Error("Release binary architecture mismatch.");
  }
  return entries;
}
