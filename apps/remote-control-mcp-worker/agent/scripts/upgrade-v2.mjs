/**
 * Reviewed manual upgrade orchestration for the owner-local Node manager.
 * Does not silently discover latest, change Worker, or mutate identity.
 * The actual systemd cut-over and rollback remain in install-v2.mjs.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolvePinnedRelease, downloadPinnedAsset, downloadSelectedReleaseAsset, resolveLatestAgentRelease,
} from "./verify-v2-release.mjs";
import { inspectPinnedArchiveBytes, stageOrVerifyPinnedProgram }
  from "./bootstrap-node.mjs";

const SHA=/^[a-f0-9]{40}$/;
const VERSION=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const APP="apps/remote-control-agent";

/** Keep the bound Worker endpoint as an ownership check; fetch GitHub
 * Latest directly from this device's bundled Node, once per owner upgrade. */
export async function resolveWorkerUpgradePin(endpoint,{request=fetch}={}){
  const origin=new URL(endpoint);
  if(origin.protocol!=="https:"||origin.username||origin.password||
     origin.port||origin.search||origin.hash||origin.pathname!=="/"||
     origin.origin+"/"!==endpoint)throw Error("Untrusted installed Worker endpoint");
  return resolveLatestAgentRelease({send:request});
}

function normalizeUpgradePins(state,pins){
  if(pins&&pins.commit===undefined&&pins.url===undefined&&pins.x64&&pins.arm64){
    const chosen=state?.info?.target==="linux-arm64-glibc"?pins.arm64:
      state?.info?.target==="linux-x64-glibc"?pins.x64:null;
    if(!chosen)throw Error("Unsupported upgrade architecture");
    return {home:pins.home,tag:pins.tag,url:chosen.url,sha256:chosen.sha256,size:chosen.size};
  }
  return pins??{};
}

function ownedFile(p,mode){
  const st=lstatSync(p);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||
     (st.mode&0o777)!==mode||st.nlink!==1)
    throw Error("Untrusted staged Agent executable");
  return p;
}
function sameOrOlder(candidate,current){
  const a=VERSION.exec(candidate),b=VERSION.exec(current);
  if(!a||!b)throw Error("Upgrade requires stable pinned semantic versions");
  for(let i=1;i<4;i++){
    const next=BigInt(a[i]),old=BigInt(b[i]);
    if(next!==old)return next<old;
  }
  return true;
}
function serviceEndpoint(unit){
  if(!unit)throw Error("Upgrade requires an installer-owned permanent service");
  const values=unit.split("\n")
    .filter(x=>x.startsWith("Environment=REMOTE_CONTROL_AGENT_ENDPOINT="));
  if(values.length!==1)throw Error("Missing or ambiguous approved Worker origin");
  const endpoint=values[0].slice("Environment=REMOTE_CONTROL_AGENT_ENDPOINT=".length);
  const url=new URL(endpoint);
  if(url.protocol!=="https:"||url.username||url.password||url.search||
     url.hash||url.pathname!=="/"||url.port||
     endpoint!==url.origin+"/")throw Error("Untrusted installed Worker endpoint");
  return endpoint;
}
function selectedAssetUrl(url,tag,target){
  const name="remote-control-agent-"+tag+"-"+target+".tar.gz";
  let parsed;
  try{parsed=new URL(url);}catch{return false;}
  return parsed.protocol==="https:"&&parsed.hostname==="github.com"&&!parsed.port&&
    !parsed.username&&!parsed.password&&!parsed.search&&!parsed.hash&&
    parsed.pathname==="/lirtual/mcp-workers/releases/download/"+tag+"/"+name;
}
export function validateManualUpgrade(state,input){
  const pins=normalizeUpgradePins(state,input);
  const {home=os.homedir(),tag,commit,url,sha256,size}=pins;
  if(process.getuid()===0||!VERSION.test(tag))
    throw Error("Manual upgrade requires a stable reviewed release");
  let asset=null;
  if(commit===undefined){
    if(!selectedAssetUrl(url,tag,state?.info?.target)||!/^[a-f0-9]{64}$/.test(sha256||"")||
       !Number.isSafeInteger(size)||size<1024||size>180_000_000)
      throw Error("Manual upgrade requires the selected Release asset");
    asset=Object.freeze({url,bytes:size,digest:sha256});
  }else if(!SHA.test(commit))
    throw Error("Manual upgrade requires reviewed tag and commit");
  if(!state?.unit||!state?.root||!state?.info||!state?.ids?.permanent)
    throw Error("Only an approved permanent installation can upgrade");
  if(sameOrOlder(tag,state.info.version))
    throw Error("Silent downgrade, prerelease, or same-version upgrade refused");
  const target=state.info.target;
  if(!["linux-x64-glibc","linux-arm64-glibc"].includes(target))
    throw Error("Unsupported upgrade architecture");
  if((target==="linux-x64-glibc"&&process.arch!=="x64")||
     (target==="linux-arm64-glibc"&&process.arch!=="arm64")||
     process.platform!=="linux")throw Error("Host CPU does not match Agent archive");
  const programs=path.join(home,".local/share/mcp-workers/remote-control/programs");
  if(path.dirname(state.root)!==programs||
    path.basename(state.root)!==state.info.version+"-"+target)
    throw Error("Untrusted currently managed program directory");
  const old=path.join(state.root,APP,"src/v2-main.js");
  ownedFile(old,0o600);
  const text=readFileSync(old,"utf8");
  // Full-tools predecessors are accepted for staging only. The installer
  // requires a fresh authoritative in-process freeze before any unit switch.
  if(!/readOnly:\s*true,\s*writeFile:\s*false,\s*shell:\s*false,/.test(text) &&
     !(/V2_RUNTIME_PROFILE\s*=\s*"paired-full-v1"/.test(text) &&
       !/(?:readOnly|writeFile|shell)\s*:/.test(text)))
    throw Error("Unverified current Agent may have mutable or Shell sessions");
  // The old unit is already owned and path-checked by manager inventory.
  const endpoint=serviceEndpoint(state.unit);
  const targetDir=path.join(programs,tag+"-"+target);
  return Object.freeze({tag,commit,target,programs,targetDir,endpoint,oldRoot:state.root,asset});
}
/**
 * Network fetch remains bounded to reviewed immutable GitHub origins by
 * existing verifier; the SHA is additionally checked by the native stage.
 * On error this function does not change unit, identity, or owner receipts.
 */
export async function prepareManualUpgrade(state,pins,{
  home=os.homedir(),
  resolve=resolvePinnedRelease,
  download=downloadPinnedAsset,
  downloadAsset=downloadSelectedReleaseAsset,
  stage=stageOrVerifyPinnedProgram,
}={}){
  const approved=validateManualUpgrade(state,{home,...pins});
  let bytes;
  let digest;
  if(approved.asset){
    bytes=await downloadAsset(approved.asset);
    if(!Buffer.isBuffer(bytes)||bytes.length!==approved.asset.bytes)
      throw Error("Incomplete or unexpected asset length.");
    digest=approved.asset.digest;
  }else{
    const release=await resolve({tag:approved.tag,commit:approved.commit,target:approved.target});
    if(release.tag!==approved.tag||release.commit!==approved.commit||
       release.target!==approved.target||!/^[a-f0-9]{64}$/.test(release.digest))
      throw Error("Release pin mismatch");
    bytes=await download(release);
    digest=release.digest;
  }
  const expected={tag:approved.tag,target:approved.target,expectedSha256:digest};
  inspectPinnedArchiveBytes(bytes,expected);
  const program=stage(bytes,expected,approved.programs,path.basename(approved.targetDir));
  if(program!==approved.targetDir)throw Error("Unexpected staged version directory");
  const runner=ownedFile(path.join(program,"bin/node"),0o700);
  const script=ownedFile(path.join(program,APP,"scripts/install-v2.mjs"),0o600);
  // Only an immutable paired-full target may replace a proven read-only
  // Agent. The currently installed runtime is verified separately above.
  const main=ownedFile(path.join(program,APP,"src/v2-main.js"),0o600);
  const manifest=ownedFile(path.join(program,"bundle.json"),0o600);
  const info=JSON.parse(readFileSync(manifest,"utf8"));
  const entry=readFileSync(main,"utf8");
  if(info.upgrade_profile!=="paired-full-v1" ||
     !/V2_RUNTIME_PROFILE\s*=\s*"paired-full-v1"/.test(entry) ||
     /(?:readOnly|writeFile|shell)\s*:/.test(entry))
    throw Error("Unproven paired full-tools upgrade target");
  return Object.freeze({...approved,program,runner,script});
}
export function activateManualUpgrade(prepared,{
  invoke=spawnSync,env=process.env,
}={}){
  const result=invoke(prepared.runner,[prepared.script,"--upgrade",
    "--endpoint",prepared.endpoint],{
    stdio:"inherit",env:{...env,RC_AGENT_NO_POST_START:"1"},
  });
  if(result.error||result.signal||result.status!==0)
    throw Error("Reviewed Agent upgrade failed; inspect local rollback and service");
  return {version:prepared.tag,program:prepared.program,endpoint:prepared.endpoint};
}
