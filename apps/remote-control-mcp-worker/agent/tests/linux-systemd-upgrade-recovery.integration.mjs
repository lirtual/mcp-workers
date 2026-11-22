import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {createHash,generateKeyPairSync,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {ReceiptStore} from "../src/operations.ts";

const agentSource=process.env.RCA914_AGENT_SOURCE;
if(!agentSource)throw Error("RCA914_AGENT_SOURCE must point to the checked-out Agent source.");
const oldArchive=process.env.RCA914_OLD_ARCHIVE;
const rustArchive=process.env.RCA914_RUST_ARCHIVE;
if(!oldArchive||!rustArchive)throw Error("RCA914_OLD_ARCHIVE and RCA914_RUST_ARCHIVE are required.");
const {installUnit,recoverInterruptedUpgrade,renderV2Service,UNIT}=await import(
  pathToFileURL(path.join(agentSource,"scripts/install-v2.mjs")));

const home=process.env.HOME;
const runtime=process.env.XDG_RUNTIME_DIR;
if(process.getuid()===0||!home||!runtime||!process.env.DBUS_SESSION_BUS_ADDRESS)
  throw Error("Run this test under a disposable non-root user with a systemd user bus.");
const baseEnv={...process.env,HOME:home,XDG_RUNTIME_DIR:runtime,
  DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS,PATH:"/usr/local/bin:/usr/bin:/bin"};
const base=path.join(home,".local/share/mcp-workers/remote-control");
const keyPath=path.join(base,"v2-identity.pem");
const endpoint="https://127.0.0.1:1/";
const key=path.join(base,"v2-identity.pem");
const id=key+".device-id";
const receipts=path.join(home,".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite");
const unitPath=path.join(home,".config/systemd/user",UNIT);
const oldRoot=path.join(base,"programs/v0.1.56-linux-x64-glibc");
const rustRoot=path.join(base,"programs/v0.1.57-rust-candidate.1-linux-x64-glibc");
const rustExe=path.join(rustRoot,"apps/remote-control-agent/.build/rca-standard-linux-candidate");
const backupPath=unitPath+".upgrade-backup";
const work=path.join(home,".cache/spec914-recovery");
for(const pathToReset of [base,path.dirname(receipts),path.dirname(unitPath),work])
  rmSync(pathToReset,{recursive:true,force:true});
mkdirSync(path.dirname(unitPath),{recursive:true,mode:0o700});
mkdirSync(oldRoot,{recursive:true,mode:0o700});
mkdirSync(rustRoot,{recursive:true,mode:0o700});
for(const [archive,destination] of [[oldArchive,oldRoot],[rustArchive,rustRoot]]) {
  const unpack=spawnSync("/usr/bin/tar",["-xzf",archive,"-C",destination],{encoding:"utf8"});
  if(unpack.error||unpack.status!==0)throw new Error("Unable to unpack test package: "+(unpack.stderr||unpack.error));
}
const identity=generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"});
mkdirSync(base,{recursive:true,mode:0o700});
writeFileSync(key,identity,{mode:0o600});
writeFileSync(id,randomUUID()+"\n",{mode:0o600});
const store=new ReceiptStore(path.dirname(receipts));
await store.open();
await store.admit("914-completed","read_file","a".repeat(64));
await store.update("914-completed","completed","completed before upgrade",undefined,true);
await store.admit("914-unknown","read_file","b".repeat(64));
await store.update("914-unknown","unknown","uncertain before upgrade");
await store.close();
const wrappers=path.join(work,"bin");
const marker=path.join(work,"restart-reached");
const release=path.join(work,"release-restart");
mkdirSync(wrappers,{recursive:true,mode:0o700});
chmodSync(work,0o700); chmodSync(wrappers,0o700);
rmSync(marker,{force:true}); rmSync(release,{force:true});
const keyBefore=readFileSync(key);
const idBefore=readFileSync(id);
const dbBefore=readFileSync(receipts);
const keyDigest=createHash("sha256").update(keyBefore).digest("hex");
const beforeDb=new DatabaseSync(receipts,{readOnly:true});
const statesBefore=beforeDb.prepare("SELECT operation_id,state,guarded FROM receipts ORDER BY operation_id").all().map(x=>({...x}));
assert.equal(beforeDb.prepare("PRAGMA quick_check").get().quick_check,"ok");
beforeDb.close();
assert.deepEqual(statesBefore,[
  {operation_id:"914-completed",state:"completed",guarded:0},
  {operation_id:"914-unknown",state:"unknown",guarded:1},
]);

const oldUnit=renderV2Service({node:path.join(oldRoot,"bin/node"),home,repoRoot:oldRoot,
  keyPath,endpoint,entryExt:"js"});
await installUnit(unitPath,oldUnit);
const wrapper=path.join(wrappers,"systemctl");
writeFileSync(wrapper,[
  "#!/bin/bash",
  'if [[ "$#" -eq 3 && "$1" == "--user" && "$2" == "restart" && "$3" == "'+UNIT+'" ]]; then',
  '  /usr/bin/systemctl "$@" || exit $?',
  '  : > "$SPEC914_RESTART_MARKER"',
  '  chmod 600 "$SPEC914_RESTART_MARKER"',
  '  while [[ ! -e "$SPEC914_RELEASE_RESTART" ]]; do /usr/bin/sleep 0.05; done',
  '  exit 0',
  'fi',
  'exec /usr/bin/systemctl "$@"',
].join("\n")+"\n",{mode:0o700});
chmodSync(wrapper,0o700);
const driver=path.join(work,"installer.mjs");
writeFileSync(driver,[
  'import path from "node:path";',
  'import {pathToFileURL} from "node:url";',
  'const home=process.env.HOME;',
  'const rustRoot=path.join(home,".local/share/mcp-workers/remote-control/programs/v0.1.57-rust-candidate.1-linux-x64-glibc");',
  'const {runInstaller}=await import(pathToFileURL(path.join(rustRoot,"apps/remote-control-agent/scripts/install-v2.mjs")));',
  'await runInstaller(["--upgrade","--endpoint","https://127.0.0.1:1/"],{home,stdin:{isTTY:true},stdout:{isTTY:true,write(){}}});',
].join("\n")+"\n",{mode:0o600});
const systemctl=(args)=>{
  const p=spawnSync("/usr/bin/systemctl",["--user",...args],{env:baseEnv,encoding:"utf8",timeout:10000});
  if(p.error||p.status!==0) throw new Error("systemctl failed: "+args.join(" "));
  return p.stdout.trim();
};
let installer;
let installerOutput="";
try {
  installer=spawn(path.join(rustRoot,"bin/node"),[driver],{env:{...baseEnv,PATH:wrappers+":"+baseEnv.PATH,SPEC914_RESTART_MARKER:marker,SPEC914_RELEASE_RESTART:release},detached:true,stdio:["ignore","pipe","pipe"]});
  installer.stdout.setEncoding("utf8").on("data",chunk=>installerOutput+=chunk);
  installer.stderr.setEncoding("utf8").on("data",chunk=>installerOutput+=chunk);
  const deadline=Date.now()+30000;
  while(Date.now()<deadline&&!existsSync(marker)&&installer.exitCode===null) await new Promise(r=>setTimeout(r,50));
  assert.ok(existsSync(marker),"installer reached post-restart interruption point; exit="+installer.exitCode+" output="+installerOutput.slice(-2000));
  systemctl(["is-active",UNIT]);
  const rustPid=Number(systemctl(["show","-p","MainPID","--value",UNIT]));
  assert.equal(readFileSync("/proc/"+rustPid+"/cmdline").toString().split("\0")[0],rustExe,"Rust candidate is the live systemd MainPID");
  assert.ok(existsSync(backupPath),"durable previous Node unit backup exists");
  assert.ok(readFileSync(unitPath,"utf8").includes(rustExe),"candidate unit was activated before interruption");
  process.kill(-installer.pid,"SIGKILL");
  if(installer.exitCode===null)await new Promise(resolve=>installer.once("exit",resolve));
  installer=null;
  assert.ok(!existsSync(release),"blocked systemctl wrapper never resumed");
  assert.equal(await recoverInterruptedUpgrade({home,unitPath}),true,"interrupted transaction recovered");
  systemctl(["is-active",UNIT]);
  const nodePid=Number(systemctl(["show","-p","MainPID","--value",UNIT]));
  assert.equal(readFileSync("/proc/"+nodePid+"/cmdline").toString().split("\0")[0],path.join(oldRoot,"bin/node"),"old published Node Agent owns the recovered service");
  assert.ok(nodePid!==rustPid,"candidate process was replaced");
  assert.ok(!existsSync(backupPath),"recovery backup removed only after successful old service restart");
  assert.deepEqual(readFileSync(key),keyBefore);
  assert.deepEqual(readFileSync(id),idBefore);
  assert.equal(createHash("sha256").update(readFileSync(key)).digest("hex"),keyDigest);
  assert.deepEqual(readFileSync(receipts),dbBefore,"SQLite bytes preserved through candidate activation and recovery");
  const dbAfter=new DatabaseSync(receipts,{readOnly:true});
  const statesAfter=dbAfter.prepare("SELECT operation_id,state,guarded FROM receipts ORDER BY operation_id").all().map(x=>({...x}));
  assert.equal(dbAfter.prepare("PRAGMA quick_check").get().quick_check,"ok");
  dbAfter.close();
  assert.deepEqual(statesAfter,statesBefore);
  console.log(JSON.stringify({real_systemd:true,node_to_rust_activation:true,installer_sigkill:true,recovered_node:true,identity_preserved:true,receipt_rows_preserved:statesAfter.length,receipt_quick_check:"ok"}));
} finally {
  if(installer) {
    if(installer.exitCode===null) {
      try{process.kill(-installer.pid,"SIGKILL");}catch{}
      if(installer.exitCode===null)await new Promise(resolve=>installer.once("exit",resolve)).catch(()=>{});
    }
  }
  if(existsSync(backupPath))await recoverInterruptedUpgrade({home,unitPath});
  if(existsSync(unitPath)){
    spawnSync("/usr/bin/systemctl",["--user","disable","--now",UNIT],{env:baseEnv,stdio:"ignore",timeout:10000});
    rmSync(unitPath,{force:true}); rmSync(backupPath,{force:true});
    spawnSync("/usr/bin/systemctl",["--user","daemon-reload"],{env:baseEnv,stdio:"ignore",timeout:10000});
  }
}
