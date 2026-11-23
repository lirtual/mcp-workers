// Real systemd safety seam for unshipped Node-free Linux upgrade (no Worker grants).
// Runs only as a disposable user created by agent-native-candidates.yml.
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {chmodSync,existsSync,mkdirSync,readFileSync,readlinkSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {ReceiptStore} from "../src/operations.ts";

const source=process.env.RCA914_AGENT_SOURCE;
const oldArchive=process.env.RCA914_OLD_ARCHIVE;
const nativeArchive=process.env.RCA914_NATIVE_ARCHIVE;
if(!source||!oldArchive||!nativeArchive)throw Error("Missing isolated native systemd fixture paths");
if(process.getuid()===0||!process.env.DBUS_SESSION_BUS_ADDRESS||!process.env.XDG_RUNTIME_DIR)
  throw Error("Disposable unprivileged systemd user bus is required");

const {installUnit,renderV2Service,UNIT}=await import(
  pathToFileURL(path.join(source,"scripts/install-v2.mjs")));
const home=process.env.HOME;
const target=process.arch==="arm64"?"linux-arm64-glibc":"linux-x64-glibc";
const base=path.join(home,".local/share/mcp-workers/remote-control");
const key=path.join(base,"v2-identity.pem");
const deviceId=key+".device-id";
const oldRoot=path.join(base,"programs/v0.1.56-"+target);
const nativeRoot=path.join(base,"programs/v0.1.57-rust-candidate.1-"+target);
const rustExe=path.join(nativeRoot,"apps/remote-control-agent/.build/rca-standard-linux-candidate");
const nodeExe=path.join(oldRoot,"bin/node");
const unitFile=path.join(home,".config/systemd/user",UNIT);
const backupFile=unitFile+".upgrade-backup";
const cli=path.join(home,".local/bin/rca");
const receipts=path.join(home,".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite");
const endpoint="https://127.0.0.1:1/";
const env={...process.env,PATH:"/usr/local/bin:/usr/bin:/bin"};

function systemctl(...args) {
  const result=spawnSync("/usr/bin/systemctl",["--user",...args],{
    env,encoding:"utf8",timeout:15000
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
  return result.stdout.trim();
}
function liveExecutable() {
  const pid=Number(systemctl("show","-p","MainPID","--value",UNIT));
  assert.ok(pid>0,"systemd MainPID must be known");
  const first=readFileSync("/proc/"+pid+"/cmdline").toString().split("\0")[0];
  assert.ok(first,"systemd MainPID must have an executable");
  return first;
}
for(const dir of [base,path.dirname(unitFile),path.dirname(receipts),path.dirname(cli)])
  rmSync(dir,{recursive:true,force:true});
mkdirSync(oldRoot,{recursive:true,mode:0o700});
mkdirSync(nativeRoot,{recursive:true,mode:0o700});
for(const [archive,destination] of [[oldArchive,oldRoot],[nativeArchive,nativeRoot]]){
  const result=spawnSync("/usr/bin/tar",["-xzf",archive,"-C",destination],{
    encoding:"utf8",timeout:12000
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
}
mkdirSync(base,{recursive:true,mode:0o700});
const privateKey=generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"});
const id=randomUUID();
writeFileSync(key,privateKey,{mode:0o600});
writeFileSync(deviceId,id+"\n",{mode:0o600});
mkdirSync(path.dirname(unitFile),{recursive:true,mode:0o700});
mkdirSync(path.dirname(cli),{recursive:true,mode:0o700});
const receiptsStore=new ReceiptStore(path.dirname(receipts));
await receiptsStore.open();
await receiptsStore.admit("914-prior-unknown","read_file","a".repeat(64));
await receiptsStore.update("914-prior-unknown","unknown","unresolved before cutover");
await receiptsStore.close();

const oldUnit=renderV2Service({node:nodeExe,home,repoRoot:oldRoot,
  keyPath:key,endpoint,entryExt:"js"});
let installed=false;
try {
  await installUnit(unitFile,oldUnit);
  installed=true;
  symlinkSync(path.join(oldRoot,"apps/remote-control-agent/scripts/rca.sh"),cli);
  assert.equal(liveExecutable(),nodeExe,"real published Node is active before handoff");

  // Run the reviewed switch against actual systemd, with a deliberately
  // missing signed Worker WSS proof. This must restore the ORIGINAL Node.
  // It is not a simulation of successful authenticated upgrade.
  const code=[
    "import importlib.util,pathlib,sys",
    "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
    "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
    "try:",
    " b.native_cutover(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),sys.argv[4],verify=lambda *args:False)",
    "except ValueError as error:",
    " print(str(error));sys.exit(9)",
    "raise AssertionError('Upgrade missing proof was accepted')"
  ].join("\n");
  const run=spawnSync("/usr/bin/python3",["-I","-B","-c",code,
    path.join(source,"scripts/bootstrap-v2.py"),home,nativeRoot,endpoint],{
    env,encoding:"utf8",timeout:30000
  });
  assert.equal(run.status,9,run.stdout+"\n"+run.stderr);
  assert.match(run.stdout,/rolled back/);
  assert.equal(liveExecutable(),nodeExe,"rollback MUST restore real Node service");
  assert.equal(readFileSync(unitFile,"utf8"),oldUnit,"original managed unit restored");
  assert.equal(readlinkSync(cli),path.join(oldRoot,"apps/remote-control-agent/scripts/rca.sh"));
  assert.equal(readFileSync(key,"utf8"),privateKey);
  assert.equal(readFileSync(deviceId,"utf8"),id+"\n");
  assert.ok(!existsSync(backupFile),"resolved rollback must clear only old backup");
  assert.ok(!existsSync(key+".native-upgrade-intent"),"old attempt intent retired");
  assert.ok(!existsSync(key+".native-upgrade-proof"),"no unauthenticated proof");
  systemctl("stop",UNIT);
  const db=new DatabaseSync(receipts,{readOnly:true});
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");
  const state=db.prepare(
    "SELECT state FROM receipts WHERE operation_id='914-prior-unknown'"
  ).get();
  assert.equal(state.state,"unknown","previous uncertain effect cannot be replayed");
  db.close();

  // Crash after the actual Node -> Rust systemd switch, before signed WSS
  // acceptance. Killing the Python owner cannot make an unverified upgrade
  // disappear: the original unit, old launcher, identity and Unknown remain.
  systemctl("start",UNIT);
  assert.equal(liveExecutable(),nodeExe);
  const socketDeadline=Date.now()+10000;
  const upgradeSocket=path.join(base,"upgrade.sock");
  while(!existsSync(upgradeSocket)&&Date.now()<socketDeadline)
    await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(existsSync(upgradeSocket),"old Node upgrade consent socket was not ready");
  const marker=path.join(base,"native-upgrade-crash-marker");
  const script=[
    "import importlib.util,pathlib,sys,time,os",
    "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
    "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
    "original=b.native_systemctl",
    "def intercepted(*args):",
    " result=original(*args)",
    " if args==('restart',b.UNIT):",
    "  marker=pathlib.Path(sys.argv[5])",
    "  marker.write_text('switched')",
    "  marker.chmod(0o600)",
    "  while True:time.sleep(0.1)",
    " return result",
    "b.native_systemctl=intercepted",
    "b.native_cutover(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),sys.argv[4])",
  ].join("\n");
  const child=spawn("/usr/bin/python3",["-I","-B","-c",script,
    path.join(source,"scripts/bootstrap-v2.py"),home,nativeRoot,endpoint,marker],{
    env,stdio:["ignore","pipe","pipe"]});
  let childOutput="";
  child.stderr.on("data",chunk=>{childOutput+=chunk.toString()});
  try {
    const deadline=Date.now()+30000;
    while(!existsSync(marker)&&Date.now()<deadline&&child.exitCode===null&&
          child.signalCode===null)
      await new Promise(resolve=>setTimeout(resolve,40));
    assert.ok(existsSync(marker),"upgrader never reached live native switch: "+childOutput);
    assert.equal(liveExecutable(),rustExe,"real native Rust process was not active");
    assert.equal(readFileSync(backupFile,"utf8"),oldUnit,
      "original Node service backup lost before commit");
    assert.ok(existsSync(key+".native-upgrade-intent"),
      "durable attempt identity missing after Rust activation");
    assert.equal(readlinkSync(cli),path.join(oldRoot,
      "apps/remote-control-agent/scripts/rca.sh"),
      "unverified native switch must not move the installed CLI");
    child.kill("SIGKILL");
    await new Promise(resolve=>child.once("exit",resolve));
    assert.equal(child.signalCode,"SIGKILL","owner upgrader must be interrupted");
    assert.equal(liveExecutable(),rustExe,"SIGKILL should not erase native systemd state");
    assert.equal(readFileSync(backupFile,"utf8"),oldUnit);
    assert.ok(existsSync(key+".native-upgrade-intent"));
    assert.equal(readFileSync(key,"utf8"),privateKey);
    assert.equal(readFileSync(deviceId,"utf8"),id+"\n");
    const blocked=[
      "import importlib.util,sys",
      "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
      "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
      "try:b.local_uninstall(sys.argv[2],True,systemctl=lambda *a:None,process_check=lambda *a:True)",
      "except ValueError as e:",
      " assert 'Unreconciled native upgrade' in str(e),str(e)",
      " sys.exit(0)",
      "raise AssertionError('pending upgrade was uninstalled')",
    ].join("\n");
    const refusal=spawnSync("/usr/bin/python3",["-I","-B","-c",blocked,
      path.join(source,"scripts/bootstrap-v2.py"),home],{env,encoding:"utf8",timeout:8000});
    assert.equal(refusal.status,0,refusal.stderr);
    // The published Node v0.1.56 recovery script cannot validate a native
    // unit. The reviewed Python bootstrap, already in the native package,
    // performs attended rollback using the original immutable unit backup.
    const recoverCode=[
      "import importlib.util,json,pathlib,sys",
      "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
      "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
      "print(json.dumps(b.native_recover(pathlib.Path(sys.argv[2]))))",
    ].join("\n");
    const recovery=spawnSync("/usr/bin/python3",["-I","-B","-c",recoverCode,
      path.join(source,"scripts/bootstrap-v2.py"),home],{
      env,encoding:"utf8",timeout:30000});
    assert.equal(recovery.status,0,recovery.stdout+"\n"+recovery.stderr);
    const outcome=JSON.parse(recovery.stdout);
    assert.equal(outcome.status,"previous_service_restored");
    assert.equal(outcome.signed_wss,"unconfirmed");
    assert.equal(liveExecutable(),nodeExe,"original Node must be restored");
    assert.equal(readFileSync(unitFile,"utf8"),oldUnit);
    assert.equal(readlinkSync(cli),path.join(oldRoot,
      "apps/remote-control-agent/scripts/rca.sh"));
    assert.ok(!existsSync(backupFile));
    assert.ok(!existsSync(key+".native-upgrade-intent"));
    assert.equal(readFileSync(key,"utf8"),privateKey);
    assert.equal(readFileSync(deviceId,"utf8"),id+"\n");
    systemctl("stop",UNIT);
    const intact=new DatabaseSync(receipts,{readOnly:true});
    assert.equal(intact.prepare("PRAGMA quick_check").get().quick_check,"ok");
    assert.equal(intact.prepare(
      "SELECT state FROM receipts WHERE operation_id='914-prior-unknown'").get().state,
      "unknown");
    intact.close();
  } finally {
    if(child.exitCode===null&&child.signalCode===null) {
      child.kill("SIGKILL");
      await new Promise(resolve=>child.once("exit",resolve));
    }
  }
  console.log(JSON.stringify({
    real_systemd:true,real_published_node_baseline:true,
    native_executable_activated_then_rejected_without_wss:true,
    rollback_node_active_verified:true,identity_preserved:true,
    unknown_receipt_preserved:true,
    native_upgrader_sigkill_recovery_evidence_preserved:true,
    pending_upgrade_uninstall_refused:true,
    verified_native_recovery_restored_published_node:true
  }));
} finally {
  if(installed){
    spawnSync("/usr/bin/systemctl",["--user","disable","--now",UNIT],{
      env,stdio:"ignore",timeout:15000
    });
    rmSync(unitFile,{force:true});
    spawnSync("/usr/bin/systemctl",["--user","daemon-reload"],{
      env,stdio:"ignore",timeout:15000
    });
  }
}
