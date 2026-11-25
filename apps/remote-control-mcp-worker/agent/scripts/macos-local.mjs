/** #660 reviewed offline, owner-only macOS LaunchAgent install/upgrade candidate. */
import {createConnection} from "node:net";
import {createHash,randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createInterface} from "node:readline";
import {cp,lstat,mkdir,readdir,readFile,rename,rm,writeFile} from "node:fs/promises";
import {realpathSync} from "node:fs";
import path from "node:path";
import os from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
const LABEL="org.mcp-workers.remote-control-agent";
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{40}$/, VERSION=/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const ROOT=[".local","share","mcp-workers","remote-control"];
export function verifiedEndpoint(raw){
  if(typeof raw!=="string")throw Error("Missing trusted HTTPS endpoint.");
  const u=new URL(raw);
  if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||
    u.pathname!=="/"||u.port||u.origin+"/"!==raw)throw Error("Untrusted Worker endpoint.");
  return raw;
}
async function statMaybe(name){try{return await lstat(name);}catch(e){if(e.code==="ENOENT")return null;throw e;}}
export async function checked(name,{dir=false,mode,optional=false,privateOnly=true}={}){
  const st=await statMaybe(name);
  if(!st){if(optional)return false;throw Error("Missing owned path.");}
  if(st.isSymbolicLink()||st.uid!==process.getuid?.()||
    (dir?!st.isDirectory():!st.isFile())||
    (st.mode&(privateOnly?0o077:0o022))!==0||
    (!dir&&st.nlink!==1)||(mode!==undefined&&(st.mode&0o777)!==mode))
    throw Error("Unsafe owner, type or mode.");
  return true;
}
async function directories(home,parts,create=true){
  let cursor=home;
  for(const [i,part] of parts.entries()){
    cursor=path.join(cursor,part);
    if(create){
      try{await mkdir(cursor,{mode:0o700});}catch(e){if(e.code!=="EEXIST")throw e;}
    }
    await checked(cursor,{dir:true,privateOnly:i>=2,optional:!create});
  }
  return cursor;
}
export function plistText({node,entry,endpoint,generation,agentRuntime="node-v2"}){
  verifiedEndpoint(endpoint);
  if(!ID.test(generation)||!["node-v2","rust-standard-darwin-v1"].includes(agentRuntime))
    throw Error("Invalid generation or macOS runtime.");
  const esc=s=>s.replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
  const args=agentRuntime==="rust-standard-darwin-v1"
    ?[entry,"--service","--endpoint",endpoint,"--generation",generation]
    :[node,entry,"--service","--endpoint",endpoint,"--generation",generation];
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n'+
    '<key>Label</key><string>'+LABEL+'</string>\n'+
    '<key>ProgramArguments</key><array>'+
    args.map(x=>'<string>'+esc(x)+'</string>').join("")+'</array>\n'+
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n';
}
export function parsePlist(xml,programs,endpoint,arch=process.arch){
  const tokens=[...xml.matchAll(new RegExp("<string>([^<>]*)</string>","g"))].map(m=>m[1]
    .replaceAll("&apos;","'").replaceAll("&quot;",'"').replaceAll("&gt;",">")
    .replaceAll("&lt;","<").replaceAll("&amp;","&"));
  const rust=tokens.length===7;
  const generation=rust?tokens[6]:tokens[7];
  if((!rust&&tokens.length!==8)||tokens[0]!==LABEL||
    tokens[rust?2:3]!=="--service"||tokens[rust?3:4]!=="--endpoint"||
    tokens[rust?4:5]!==endpoint||tokens[rust?5:6]!=="--generation"||
    !ID.test(generation)||!xml.includes("<key>RunAtLoad</key><true/>")||
    !xml.includes("<key>KeepAlive</key><true/>"))
    throw Error("Foreign or ambiguous LaunchAgent.");
  const executable=tokens[1],root=rust
    ?path.resolve(executable,"../../../../"):path.dirname(path.dirname(executable));
  const name=path.basename(root),suffix="-darwin-"+arch;
  const runtime=rust?"rust-standard-darwin-v1":"node-v2";
  const validExecutable=rust
    ? executable===path.join(root,"apps/remote-control-agent/.build/rca-standard-darwin-candidate")
    : executable===path.join(root,"bin/node")&&
      tokens[2]===path.join(root,"apps/remote-control-agent/src/macos-permanent.js");
  if(!["x64","arm64"].includes(arch)||path.dirname(root)!==programs||
    !name.endsWith(suffix)||!VERSION.test(name.slice(0,-suffix.length))||!validExecutable)
    throw Error("LaunchAgent points outside owned candidate.");
  const expected=plistText({node:path.join(root,"bin/node"),
    entry:rust?executable:path.join(root,"apps/remote-control-agent/src/macos-permanent.js"),
    endpoint,generation,agentRuntime:runtime});
  if(xml!==expected)throw Error("Unexpected LaunchAgent configuration.");
  return {root,generation,agentRuntime:runtime};
}
// Explicit upgrades must move forward. A recorded source_commit is not download authority.
export function forwardMacVersion(current,next){
  const re=/^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([a-z0-9.-]+))?-darwin-(arm64|x64)$/;
  const a=re.exec(current),b=re.exec(next);
  if(!a||!b||a[5]!==b[5])return false;
  for(let i=1;i<=3;i++){
    const x=BigInt(a[i]),y=BigInt(b[i]);
    if(x!==y)return y>x;
  }
  if(!a[4])return false;
  if(!b[4])return true;
  const old=a[4].split("."),fresh=b[4].split(".");
  for(let i=0;i<Math.max(old.length,fresh.length);i++){
    if(i>=old.length)return true;
    if(i>=fresh.length)return false;
    const n=/^[0-9]+$/;
    const x=old[i],y=fresh[i];
    if(x===y)continue;
    if(n.test(x)&&n.test(y))return BigInt(y)>BigInt(x);
    if(n.test(x))return true;
    if(n.test(y))return false;
    return y>x;
  }
  return false;
}
// Match the release publisher's five-platform metadata contract. Observation
// never downloads an archive, executes a script or grants update authority.
export async function checkLatestMacVersion(installed,arch,doFetch=fetch){
  const result={installed_version:installed,latest_version:null,status:"unknown"};
  const stable=/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
  if(!["arm64","x64"].includes(arch)||
     !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:rc|rust-candidate)\.[1-9]\d*)?$/.test(installed??""))return result;
  try{
    const base="https://github.com/lirtual/mcp-workers/releases";
    const response=await doFetch("https://api.github.com/repos/lirtual/mcp-workers/releases/latest",{
      redirect:"error",headers:{Accept:"application/vnd.github+json","User-Agent":"rca-macos-latest"},
      signal:AbortSignal.timeout(30_000)
    });
    if(response.status!==200||!response.body){await response.body?.cancel();return result;}
    const reader=response.body.getReader();
    let size=0;const chunks=[];
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)break;
        size+=value.byteLength;
        if(size>1_048_576)return result;
        chunks.push(value);
      }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const release=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tag=release?.tag_name;
    if(typeof tag!=="string"||!stable.test(tag)||release.immutable!==true||
       release.draft!==false||release.prerelease!==false||
       (release.html_url!==undefined&&release.html_url!==base+"/tag/"+tag)||
       !Array.isArray(release.assets))return result;
    const targets=["linux-x64-glibc","linux-arm64-glibc","windows-x64","darwin-arm64","darwin-x64"];
    const names=new Set(targets.map(t=>"remote-control-agent-"+tag+"-"+t+
      (t==="windows-x64"?".zip":".tar.gz")));
    const platformAsset=/^remote-control-agent-v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?-(?:linux-x64-glibc|linux-arm64-glibc|windows-x64|darwin-arm64|darwin-x64)\.(?:tar\.gz|zip)$/;
    const seen=new Set();
    for(const asset of release.assets){
      if(!asset||typeof asset.name!=="string")return result;
      if(!names.has(asset.name)){
        if(platformAsset.test(asset.name))return result;
        continue;
      }
      if(seen.has(asset.name)||asset.state!=="uploaded"||
        asset.browser_download_url!==base+"/download/"+tag+"/"+asset.name||
        typeof asset.digest!=="string"||!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||
        !Number.isSafeInteger(asset.size)||asset.size<1||asset.size>180_000_000)return result;
      seen.add(asset.name);
    }
    if(seen.size!==targets.length)return result;
    const suffix="-darwin-"+arch;
    return {installed_version:installed,latest_version:tag,status:installed===tag?"up_to_date":
      forwardMacVersion(installed+suffix,tag+suffix)?"update_available":"older_latest"};
  }catch{return result;}
}
const SOURCE_COMMIT=/^[a-f0-9]{40}$/;
/** Old and new source commits may differ after the repository move. Neither commit authorizes a download. */
export function admitsMacOwnerUpgrade({installedVersion,installedSourceCommit,candidateVersion,candidateSourceCommit}){
  if(!SOURCE_COMMIT.test(installedSourceCommit??"")||!SOURCE_COMMIT.test(candidateSourceCommit??""))return false;
  return forwardMacVersion(installedVersion,candidateVersion);
}
export function candidateName(meta,sha,arch=process.arch){
  const rust=meta.agent_runtime==="rust-standard-darwin-v1";
  if(!SHA.test(sha)||meta.source_commit!==sha||!VERSION.test(meta.version)||
    !["arm64","x64"].includes(arch)||meta.target!=="darwin-"+arch||
    meta.artifact_schema!==1||meta.device_protocol!==2||meta.receipt_schema!==1||
    meta.candidate_profile!=="darwin-permanent-local-v1"||
    (rust&&meta.runtime_profile!=="standard-darwin-rust-runtime-v1")||
    (!rust&&(meta.agent_runtime??"node-v2")!=="node-v2")||
    meta.native_supervisor!=="darwin-owned-group-v1"||
    !Array.isArray(meta.modules)||!meta.modules.includes("macos-permanent.ts"))
    throw Error("Unexpected source commit, architecture or manifest.");
  return meta.version+"-darwin-"+arch;
}
export async function checkCandidate(bundle,sha){
  if(!path.isAbsolute(bundle))throw Error("Bundle must be absolute.");
  await checked(bundle,{dir:true});
  const manifest=path.join(bundle,"bundle.json");
  await checked(manifest,{mode:0o600});
  const meta=JSON.parse(await readFile(manifest,"utf8"));
  const name=candidateName(meta,sha);
  for(const [relative,mode] of [
    ["bin/node",0o700],["apps/remote-control-agent/.build/darwin-session-supervisor",0o700],
    ["apps/remote-control-agent/src/macos-permanent.js",0o600],
    ["apps/remote-control-agent/src/v2-session-client.js",0o600],
    ["apps/remote-control-agent/scripts/macos-local.mjs",0o600],
    ...(meta.agent_runtime==="rust-standard-darwin-v1"
      ?[["apps/remote-control-agent/.build/rca-standard-darwin-candidate",0o700]]:[])
  ])await checked(path.join(bundle,relative),{mode});
  return name;
}
const run=(command,args)=>spawnSync(command,args,{encoding:"utf8",timeout:10000,maxBuffer:65536});
const launch=(args,invoke)=>{const r=invoke("/bin/launchctl",args);return !r.error&&r.status===0;};
// print can fail for reasons other than deregistration. Only the observed
// launchd "not found" result proves this user service has been removed.
export function launchctlServiceState(service,invoke){
  const r=invoke("/bin/launchctl",["print",service]);
  if(!r.error&&r.status===0)return "present";
  if(!r.error&&r.status===113&&/Could not find service/.test(String(r.stderr??"")))
    return "absent";
  return "unknown";
}
// bootout may acknowledge while launchd is still asynchronously removing its
// registration. Two read-only absent observations, bounded to 10 s; never
// repeat bootstrap blindly, and never confuse an unknown state with absence.
export async function awaitLaunchctlUnregistered(service,invoke,
  pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
  let absent=0;
  for(let i=0;i<40;i++){
    const state=launchctlServiceState(service,invoke);
    if(state==="unknown")throw Error("LaunchAgent deregistration state unknown.");
    if(state==="absent"){
      if(++absent===2)return true;
    }else absent=0;
    if(i<39)await pause(250);
  }
  return false;
}
// A successful bootout merely acknowledges a launchd request. A subsequent
// bootstrap must not race the old registration's asynchronous removal.
export async function stopLaunchdForSwitch(service,invoke,pause,bootout=true){
  if(bootout&&!launch(["bootout",service],invoke))
    throw Error("LaunchAgent bootout unconfirmed.");
  if(!await awaitLaunchctlUnregistered(service,invoke,pause))
    throw Error("LaunchAgent deregistration not confirmed.");
}
export function remoteJobLabel(id){
  if(!ID.test(id))throw Error("Invalid one-shot upgrade operation.");
  return "org.mcp-workers.rca-upgrade-"+id.replaceAll("-","");
}
// launchctl submit restarts failed jobs (confirmed by the real Mac incident).
// A private, launch-on-load plist with LaunchOnlyOnce prevents any replay even
// when the detached worker exits nonzero or when the same owner logs in again.
export function remoteJobPlist(id,node,worker,dir){
  const label=remoteJobLabel(id);
  const escape=s=>s.replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
  if(![node,worker,dir].every(s=>path.isAbsolute(s)))
    throw Error("Absolute owner-private job paths required.");
  const arg=x=>"<string>"+escape(x)+"</string>";
  return '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '+
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'+
    '<plist version="1.0"><dict>\n'+
    '<key>Label</key>'+arg(label)+'\n'+
    '<key>ProgramArguments</key><array>'+
    [node,worker,"worker",id].map(arg).join("")+'</array>\n'+
    '<key>RunAtLoad</key><true/>\n'+
    '<key>KeepAlive</key><false/>\n'+
    '<key>LaunchOnlyOnce</key><true/>\n'+
    '<key>StandardOutPath</key>'+arg(path.join(dir,"stdout.log"))+'\n'+
    '<key>StandardErrorPath</key>'+arg(path.join(dir,"stderr.log"))+'\n'+
    '</dict></plist>\n';
}
// launchctl's print output is an observation, not authority to mutate
// a job with a matching name. Require the complete known job definition.
function exitedAutomaticJob(output,service,job,node,worker,id){
  const lines=output.split("\n").map(line=>line.trim());
  const field=(name,value)=>{
    const matching=lines.filter(line=>line.startsWith(name+" = "));
    return matching.length===1&&matching[0]===name+" = "+value;
  };
  const argumentsAt=lines.indexOf("arguments = {");
  if(argumentsAt<0||lines.lastIndexOf("arguments = {")!==argumentsAt)return false;
  return lines[0]===service+" = {"&&field("path",job)&&field("program",node)&&
    field("state","not running")&&!lines.some(line=>line.startsWith("pid = "))&&
    JSON.stringify(lines.slice(argumentsAt+1,argumentsAt+6))===JSON.stringify([node,worker,"worker",id,"}"]);
}
// Only retire a completed automatic job whose exact private plan and
// result match. Unknown dispatch/exit or a retained switch journal blocks.
export async function reconcileAutomaticMacJob(home,invoke=run,pause){
  const mac=path.join(home,...ROOT,"macos"),tasks=path.join(mac,"remote-upgrades");
  const marker=path.join(tasks,"active.json");
  if(!await statMaybe(marker))return;
  await checked(tasks,{dir:true});await checked(marker,{mode:0o600});
  const originalMarker=await readFile(marker,"utf8");
  const state=JSON.parse(originalMarker);
  if(state.automatic!==true||!ID.test(state.id)||state.label!==remoteJobLabel(state.id))
    throw Error("Unresolved existing upgrade operation.");
  const dir=path.join(tasks,state.id),context=path.join(dir,"context.json"),resultFile=path.join(dir,"result.json");
  await checked(dir,{dir:true});await checked(context,{mode:0o600});await checked(resultFile,{mode:0o600});
  const plan=JSON.parse(await readFile(context,"utf8")),result=JSON.parse(await readFile(resultFile,"utf8"));
  if(plan.automatic!==true||plan.id!==state.id||plan.label!==state.label||plan.version!==state.version||
     plan.state!=="owner_authorized_remote_upgrade"||!SHA.test(plan.sourceSha)||
     !/^[a-f0-9]{64}$/.test(plan.expectedBinding)||
     result.id!==state.id||result.version!==state.version||
     !["connected_observed","waiting_idle","failed_recovered","deferred"].includes(result.status)||
     await statMaybe(path.join(mac,"switch.json")))
    throw Error("Automatic upgrade outcome unconfirmed.");
  const key=path.join(home,...ROOT,"v2-identity.pem");
  await checked(key,{mode:0o600});await checked(key+".device-id",{mode:0o600});
  const deviceId=(await readFile(key+".device-id","utf8")).trim();
  const evidence=await readMacAutomaticResult(key,deviceId);
  const expected=result.status==="connected_observed"?"success":result.status;
  if(result.status!=="deferred"&&!(
      evidence?.status===expected&&evidence.operation_id===state.id.replaceAll("-","")&&
      evidence.target_version===stableMacTag(state.version)||
      result.status==="waiting_idle"&&evidence?.status==="failed_recovered"))
    throw Error("Automatic result evidence not confirmed.");
  const node=path.join(dir,"bundle/bin/node"),worker=path.join(dir,"bundle/apps/remote-control-agent/scripts/macos-remote-upgrade.mjs");
  const job=path.join(dir,"job.plist");await checked(job,{mode:0o600});
  if(await readFile(job,"utf8")!==remoteJobPlist(state.id,node,worker,dir))
    throw Error("Automatic job definition changed.");
  const service="gui/"+process.getuid()+"/"+state.label;
  const observed=invoke("/bin/launchctl",["print",service]);
  if(!observed.error&&observed.status===0){
    const output=String(observed.stdout??"");
    if(!exitedAutomaticJob(output,service,job,node,worker,state.id))
      throw Error("Automatic job still running or identity uncertain.");
    await stopLaunchdForSwitch(service,invoke,pause);
  }else{
    if(observed.error||observed.status!==113||!/Could not find service/.test(String(observed.stderr??"")))
      throw Error("Automatic job state unknown.");
    await stopLaunchdForSwitch(service,invoke,pause,false);
  }
  if(await readFile(marker,"utf8")!==originalMarker)
    throw Error("Automatic job marker changed.");
  // Keep the admission marker if deleting the private attempt fails.
  // Never authorize a new attempt while an old job's outcome is uncertain.
  await checked(dir,{dir:true});
  await rm(dir,{recursive:true});
  if(await readFile(marker,"utf8")!==originalMarker)
    throw Error("Automatic job marker changed.");
  await rm(marker);
}
export function parseFreezeReply(frame){
  if(!["ready\n","busy\n","released\n"].includes(frame))
    throw Error("Freeze response unconfirmed.");
  return frame.slice(0,-1);
}
export async function freeze(key,command="freeze"){
  const socketPath=path.join(path.dirname(key),"upgrade.sock");
  await checked(socketPath,{optional:false}).catch(async e=>{
    const st=await statMaybe(socketPath);
    if(!st||!st.isSocket()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw e;
  });
  return await new Promise((resolve,reject)=>{
    const socket=createConnection(socketPath);let finished=false,buffer="";
    const done=(err,result)=>{
      if(finished)return;finished=true;clearTimeout(timer);socket.destroy();
      if(err)reject(err);else resolve(result);
    };
    const timer=setTimeout(()=>done(Error("Freeze timeout.")),3000);
    socket.on("connect",()=>socket.write(command+"\n"));
    socket.on("data",chunk=>{
      buffer+=String(chunk);
      if(buffer.length>9)done(Error("Freeze response unconfirmed."));
      else if(buffer.includes("\n")){
        try{done(null,parseFreezeReply(buffer));}catch(error){done(error);}
      }
    });
    socket.on("error",err=>done(err));
    socket.on("end",()=>done(Error("Freeze response unconfirmed.")));
  });
}
export async function ownedWrite(file,content,replace=false,mode=0o600,parentPrivate=true){
  // Keep sensitive RCA directories private; LaunchAgents/bin only forbid outside writes.
  await checked(path.dirname(file),{dir:true,privateOnly:parentPrivate});
  if(replace)await checked(file,{mode});
  else if(await statMaybe(file))throw Error("Owned file already exists.");
  const temp=path.join(path.dirname(file),".new-"+randomUUID());
  await writeFile(temp,content,{flag:"wx",mode,flush:true});
  try{await rename(temp,file);}catch(e){await rm(temp,{force:true});throw e;}
}
// Local CLI dispatches only to the version-pinned, owner-private manager.
export function ownerCliText(root,legacy=false){
  const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  const node=path.join(root,"bin/node");
  const manager=path.join(root,"apps/remote-control-agent/scripts/macos-local.mjs");
  return '#!/bin/sh\nset -eu\ncase "${1:-}" in\n'+
    (legacy
      ?'  status|stop|start) [ "$#" -eq 1 ] || exit 2 ;;\n'
      :'  status|doctor) [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ "$2" = --json ]; } || exit 2 ;;\n'+
       '  update|upgrade) [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && { [ "$2" = --check ] || [ "$2" = --auto ]; }; } || { [ "$#" -eq 3 ] && [ "$2" = --auto ] && { [ "$3" = on ] || [ "$3" = off ]; }; } || exit 2 ;;\n'+
       '  \"\"|stop|start|restart|pair|recover|logs|uninstall|--help|--version) [ "$#" -le 1 ] || exit 2 ;;\n')+
    '  *) echo "Use the reviewed macOS installer for install/upgrade." >&2; exit 2 ;;\n'+
    'esac\nexec '+quote(node)+' '+quote(manager)+(legacy?' "$1"\n':' "$@"\n');
}
export function matchesOwnerCli(text,root){
  return text===ownerCliText(root)||text===ownerCliText(root,true);
}
async function approved(key){
  if(!await checked(key,{optional:true,mode:0o600})||
     !await checked(key+".device-id",{optional:true,mode:0o600}))return false;
  return ID.test((await readFile(key+".device-id","utf8")).trim());
}
// The same identity-bound consent record as Linux. A missing record is
// an existing-installation opt-out, never implicit continuing consent.
export async function readMacAutoPolicy(key,deviceId){
  const file=key+".automatic-update";
  try{
    if(!await checked(file,{optional:true,mode:0o600}))return "off";
    if((await lstat(file)).size>256)return "unknown";
    const value=JSON.parse(await readFile(file,"utf8"));
    if(!value||typeof value!=="object"||Object.keys(value).length!==2||
       typeof value.device_id!=="string"||typeof value.enabled!=="boolean")return "unknown";
    return ID.test(deviceId)&&value.device_id===deviceId&&value.enabled?"on":"off";
  }catch{return "unknown";}
}
export async function writeMacAutoPolicy(key,deviceId,enabled){
  if(!ID.test(deviceId)||typeof enabled!=="boolean"||
     !await approved(key)||(await readFile(key+".device-id","utf8")).trim()!==deviceId)
    throw Error("Existing device identity changed.");
  const file=key+".automatic-update";
  const replace=await checked(file,{optional:true,mode:0o600});
  await ownedWrite(file,JSON.stringify({device_id:deviceId,enabled}),replace);
}
// Shared result semantics with the Linux/Windows owner managers.
const STABLE_TAG=/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export function macInstalledVersion(directory){
  const match=/^(v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)-darwin-(?:arm64|x64)$/.exec(directory);
  return match?.[1]??null;
}
export function stableMacTag(directory){
  const tag=macInstalledVersion(directory);
  return tag&&STABLE_TAG.test(tag)?tag:null;
}
export function parseMacAutomaticResult(value,deviceId){
  if(!value||typeof value!=="object"||Object.keys(value).length!==6||
     typeof value.device_id!=="string"||!ID.test(value.device_id)||
     typeof value.operation_id!=="string"||!(/^[a-f0-9]{32}$/).test(value.operation_id)||
     typeof value.target_version!=="string"||!STABLE_TAG.test(value.target_version)||
     typeof value.installed_version!=="string"||!STABLE_TAG.test(value.installed_version)||
     !Number.isSafeInteger(value.updated_at_unix_ms)||value.updated_at_unix_ms<0||
     !["success","failed_recovered","waiting_idle"].includes(value.status)||
     (value.status==="success")!==(value.installed_version===value.target_version))
    throw Error("Unrecognized final upgrade evidence.");
  return value.device_id===deviceId?value:null;
}
export async function readMacAutomaticResult(key,deviceId){
  const file=key+".native-upgrade-result";
  if(!await checked(file,{optional:true,mode:0o600}))return null;
  if((await lstat(file)).size>512)throw Error("Unrecognized final upgrade evidence.");
  return parseMacAutomaticResult(JSON.parse(await readFile(file,"utf8")),deviceId);
}
export function macAutomaticResultAdmits(prior,target,action="admit"){
  return !(prior?.status==="failed_recovered"&&
    (action==="waiting_idle"||(action==="admit"&&prior.target_version===target)));
}
async function writeMacAutomaticResult(key,deviceId,installed,target,status,operation){
  if(!await approved(key)||(await readFile(key+".device-id","utf8")).trim()!==deviceId)
    throw Error("Existing identity changed.");
  const prior=await readMacAutomaticResult(key,deviceId);
  if(!macAutomaticResultAdmits(prior,target,status))return;
  const value={device_id:deviceId,operation_id:operation.replaceAll("-",""),
    installed_version:status==="success"?target:installed,target_version:target,status,
    updated_at_unix_ms:Date.now()};
  parseMacAutomaticResult(value,deviceId);
  const file=key+".native-upgrade-result";
  await ownedWrite(file,JSON.stringify(value),await checked(file,{optional:true,mode:0o600}));
}
export async function requireMacAutomatic(key,installed,target,request=freeze){
  if(!installed||!STABLE_TAG.test(installed)||!await approved(key))
    throw Error("Automatic update requires a Stable permanent Agent.");
  const id=(await readFile(key+".device-id","utf8")).trim();
  if(await readMacAutoPolicy(key,id)!=="on")
    throw Error("Automatic update policy is not enabled.");
  if(target&&(!STABLE_TAG.test(target)||!forwardMacVersion(
      installed+"-darwin-"+process.arch,target+"-darwin-"+process.arch)))
    throw Error("Automatic update requires a newer Stable version.");
  if(!macAutomaticResultAdmits(await readMacAutomaticResult(key,id),target))
    throw Error("Previously recovered failed version suppressed for automatic update.");
  if(await request(key,"verify-online")!=="ready")
    throw Error("Current signed WSS unconfirmed.");
  if(!await approved(key)||(await readFile(key+".device-id","utf8")).trim()!==id||
     await readMacAutoPolicy(key,id)!=="on")
    throw Error("Automatic update authority changed.");
  return id;
}
// Bind the attended operation to the existing local target, not to whatever
// identity or LaunchAgent happens to be present after confirmation/staging.
export async function macUpgradeBinding({key,plist,cli,endpointFile,stopMark,journal},ownJournal){
  const pending=await checked(journal,{optional:true,mode:0o600});
  if(ownJournal!==undefined){
    if(!pending||await readFile(journal,"utf8")!==ownJournal)
      throw Error("Existing upgrade journal changed.");
  }else if(pending)throw Error("Unresolved upgrade journal: manual reconciliation required.");
  if(!await approved(key))throw Error("Approved permanent identity required.");
  const read=async(file,mode,optional=false)=>await checked(file,{mode,optional})
    ?await readFile(file,"utf8"):null;
  const hash=async file=>createHash("sha256").update(await readFile(file)).digest("hex");
  return {plist:await read(plist,0o600),cli:await read(cli,0o700,true),
    endpoint:(await read(endpointFile,0o600,true))?.trim()??null,
    stop:await read(stopMark,0o600,true),
    keyHash:await hash(key),idHash:await hash(key+".device-id")};
}
// Only the exact reviewed installed program inventory is removable.
export async function reviewedMacPrograms(programs){
  await checked(programs,{dir:true});
  const roots=[];
  for(const name of await readdir(programs)){
    const root=path.join(programs,name);
    await checked(root,{dir:true});
    const manifest=path.join(root,"bundle.json");
    await checked(manifest,{mode:0o600});
    const meta=JSON.parse(await readFile(manifest,"utf8"));
    if(name!==await checkCandidate(root,meta.source_commit))
      throw Error("Unreviewed installed program.");
    const app="apps/remote-control-agent";
    const expected=new Set(["bundle.json","bin/node",app+"/package.json",
      app+"/scripts/macos-local.mjs",app+"/scripts/macos-remote-upgrade.mjs",
      app+"/.build/darwin-session-supervisor"]);
    for(const module of meta.modules){
      if(!/^[a-z0-9-]+\.ts$/.test(module))throw Error("Unreviewed module inventory.");
      expected.add(app+"/src/"+module.replace(/\.ts$/,".js"));
    }
    if(meta.agent_runtime==="rust-standard-darwin-v1")
      expected.add(app+"/.build/rca-standard-darwin-candidate");
    // Older verified Node bundles predate the packaged updater.
    const updater=app+"/scripts/macos-update.sh";
    if(await statMaybe(path.join(root,updater)))expected.add(updater);
    const dirs=new Set();
    for(const file of expected){
      for(let parent=path.dirname(file);parent!==".";parent=path.dirname(parent))dirs.add(parent);
    }
    const walk=async(dir,relative="")=>{
      for(const entry of await readdir(dir)){
        const rel=relative?relative+"/"+entry:entry;
        const item=path.join(dir,entry);
        if(dirs.has(rel)){
          await checked(item,{dir:true});await walk(item,rel);
        }else{
          if(!expected.delete(rel))throw Error("Unexpected file in reviewed program.");
          await checked(item,{mode:rel==="bin/node"||rel.includes("/.build/")?0o700:0o600});
        }
      }
    };
    await walk(root);
    if(expected.size)throw Error("Incomplete installed program inventory.");
    roots.push(root);
  }
  return roots.sort();
}
// Native ps is a conservative exit observation, never a termination mechanism.
export function noOtherMacPrograms(programs,invoke=run,ownPid=process.pid,uid=process.getuid?.()){
  const result=invoke("/bin/ps",["-axww","-o","pid=,uid=,command="]);
  if(result.error||result.status!==0||!String(result.stdout??"").trim())return false;
  for(const line of String(result.stdout).trim().split("\n")){
    const row=/^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/.exec(line);
    if(!row)return false;
    if(Number(row[1])!==ownPid&&Number(row[2])===uid&&row[3].includes(programs+"/"))return false;
  }
  return true;
}
// The existing recovery journal is also the exclusive admission marker.
// Unlike rename(), an exclusive create cannot overwrite a competing claim.
export async function reserveMacSwitch(journal,record,recheck,requestFreeze,onBusy){
  await checked(path.dirname(journal),{dir:true});
  await writeFile(journal,record,{flag:"wx",mode:0o600,flush:true});
  const discardBeforeSwitch=async()=>{
    await checked(journal,{mode:0o600});
    if(await readFile(journal,"utf8")!==record)
      throw Error("Existing upgrade journal changed.");
    await rm(journal);
  };
  try{await recheck();}
  catch(error){await discardBeforeSwitch();throw error;}
  if(!requestFreeze)return false;
  let answer;
  try{answer=await requestFreeze();}
  catch{throw Error("Freeze ownership unknown; journal retained.");}
  if(answer==="ready")return true;
  if(answer==="busy"){
    if(onBusy)await onBusy();
    await discardBeforeSwitch();
    const error=Error("Busy or uncertain Agent; refuse switch.");
    error.code="RCA_BUSY";
    throw error;
  }
  throw Error("Freeze ownership unknown; journal retained.");
}
export function macBindingDigest(binding){
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}
function macServicePid(current,service,invoke){
    const result=invoke("/bin/launchctl",["print",service]);
    if(result.error||result.status!==0)return null;
    const output=String(result.stdout??"");
    const executable=current.agentRuntime==="rust-standard-darwin-v1"
      ?path.join(current.root,"apps/remote-control-agent/.build/rca-standard-darwin-candidate")
      :path.join(current.root,"bin/node");
    const programs=output.split("\n").map(line=>line.trim()).filter(line=>line.startsWith("program = "));
    if(programs.length!==1||programs[0]!=="program = "+executable)return null;
    const matches=[...output.matchAll(/(?:^|\n)\s*pid = ([1-9][0-9]*)(?=\n|$)/g)];
    return matches.length===1&&Number.isSafeInteger(Number(matches[0][1]))?Number(matches[0][1]):null;
}
// Status observes OS registration, the matching connection marker, and the
// existing read-only local control socket; never contact GitHub or the Worker.
export async function observeMacLocalService(identity,current,service,invoke,request=freeze){
  const facts={local_service:"present_unverified",signed_wss:"unconfirmed",last_online:"unconfirmed"};
  const readPid=()=>macServicePid(current,service,invoke);
  try{
    const pid=readPid();
    if(!pid)return facts;
    const file=path.join(identity,"macos-connection.json");
    if(!await checked(file,{optional:true,mode:0o600})||(await lstat(file)).size>1024)return facts;
    const raw=await readFile(file,"utf8"),marker=JSON.parse(raw);
    if(marker.generation!==current.generation||marker.pid!==pid||
       !["connected","disconnected","rejected"].includes(marker.state))return facts;
    const at=typeof marker.at==="number"?marker.at:Date.parse(marker.at);
    if(!Number.isSafeInteger(at)||at<0||at>Date.now()+10000)return facts;
    facts.local_service="running_observed";
    if(marker.state==="connected"){
      facts.last_online=new Date(at).toISOString();
      if(await request(path.join(identity,"v2-identity.pem"),"verify-online")==="ready"&&
         readPid()===pid&&await readFile(file,"utf8")===raw)
        facts.signed_wss="connected_observed";
    }
  }catch{/* Preserve established local observations, never infer connectivity. */}
  return facts;
}
export async function observeOnline(identity,generation,now=Date.now){
  const start=now(),file=path.join(identity,"macos-connection.json");
  for(let i=0;i<50;i++){
    if(await checked(file,{optional:true,mode:0o600})){
      const r=JSON.parse(await readFile(file,"utf8"));
      const connectedAt=typeof r.at==="number"&&Number.isSafeInteger(r.at)
        ?r.at:typeof r.at==="string"?Date.parse(r.at):NaN;
      if(r.generation===generation&&r.state==="connected"&&connectedAt>=start-3000)return true;
      if(r.generation===generation&&r.state==="rejected")return false;
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  return false;
}
export function acceptsOwnerConfirmation(input){
  return /^(?:y|yes)$/i.test(input.trim());
}
export async function confirm(question){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error("Owner terminal required.");
  const reader=createInterface({input:process.stdin,output:process.stdout,terminal:false});
  return await new Promise(resolve=>{
    reader.once("close",()=>resolve(false));
    reader.question(question+" Confirm [y/N]: ",answer=>{
      resolve(acceptsOwnerConfirmation(answer));
      reader.close();
    });
  });
}
/** Host mutation only after local owner consent and a pinned source candidate. */
export async function localMacAction(action,{home=os.homedir(),bundle,sourceSha,endpoint,expectedBinding,policyAction,automaticOperation,
  invoke=run,ask=confirm,online=observeOnline,freezeAgent=freeze,ownerIntent,
  runTemporary=spawnSync,runUpdate=spawnSync,terminal=()=>!!(process.stdin.isTTY&&process.stdout.isTTY),
  pauseLaunchd=ms=>new Promise(resolve=>setTimeout(resolve,ms)),doFetch=fetch}={}){
  if(!["install","upgrade","status","doctor","check-update","update-latest","automatic-check","update-policy","stop","start","restart","pair","recover","logs","uninstall","temporary"].includes(action))
    throw Error("Unsupported local action.");
  if(process.platform!=="darwin"||!["arm64","x64"].includes(process.arch)||
    Number.parseInt(os.release(),10)<24||process.getuid?.()===0)
    throw Error("Native unprivileged macOS 15+ ARM64 or x64 required.");
  if(expectedBinding!==undefined&&(action!=="upgrade"||!(/^[a-f0-9]{64}$/).test(expectedBinding)))
    throw Error("Invalid expected upgrade binding.");
  if(automaticOperation!==undefined&&(action!=="upgrade"||!ID.test(automaticOperation)||!expectedBinding))
    throw Error("Invalid automatic upgrade context.");
  if(policyAction!==undefined&&(action!=="update-policy"||!["on","off"].includes(policyAction)))
    throw Error("Invalid automatic update policy action.");
  const readOnly=action==="status"||action==="doctor"||action==="check-update"||action==="update-latest"||action==="automatic-check"||action==="update-policy"||action==="logs"||action==="pair"||action==="recover"||action==="uninstall";
  if(!readOnly)process.umask(0o077);
  if(action==="temporary"){
    // Reuse the signed 24-hour foreground Agent: no LaunchAgent, no service
    // state mutation and no extra permanent identity or registration.
    if(!terminal())throw Error("Owner terminal required for temporary pairing.");
    if(!bundle||!sourceSha||!endpoint)throw Error("Reviewed temporary candidate required.");
    const origin=verifiedEndpoint(endpoint);
    await checkCandidate(bundle,sourceSha);
    const node=path.join(bundle,"bin/node");
    const entry=path.join(bundle,"apps/remote-control-agent/src/macos-temporary.js");
    await checked(entry,{mode:0o600});
    const result=runTemporary(node,[entry,"--endpoint",origin,"--bootstrap-selected"],
      {stdio:"inherit"});
    if(result.error||result.signal||result.status!==0)
      throw Error("Temporary Agent ended without confirmed success.");
    return {status:"temporary_session_ended"};
  }
  await checked(home,{dir:true,privateOnly:false});
  const identity=await directories(home,ROOT,!readOnly);
  const receipts=await directories(home,[".local","state","mcp-workers","remote-control-agent"],!readOnly);
  await checked(path.join(receipts,"operation-receipts.sqlite"),{optional:true,mode:0o600});
  const macos=await directories(home,[...ROOT,"macos"],!readOnly);
  const programs=await directories(home,[...ROOT,"macos","programs"],!readOnly);
  const localBin=await directories(home,[".local","bin"],!readOnly);
  const cli=path.join(localBin,"rca");
  const agents=await directories(home,["Library","LaunchAgents"],!readOnly);
  const plist=path.join(agents,LABEL+".plist");
  const stopMark=path.join(macos,"stopped"), journal=path.join(macos,"switch.json");
  const journalPresent=await checked(journal,{optional:true,mode:0o600});
  if(journalPresent&&action!=="recover"){
    // A switch may have left plist and CLI at different generations.
    // Report only established facts; never interpret the journal as a
    // successful switch. Revoking continuing consent needs no cutover.
    if(action==="status"||action==="doctor"||action==="logs"||
       (action==="update-policy"&&policyAction!=="on")){
      const key=path.join(identity,"v2-identity.pem");
      let deviceId=null,policy="unknown";
      if(await approved(key)){
        deviceId=(await readFile(key+".device-id","utf8")).trim();
        policy=await readMacAutoPolicy(key,deviceId);
      }
      if(action==="update-policy"){
        if(!deviceId)throw Error("Existing approved permanent identity required.");
        if(policyAction==="off"){
          await writeMacAutoPolicy(key,deviceId,false);
          policy=await readMacAutoPolicy(key,deviceId);
          if(policy!=="off")throw Error("Automatic update policy unconfirmed.");
        }
        return {automatic_update:policy};
      }
      const state={installed:null,version:null,platform:"darwin",arch:process.arch,local_service:"unconfirmed",
        cloud_approval:"unconfirmed",signed_wss:"unconfirmed",
        last_online:"unconfirmed",receipts:"preserved_unverified",
        automatic_update:policy,automatic_update_activity:"needs_attention"};
      return action==="status"||action==="logs"?state:{status:state,findings:[
        "unresolved_upgrade_journal","local_service_unconfirmed",
        "cloud_authorization_unconfirmed","signed_wss_unconfirmed"]};
    }
    throw Error("Unresolved upgrade journal: manual reconciliation required.");
  }
  const old=await checked(plist,{optional:true,mode:0o600})
    ?await readFile(plist,"utf8"):null;
  const endpointFile=path.join(macos,"endpoint");
  const stored=await checked(endpointFile,{optional:true,mode:0o600})
    ?(await readFile(endpointFile,"utf8")).trim():null;
  if(stored)verifiedEndpoint(stored);
  if(endpoint)verifiedEndpoint(endpoint);
  if(stored&&endpoint!==undefined&&stored!==endpoint)
    throw Error("Endpoint identity cannot change during upgrade.");
  const bound=endpoint??stored;
  const current=old?parsePlist(old,programs,bound):null;
  const previousCli=await checked(cli,{optional:true,mode:0o700})
    ?await readFile(cli,"utf8"):null;
  // Never replace a foreign executable, symlink or mismatched owner version.
  // Accept the exact previously published launcher until normal upgrade.
  if(previousCli!==null&&(!current||!matchesOwnerCli(previousCli,current.root)))
    throw Error("Foreign or inconsistent local rca executable.");
  if(current){
    for(const rel of ["", "bin", "apps", "apps/remote-control-agent",
        "apps/remote-control-agent/src"])
      await checked(path.join(current.root,rel),{dir:true});
    for(const rel of ["bin/node","apps/remote-control-agent/src/macos-permanent.js"])
      await checked(path.join(current.root,rel),{mode:rel==="bin/node"?0o700:0o600});
    if(current.agentRuntime==="rust-standard-darwin-v1")
      await checked(path.join(current.root,"apps/remote-control-agent/.build/rca-standard-darwin-candidate"),{mode:0o700});
  }
  const stopped=await checked(stopMark,{optional:true,mode:0o600});
  const service="gui/"+process.getuid()+"/"+LABEL,domain="gui/"+process.getuid();
  const key=path.join(identity,"v2-identity.pem");
  const signedIntent=async(action)=>{
    if(ownerIntent)return ownerIntent(action);
    if(!current||!bound||!await approved(key))throw Error("Approved permanent identity required.");
    const modulePath=path.join(current.root,"apps/remote-control-agent/src/v2-session-client.js");
    await checked(modulePath,{mode:0o600});
    const {sendSignedOwnerIntent}=await import(pathToFileURL(modulePath).href);
    if(typeof sendSignedOwnerIntent!=="function")throw Error("Candidate does not support owner intent.");
    return sendSignedOwnerIntent(bound,key,action);
  };
  if(action==="uninstall"){
    if(!terminal()||!current||!previousCli||!await approved(key))
      throw Error("Owner terminal and reviewed permanent installation required.");
    if(await statMaybe(path.join(macos,"remote-upgrades","active.json")))
      throw Error("Unresolved detached upgrade; preserve recovery files.");
    const roots=await reviewedMacPrograms(programs);
    if(!roots.includes(current.root))throw Error("Installed service missing from reviewed inventory.");
    if(!await ask("Uninstall "+roots.length+" reviewed Agent version(s) and the local startup mechanism? Identity, receipts and cloud authorization are retained."))
      throw Error("Owner declined.");
    const files={key,plist,cli,endpointFile,stopMark,journal};
    const binding=await macUpgradeBinding(files),before=launchctlServiceState(service,invoke);
    if(before==="unknown"||(stopped&&before!=="absent")||(!stopped&&before!=="present"))
      throw Error("Local service state uncertain; inspect before uninstall.");
    const pid=before==="present"?macServicePid(current,service,invoke):null;
    if(before==="present"&&!pid)throw Error("Owned Agent process not established.");
    const record=JSON.stringify({phase:"uninstall_pending",version:path.basename(current.root),
      generation:current.generation,binding:macBindingDigest(binding)})+"\n";
    const recheck=async()=>{
      if(macBindingDigest(await macUpgradeBinding(files,record))!==macBindingDigest(binding)||
         JSON.stringify(await reviewedMacPrograms(programs))!==JSON.stringify(roots)||
         await statMaybe(path.join(macos,"remote-upgrades","active.json")))
        throw Error("Uninstall target changed.");
    };
    await reserveMacSwitch(journal,record,recheck,pid?()=>freezeAgent(key):null);
    let stoppedLocal=false;
    try{
      await recheck();
      if(pid){
        if(macServicePid(current,service,invoke)!==pid||await freezeAgent(key,"verify-frozen")!=="ready")
          throw Error("Uninstall freeze unconfirmed.");
        await stopLaunchdForSwitch(service,invoke,pauseLaunchd);
      }else await stopLaunchdForSwitch(service,invoke,pauseLaunchd,false);
      stoppedLocal=true;
      if(!noOtherMacPrograms(programs,invoke))throw Error("Other Agent processes may still be active.");
      await recheck();
      // Only remove the reviewed program tree and startup entries. The
      // identity store and shared SQLite receipts are outside these paths.
      await rm(plist);
      await rm(cli);
      for(const root of roots)await rm(root,{recursive:true});
      if(await statMaybe(plist)||await statMaybe(cli)||(await readdir(programs)).length!==0||
         launchctlServiceState(service,invoke)!=="absent")
        throw Error("Software removal unconfirmed.");
      if(await readFile(journal,"utf8")!==record)throw Error("Uninstall journal changed.");
      await rm(journal);
      return {status:"uninstalled",removed_versions:roots.map(root=>path.basename(root)),
        identity_preserved:true,receipts_preserved:true,cloud_revocation:"not_performed"};
    }catch(error){
      if(!stoppedLocal&&pid&&macServicePid(current,service,invoke)===pid){
        try{
          await recheck();
          if(await freezeAgent(key,"release")!=="released")throw Error("Freeze release unconfirmed.");
          if(await readFile(journal,"utf8")!==record)throw Error("Uninstall journal changed.");
          await rm(journal);
        }catch{throw Error("Uninstall outcome unknown; journal retained.");}
      }
      throw error;
    }
  }
  if(action==="recover"){
    if(!terminal())throw Error("Owner terminal required for recovery.");
    if(!journalPresent){
      await reconcileAutomaticMacJob(home,invoke,pauseLaunchd);
      return {status:"no_unresolved_switch",identity_preserved:true};
    }
    // Only the same-configuration restart can be retired from a proven
    // replacement process. Unknown upgrade states need existing reviewed recovery.
    const raw=await readFile(journal,"utf8"),record=JSON.parse(raw);
    if(!current||stopped||record.phase!=="restart_pending"||
       record.version!==path.basename(current.root)||record.generation!==current.generation||
       !Number.isSafeInteger(record.pid)||record.pid<=0||!(/^[a-f0-9]{64}$/).test(record.binding??"")||
       await statMaybe(path.join(macos,"remote-upgrades","active.json")))
      throw Error("Unresolved upgrade: retain journal and use reviewed recovery.");
    const files={key,plist,cli,endpointFile,stopMark,journal};
    const verify=async()=>{
      const pid=macServicePid(current,service,invoke);
      return pid&&pid!==record.pid&&
        macBindingDigest(await macUpgradeBinding(files,raw))===record.binding&&
        (await observeMacLocalService(identity,current,service,invoke,freezeAgent)).signed_wss==="connected_observed";
    };
    if(!await verify())throw Error("Replacement signed Agent not established; preserve journal.");
    if(!await ask("Retire the completed restart journal? Identity and receipts are retained."))
      throw Error("Owner declined.");
    if(!await verify()||await readFile(journal,"utf8")!==raw)
      throw Error("Restart evidence changed; journal retained.");
    await rm(journal);
    return {status:"restart_reconciled",identity_preserved:true};
  }
  if(action==="pair"){
    if(!terminal()||!current||!bound||!await approved(key))
      throw Error("Owner terminal and existing approved installation required; use the reviewed installer otherwise.");
    const entry=path.join(current.root,"apps/remote-control-agent/src/macos-permanent.js");
    await checked(entry,{mode:0o600});
    const result=runTemporary(path.join(current.root,"bin/node"),[entry,"--endpoint",bound],{stdio:"inherit"});
    if(result.error||result.signal||result.status!==0)
      throw Error("Signed identity reconciliation unavailable; preserve the original identity.");
    return {status:"existing_identity_reconciled"};
  }
  if(readOnly){
    let deviceId=null,policy="off";
    if(current){
      try{
        if(await approved(key)){
          deviceId=(await readFile(key+".device-id","utf8")).trim();
          policy=await readMacAutoPolicy(key,deviceId);
        }
      }catch{policy="unknown";}
    }
    if(action==="update-policy"){
      if(!current||!deviceId)throw Error("Existing managed permanent service required.");
      if(policyAction!==undefined){
        const manifest=path.join(current.root,"bundle.json");
        await checked(manifest,{mode:0o600});
        const meta=JSON.parse(await readFile(manifest,"utf8"));
        if(path.basename(current.root)!==candidateName(meta,meta.source_commit))
          throw Error("Untrusted installed version.");
        if(policyAction==="on"&&!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(meta.version))
          throw Error("Automatic update requires a stable Agent.");
        if(policyAction==="on"&&await checked(journal,{optional:true,mode:0o600}))
          throw Error("Unresolved upgrade journal: manual reconciliation required.");
        await writeMacAutoPolicy(key,deviceId,policyAction==="on");
        policy=await readMacAutoPolicy(key,deviceId);
        if(policy!==policyAction)throw Error("Automatic update policy unconfirmed.");
      }
      return {automatic_update:policy};
    }
    const state={
      installed:!!current,version:current?macInstalledVersion(path.basename(current.root)):null,
      platform:"darwin",arch:process.arch,
      local_service:current?(stopped?"stopped_requested_unverified":"present_unverified"):"not_installed",
      cloud_approval:"unconfirmed",signed_wss:"unconfirmed",
      last_online:"unconfirmed",receipts:"preserved_unverified",
      automatic_update:policy,automatic_update_activity:policy==="off"?"disabled":"unknown",
    };
    if(deviceId&&current){
      try{
        const result=await readMacAutomaticResult(key,deviceId);
        if(result){
          state.automatic_update_result={...result,current:result.installed_version===state.version};
          if(state.automatic_update_result.current)
            state.automatic_update_activity=result.status==="failed_recovered"?"recovered":
              result.status==="waiting_idle"&&policy==="off"?"disabled":result.status;
        }
      }catch{state.automatic_update_activity="unknown";state.automatic_update_result={status:"unknown"};}
    }
    if(action==="status"||action==="doctor"||action==="logs"){
      if(current&&!stopped)Object.assign(state,await observeMacLocalService(identity,current,service,invoke,freezeAgent));
      try{
        const active=path.join(macos,"remote-upgrades","active.json");
        if(await checked(active,{optional:true,mode:0o600})){
          state.update_transaction="pending_or_cleanup";
          // A durable admission marker alone cannot prove active work.
          state.automatic_update_activity="unknown";
        }
      }catch{state.update_transaction="unknown";state.automatic_update_activity="unknown";}
    }
    if(action==="status")return state;
    if(action==="logs")return {source:"retained_local_connection_and_update_evidence",
      connection:state.signed_wss,last_online:state.last_online,update_activity:state.automatic_update_activity,
      update_result:state.automatic_update_result??null,transaction:state.update_transaction??null};
    if(action==="check-update"||action==="update-latest"||action==="automatic-check"){
      if(!current)throw Error("No existing managed macOS Agent.");
      const manifest=path.join(current.root,"bundle.json");
      await checked(manifest,{mode:0o600});
      const meta=JSON.parse(await readFile(manifest,"utf8"));
      if(path.basename(current.root)!==candidateName(meta,meta.source_commit))throw Error("Untrusted installed version.");
      if(action==="check-update")return checkLatestMacVersion(meta.version,process.arch,doFetch);
      if(action==="automatic-check"){
        // Known completed detached jobs must be retired even when Latest
        // is unchanged or the owner has since opted out.
        await reconcileAutomaticMacJob(home,invoke,pauseLaunchd);
        if(policy==="off")return {status:"disabled"};
        await requireMacAutomatic(key,stableMacTag(path.basename(current.root)),null,freezeAgent);
      }else if(!terminal())throw Error("Owner terminal required for update.");
      if(stopped||!bound||launchctlServiceState(service,invoke)!=="present")
        throw Error("Existing running owner service required for update.");
      const binding=await macUpgradeBinding({key,plist,cli,endpointFile,stopMark,journal});
      if(binding.plist!==old||binding.cli!==previousCli||binding.endpoint!==stored||binding.stop!==null)
        throw Error("Existing upgrade target changed.");
      const scripts=path.join(current.root,"apps/remote-control-agent/scripts");
      await checked(scripts,{dir:true});
      const updater=path.join(scripts,"macos-update.sh");
      await checked(updater,{mode:0o600});
      const result=runUpdate("/bin/sh",[updater,bound,meta.version,macBindingDigest(binding),
        ...(action==="automatic-check"?["--automatic"]:[])],{stdio:"inherit"});
      if(result.error||result.signal||result.status!==0)
        throw Error("Update stopped; inspect local status.");
      return {status:"installer_completed"};
    }

    const findings=[];
    if(!current)findings.push("permanent_service_not_installed");
    else if(state.local_service!=="running_observed")findings.push("local_service_unconfirmed");
    findings.push("cloud_authorization_unconfirmed");
    if(state.signed_wss!=="connected_observed")findings.push("signed_wss_unconfirmed");
    if(["unknown","needs_attention"].includes(state.automatic_update_activity)||state.update_transaction)
      findings.push("update_state_needs_review");
    return {status:state,findings};
  }
  if(action==="restart"){
    if(!terminal()||!current||stopped||!await approved(key))
      throw Error("Normal restart requires the local owner terminal and Owner-ON service.");
    if(await statMaybe(path.join(macos,"remote-upgrades","active.json")))
      throw Error("Unresolved detached upgrade; inspect before restart.");
    const files={key,plist,cli,endpointFile,stopMark,journal};
    const binding=await macUpgradeBinding(files);
    if(binding.plist!==old||binding.cli!==previousCli||binding.stop!==null)
      throw Error("Restart target changed.");
    const pid=macServicePid(current,service,invoke);
    if(!pid||(await observeMacLocalService(identity,current,service,invoke,freezeAgent)).signed_wss!=="connected_observed")
      throw Error("Current owned signed Agent not established.");
    const record=JSON.stringify({phase:"restart_pending",version:path.basename(current.root),
      generation:current.generation,binding:macBindingDigest(binding),pid})+"\n";
    const recheck=async()=>{
      if(macBindingDigest(await macUpgradeBinding(files,record))!==macBindingDigest(binding)||
        macServicePid(current,service,invoke)!==pid||await statMaybe(path.join(macos,"remote-upgrades","active.json")))
        throw Error("Restart target changed.");
    };
    await reserveMacSwitch(journal,record,recheck,()=>freezeAgent(key));
    const retire=async()=>{
      if(await readFile(journal,"utf8")!==record)throw Error("Restart journal changed.");
      await rm(journal);
    };
    try{
      await recheck();
      if(await freezeAgent(key,"verify-frozen")!=="ready")
        throw Error("Restart freeze unconfirmed.");
      await recheck();
      // Same registered service, no STOP, re-pair or version change.
      if(!launch(["kickstart","-k",service],invoke))
        throw Error("Restart request unconfirmed.");
      if(!await online(identity,current.generation))
        throw Error("New signed connection unconfirmed.");
      let confirmed=false;
      for(let attempt=0;attempt<20;attempt++){
        const next=macServicePid(current,service,invoke);
        if(next&&next!==pid&&
           (await observeMacLocalService(identity,current,service,invoke,freezeAgent)).signed_wss==="connected_observed"){
          confirmed=true;break;
        }
        if(attempt<19)await pauseLaunchd(250);
      }
      if(!confirmed||macBindingDigest(await macUpgradeBinding(files,record))!==macBindingDigest(binding))
        throw Error("Replacement signed Agent unconfirmed.");
      await retire();
      return {status:"restarted",signed_wss:"connected_observed"};
    }catch(error){
      // Only release the precise still-running Agent that granted this freeze.
      if(macServicePid(current,service,invoke)===pid){
        try{
          await recheck();
          if(await freezeAgent(key,"release")!=="released")throw Error("Freeze release unconfirmed.");
          await retire();
        }catch{throw Error("Restart outcome unknown; journal retained.");}
      }
      throw error;
    }
  }
  if(action==="stop"){
    if(!current||!await approved(key))throw Error("Existing approved LaunchAgent required.");
    if(!await ask("Intentionally stop this user LaunchAgent?"))throw Error("Owner declined.");
    // Durable OFF intent precedes service shutdown; even crash/reboot/upgrade respects it.
    await ownedWrite(stopMark,"stopped\n",stopped);
    let cloud="unconfirmed";
    try {await signedIntent('stop');cloud="confirmed";}catch{/* Local OFF still required. */}
    const serviceState=launchctlServiceState(service,invoke);
    if(serviceState==="unknown")throw Error("LaunchAgent state uncertain; owner STOP retained.");
    if(serviceState==="present"){
      if(!launch(["bootout",service],invoke))
        throw Error("Service bootout uncertain; owner STOP intent retained.");
      if(!await awaitLaunchctlUnregistered(service,invoke,pauseLaunchd))
        throw Error("LaunchAgent removal pending; owner STOP intent retained.");
    }
    return {status:"intentionally_stopped",cloud};
  }
  if(action==="start"){
    if(!current||!stopped||!await approved(key))throw Error("No deliberately stopped approved LaunchAgent.");
    if((await readFile(stopMark,"utf8"))!=="stopped\n")throw Error("Unsafe persisted owner STOP.");
    if(!await ask("Resume the previously stopped LaunchAgent?"))throw Error("Owner declined.");
    if(launchctlServiceState(service,invoke)!=="absent")
      throw Error("LaunchAgent registration not confirmed absent; owner STOP retained.");
    await signedIntent('stop'); // reconcile offline Stop first without extending cloud deadline
    const permitted=await signedIntent('resume');
    if(permitted.status!=="resume_pending")throw Error("Signed cloud Resume not authorized.");
    await rm(stopMark);
    try{
      const boot=invoke("/bin/launchctl",["bootstrap",domain,plist]);
      if(boot.error||boot.status!==0)
        throw Error("LaunchAgent bootstrap failed (exit="+
          (Number.isInteger(boot.status)?boot.status:"unknown")+").");
      if(!await online(identity,current.generation))throw Error("Signed WSS activation unconfirmed.");
    }catch(error){
      const state=launchctlServiceState(service,invoke);
      // Retain the user's OFF request even if launchd cleanup is uncertain.
      await ownedWrite(stopMark,"stopped\n");
      if(state==="unknown")throw Error("UNKNOWN stopped-state recovery; owner inspection required.");
      if(state==="present"&&!launch(["bootout",service],invoke))
        throw Error("UNKNOWN stopped-state recovery; owner inspection required.");
      if(!await awaitLaunchctlUnregistered(service,invoke,pauseLaunchd))
        throw Error("UNKNOWN stopped-state recovery; owner inspection required.");
      throw error;
    }
    return {status:"connected_observed",cloud:"signed_WSS_observed"};
  }
  if(!bundle||!sourceSha||!bound)throw Error("Reviewed candidate, source and endpoint required.");
  if(action==="install"&&current)throw Error("Existing identity requires upgrade.");
  if(stopped&&current&&launch(["print",service],invoke))
    throw Error("Stopped marker conflicts with an active service; inspect locally.");
  if(action==="upgrade"&&!current)throw Error("No existing permanent LaunchAgent.");
  const version=await checkCandidate(bundle,sourceSha);
  if(action==="upgrade"){
    const installedManifest=path.join(current.root,"bundle.json");
    await checked(installedManifest,{mode:0o600});
    const installedMeta=JSON.parse(await readFile(installedManifest,"utf8"));
    if(!admitsMacOwnerUpgrade({
      installedVersion:path.basename(current.root),
      installedSourceCommit:installedMeta.source_commit,
      candidateVersion:version,
      candidateSourceCommit:sourceSha,
    })) throw Error("Downgrade or non-forward version is not permitted.");
  }
  const bindingFiles={key,plist,cli,endpointFile,stopMark,journal};
  const binding=action==="upgrade"?await macUpgradeBinding(bindingFiles):null;
  if(expectedBinding!==undefined&&(!binding||macBindingDigest(binding)!==expectedBinding))
    throw Error("Existing upgrade target changed during download.");
  if(binding&&(binding.plist!==old||binding.cli!==previousCli||
    binding.endpoint!==stored||(binding.stop!==null)!==stopped||
    (binding.stop!==null&&binding.stop!=="stopped\n")))
    throw Error("Existing upgrade target changed.");
  const recheckBinding=async(ownJournal)=>{
    if(binding&&JSON.stringify(await macUpgradeBinding(bindingFiles,ownJournal))!==JSON.stringify(binding))
      throw Error("Existing upgrade target changed.");
  };
  const autoInstalled=automaticOperation?stableMacTag(path.basename(current.root)):null;
  const autoTarget=automaticOperation?stableMacTag(version):null;
  if(automaticOperation&&(!autoTarget||stopped))throw Error("Automatic update requires an owner-ON Stable Agent.");
  const autoId=automaticOperation?await requireMacAutomatic(key,autoInstalled,autoTarget,freezeAgent):null;
  const automaticResult=async status=>{
    if(!await approved(key)||createHash("sha256").update(await readFile(key)).digest("hex")!==binding.keyHash||
       createHash("sha256").update(await readFile(key+".device-id")).digest("hex")!==binding.idHash)
      throw Error("Automatic update identity changed.");
    await writeMacAutomaticResult(key,autoId,autoInstalled,autoTarget,status,automaticOperation);
  };
  const nextRoot=path.join(programs,version);
  if(await statMaybe(nextRoot))throw Error("Reviewed candidate already staged; never overwrite. " +
    "Inspect existing state and use a separately verified newer candidate; " +
    "the existing permanent identity and receipts remain unchanged.");
  const newStablePolicy=action==="install"&&!current&&!await statMaybe(key)&&
    !await statMaybe(key+".device-id")&&/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-darwin-(?:arm64|x64)$/.test(version);
  const notice=newStablePolicy
    ?" Automatic updates default to on after signed activation; disable with rca update --auto off.":"";
  if(!await ask("Install "+version+" into this personal Mac account?"+notice))throw Error("Owner declined.");
  await recheckBinding();
  // Stage the verified candidate side by side; never overwrite old binaries.
  const stage=path.join(programs,".staging-"+randomUUID());
  await cp(bundle,stage,{recursive:true,errorOnExist:true,force:false});
  await checked(stage,{dir:true});
  // Upgrades publish the verified candidate only after exclusive admission.
  // A busy attempt must not occupy the version path and prevent a later retry.
  if(action==="install")await rename(stage,nextRoot);
  if(!await approved(key)){
    if(action!=="install")throw Error("Upgrade cannot create a new identity.");
    const pair=spawnSync(path.join(nextRoot,"bin/node"),[
      path.join(nextRoot,"apps/remote-control-agent/src/macos-permanent.js"),
      "--endpoint",bound],{stdio:"inherit",timeout:660000});
    if(pair.error||pair.status!==0||!await approved(key))
      throw Error("Owner approval incomplete; staged candidate remains offline.");
  }
  await recheckBinding();
  const active=!!current&&!stopped&&launch(["print",service],invoke);
  if(current&&!stopped&&!active)throw Error("Service state uncertain; refuse upgrade.");
  const generation=randomUUID();
  const candidateMeta=JSON.parse(await readFile(path.join(action==="install"?nextRoot:stage,"bundle.json"),"utf8"));
  const agentRuntime=candidateMeta.agent_runtime??"node-v2";
  const rustEntry=path.join(nextRoot,"apps/remote-control-agent/.build/rca-standard-darwin-candidate");
  const next=plistText({
    node:path.join(nextRoot,"bin/node"),
    entry:agentRuntime==="rust-standard-darwin-v1"?rustEntry:
      path.join(nextRoot,"apps/remote-control-agent/src/macos-permanent.js"),
    endpoint:bound,generation,agentRuntime,
  });
  const record=JSON.stringify({
    version,previous:old,generation,stopped,phase:"switch_pending"})+"\n";
  let frozen;
  try{
    frozen=await reserveMacSwitch(journal,record,async()=>{
      await recheckBinding(record);
      if(action==="upgrade"&&await statMaybe(nextRoot))throw Error("Reviewed candidate already staged; never overwrite.");
      if(active&&!launch(["print",service],invoke))throw Error("Service state uncertain; refuse upgrade.");
      if(automaticOperation)await requireMacAutomatic(key,autoInstalled,autoTarget,freezeAgent);
    },active?()=>freezeAgent(key):null,automaticOperation?()=>automaticResult("waiting_idle"):null);
  }catch(error){
    // Only this attempt's private, unpublished copy is disposable.
    // The journal, installed versions and receipts are never removed here.
    if(action==="upgrade")await rm(stage,{recursive:true,force:true});
    if(automaticOperation&&error.code==="RCA_BUSY")return {status:"waiting_idle",version};
    throw error;
  }
  let oldStopped=false,newLoaded=false,cliWritten=false,plistWritten=false;
  let failureStage="publish-candidate",rollbackStage="begin";
  try{
    if(action==="upgrade"){
      await recheckBinding(record);
      // The owned journal and Freeze define the cutover admission boundary.
      if(automaticOperation){
        if(await freezeAgent(key,"verify-frozen")!=="ready")throw Error("Freeze unconfirmed.");
        if(await requireMacAutomatic(key,autoInstalled,autoTarget,freezeAgent)!==autoId)
          throw Error("Automatic update identity changed.");
      }
      if(await statMaybe(nextRoot))throw Error("Reviewed candidate already staged; never overwrite.");
      await rename(stage,nextRoot);
    }
    if(active){
      failureStage="stop-old-service";
      if(!launch(["bootout",service],invoke))throw Error("Old service bootout failed.");
      oldStopped=true;
      failureStage="wait-old-service-unregistered";
      await stopLaunchdForSwitch(service,invoke,pauseLaunchd,false);
    }
    failureStage="write-launchagent";
    await ownedWrite(plist,next,!!old,0o600,false);
    plistWritten=true;
    failureStage="write-endpoint";
    if(!stored)await ownedWrite(endpointFile,bound+"\n");
    if(!stopped){
      failureStage="launchagent-bootstrap";
      if(!launch(["bootstrap",domain,plist],invoke))
        throw Error("New LaunchAgent bootstrap failed.");
      newLoaded=true;
      failureStage="signed-wss-activation";
      if(!await online(identity,generation))throw Error("New signed WSS activation unconfirmed.");
      if(automaticOperation&&await freezeAgent(key,"verify-online")!=="ready")throw Error("New signed WSS not current.");
    }
    failureStage="write-cli";
    await ownedWrite(cli,ownerCliText(nextRoot),previousCli!==null,0o700,false);
    cliWritten=true;
    if(newStablePolicy){
      failureStage="automatic-update-consent";
      if(!await approved(key))throw Error("New device identity unconfirmed.");
      const deviceId=(await readFile(key+".device-id","utf8")).trim();
      if(!ID.test(deviceId))throw Error("New device identity unconfirmed.");
      // Exclusive creation preserves any explicit owner choice made during
      // initial activation, including a concurrent opt-out.
      const policyFile=key+".automatic-update";
      if(!await checked(policyFile,{optional:true,mode:0o600})){
        try{
          await writeFile(policyFile,JSON.stringify({device_id:deviceId,enabled:true}),
            {flag:"wx",mode:0o600,flush:true});
        }catch(error){if(error.code!=="EEXIST")throw error;}
      }
      if(await readMacAutoPolicy(key,deviceId)==="unknown")throw Error("Automatic update consent unconfirmed.");
    }
    failureStage="finalize-journal";
    if(automaticOperation)await automaticResult("success");
    await rm(journal);
    return {status:stopped?"stopped_preserved":"connected_observed",version,generation,
      cli};
  }catch(error){
    try{
      if(cliWritten){
        rollbackStage=previousCli!==null?"restore-local-cli":"remove-local-cli";
        if(previousCli!==null)await ownedWrite(cli,previousCli,true,0o700,false);
        else await rm(cli);
      }
      if(newLoaded){
        rollbackStage="stop-new-service";
        await stopLaunchdForSwitch(service,invoke,pauseLaunchd);
      }else if(oldStopped){
        // A failed bootstrap can still leave a registration asynchronously
        // arriving. Never overwrite the plist and bootstrap old over it.
        rollbackStage="inspect-new-service";
        const state=launchctlServiceState(service,invoke);
        if(state==="unknown")throw Error("Uncertain new-service registration.");
        rollbackStage="stop-new-service";
        await stopLaunchdForSwitch(service,invoke,pauseLaunchd,state==="present");
      }
      if(old&&plistWritten){
        rollbackStage="restore-previous-launchagent";
        await ownedWrite(plist,old,true,0o600,false);
      }else if(!old&&plistWritten){
        rollbackStage="check-new-launchagent";
        if(await checked(plist,{optional:true,mode:0o600})){
          rollbackStage="remove-new-launchagent";
          await rm(plist);
        }
      }
      if(oldStopped){
        rollbackStage="bootstrap-previous-launchagent";
        if(!launch(["bootstrap",domain,plist],invoke))
          throw Error("Old LaunchAgent bootstrap not confirmed.");
        rollbackStage="verify-previous-signed-wss";
        if(!await online(identity,current.generation))
          throw Error("Old signed service not restored.");
        if(automaticOperation&&await freezeAgent(key,"verify-online")!=="ready")throw Error("Old signed WSS not current.");
      }else if(frozen){
        rollbackStage="release-frozen-agent";
        if(await freezeAgent(key,"release")!=="released")
          throw Error("Freeze release unconfirmed.");
      }
      if(action==="upgrade")await rm(stage,{recursive:true,force:true});
      rollbackStage="remove-switch-journal";
      if(automaticOperation&&oldStopped)await automaticResult("failed_recovered");
      await rm(journal);
    }catch{
      throw Error(`UNKNOWN rollback at ${rollbackStage} after ${failureStage}: journal, key and receipts retained for manual inspection.`);
    }
    if(automaticOperation&&oldStopped)return {status:"failed_recovered",version};
    // Do not expose arbitrary OS exception text that may include sensitive paths.
    const reason=error instanceof Error&&error.message==="Unsafe owner, type or mode."
      ?"unsafe-owner-or-mode":"operation-failed";
    const recovery=old?"prior LaunchAgent restored where verified"
      :"new LaunchAgent configuration rolled back";
    throw Error((action==="install"?"Install":"Upgrade")+" blocked at "+failureStage+
      " ("+reason+"); "+recovery+". Identity, receipts and staged candidate retained.");
  }
}
const MAC_MENU=["status","pair","logs","update","uninstall","exit","recover","doctor","start","stop","restart"];
async function main(argv=process.argv.slice(2)){
  if(argv.length===0){
    if(!process.stdin.isTTY||!process.stdout.isTTY)
      throw Error("Interactive menu requires a local terminal; use status --json.");
    console.log("1. Status   2. Pair / repair   3. Logs\n4. Update   5. Uninstall   6. Exit\n7. Recover   8. Doctor\n9. Start   10. Stop   11. Restart");
    const reader=createInterface({input:process.stdin,output:process.stdout,terminal:false});
    const choice=await new Promise(resolve=>{
      reader.once("close",()=>resolve(""));
      reader.question("Choose an option: ",answer=>{resolve(answer.trim());reader.close();});
    });
    if(choice===""||choice==="6")return;
    if(!/^([1-9]|10|11)$/.test(choice)||!MAC_MENU[Number(choice)-1])throw Error("Invalid choice.");
    return main([MAC_MENU[Number(choice)-1]]);
  }
  let [action,...params]=argv,policyAction;
  if((action==="update"||action==="upgrade")&&params[0]==="--auto"&&
     (params.length===1||(params.length===2&&["on","off"].includes(params[1])))){
    policyAction=params[1];action="update-policy";params=[];
  }else if((action==="update"||action==="upgrade")&&params.length===1&&params[0]==="--check"){
    action="check-update";params=[];
  }else if((action==="update"||action==="upgrade")&&params.length===0){
    action="update-latest";
  }else if(action==="check-update"||action==="update-latest"||action==="update-policy")throw Error("Use update [--check].");
  if(action==="--help"&&params.length===0){
    console.log("Usage: rca [status [--json]|doctor [--json]|update [--check|--auto [on|off]]|logs|start|stop|restart|pair|recover|uninstall|--version|--help]");
    console.log("Use the reviewed macOS installer for first installation; update uses the installed package.");
    return;
  }
  if(action==="--version"&&params.length===0){
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
    await checked(root,{dir:true});
    const manifest=path.join(root,"bundle.json");
    await checked(manifest,{mode:0o600});
    const meta=JSON.parse(await readFile(manifest,"utf8"));
    if(path.basename(root)!==candidateName(meta,meta.source_commit))throw Error("Untrusted installed version.");
    console.log(meta.version);
    return;
  }
  if((action==="status"||action==="doctor")&&params.length===1&&params[0]==="--json")params.pop();
  if(["status","doctor","logs","pair","recover","stop","start","restart","uninstall"].includes(action)&&params.length)
    throw Error("Unexpected local action arguments.");
  const args={};
  for(let i=0;i<params.length;i+=2){
    if(!["--bundle","--source-sha","--endpoint","--expected-binding"].includes(params[i])||
      !params[i+1]||Object.hasOwn(args,params[i]))throw Error("Invalid local action parameters.");
    args[params[i]]=params[i+1];
  }
  const result=await localMacAction(action,{
    bundle:args["--bundle"],sourceSha:args["--source-sha"],endpoint:args["--endpoint"],
    expectedBinding:args["--expected-binding"],policyAction});
  if(action!=="update-latest")process.stdout.write(JSON.stringify(result)+"\n");
  if(action==="check-update"&&result.status==="unknown")process.exitCode=1;
}
// On macOS, $TMPDIR commonly starts with /var while Node's ESM loader
// canonicalizes it to /private/var. Compare canonical paths so a reviewed
// installer never exits 0 without invoking the owner action.
if(process.argv[1]&&realpathSync(process.argv[1])===
    realpathSync(fileURLToPath(import.meta.url))){
  try{await main();}catch(e){
    process.stderr.write("macOS local action blocked: "+
      (e instanceof Error?e.message:"unknown")+".\n");process.exitCode=1;
  }
}
