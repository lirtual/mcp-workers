// Real systemd safety seam for native Rust upgrade (no Worker grants).
// Runs only on disposable CI accounts, including the isolated Legacy Root HOME fixture.
import assert from "node:assert/strict";
import {spawn,spawnSync} from "node:child_process";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,readlinkSync,rmSync,statSync,symlinkSync,writeFileSync} from "node:fs";
import path from "node:path";
import {seedUnknownReceipt} from "./fixtures/receipt-ledger.ts";

const source=process.env.RCA_TEST_AGENT_SOURCE;
const oldArchive=process.env.RCA_TEST_OLD_ARCHIVE;
const nativeArchive=process.env.RCA_TEST_NATIVE_ARCHIVE;
if(!source||!oldArchive||!nativeArchive)throw Error("Missing isolated native systemd fixture paths");
const rootFixture=process.env.RCA_TEST_ROOT_HOME_0550==="1";
if(!process.env.DBUS_SESSION_BUS_ADDRESS||!process.env.XDG_RUNTIME_DIR||
    (process.getuid()===0)!==rootFixture)
  throw Error("Disposable systemd user bus and matching fixture identity required");
if(rootFixture&&(process.env.GITHUB_ACTIONS!=="true"||
    process.env.RUNNER_ENVIRONMENT!=="github-hosted"||
    process.env.HOME!=="/root"||
    (statSync("/root").mode&0o777)!==0o550))
  throw Error("Root fixture requires a disposable hosted runner with HOME 0550");
if(rootFixture)process.umask(0o077);

const UNIT="remote-control-agent.service";
const home=process.env.HOME;
const target=rootFixture?"linux-x64-legacy-glibc":process.arch==="arm64"?"linux-arm64-glibc":"linux-x64-glibc";
const base=path.join(home,".local/share/mcp-workers/remote-control");
const key=path.join(base,"v2-identity.pem");
const deviceId=key+".device-id";
// The caller supplies independently reviewed version labels, not values inferred
// from the archives under test. Reuse this real systemd seam for Stable-to-Stable
// upgrades as well as unpublished builds.
const oldVersion=process.env.RCA_TEST_BASELINE_VERSION;
const nextVersion=process.env.RCA_TEST_TARGET_VERSION;
assert.match(oldVersion,/^v\d+\.\d+\.\d+$/);
assert.match(nextVersion,/^v\d+\.\d+\.\d+$/);
assert.notEqual(oldVersion,nextVersion);
const oldRoot=path.join(base,"programs",oldVersion+"-"+target);
const nativeRoot=path.join(base,"programs",nextVersion+"-"+target);
const rustExe=path.join(nativeRoot,"apps/remote-control-agent/.build/rca-standard-linux-candidate");
const priorExe=path.join(oldRoot,"apps/remote-control-agent/.build/rca-standard-linux-candidate");
const unitFile=path.join(home,".config/systemd/user",UNIT);
const backupFile=unitFile+".upgrade-backup";
const cli=path.join(home,".local/bin/rca");
const receipts=path.join(home,".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite");
const endpoint="https://127.0.0.1:1/";
const env={...process.env,PATH:"/usr/local/bin:/usr/bin:/bin"};

// Demonstrate the accepted HOME visibility and the retained RCA isolation
// under the same real DAC identity, without reading or changing owner data.
function assertRootResourceIsolation(stage, paths) {
  if(!rootFixture)return;
  for(const item of paths)assert.ok(lstatSync(item),"missing protected fixture resource: "+item);
  const probe=[
    "import os,sys",
    "assert os.getuid()==os.geteuid()==65534 and os.getgid()==os.getegid()==0 and not os.getgroups()",
    "assert int(next(line.split()[1] for line in open('/proc/self/status') if line.startswith('CapEff:')),16)==0",
    "assert '.local' in os.listdir('/root'), 'same-group HOME visibility not exercised'",
    "assert not os.access('/root',os.W_OK), 'outsider can write HOME'",
    "for path in sys.argv[1:]:",
    " assert not os.access(path,os.R_OK), 'outsider can read: '+path",
    " assert not os.access(path,os.W_OK), 'outsider can write: '+path",
    " assert not os.access(path,os.X_OK), 'outsider can execute: '+path",
    " assert not os.access(os.path.dirname(path),os.W_OK), 'outsider can replace: '+path",
  ].join("\n");
  const result=spawnSync("/usr/bin/setpriv",["--reuid=65534","--regid=0","--clear-groups",
    "--no-new-privs","/usr/bin/python3","-I","-B","-c",probe,...paths],{
    env,encoding:"utf8",timeout:5000
  });
  assert.equal(result.status,0,result.stdout+"\n"+result.stderr);
  console.log("ROOT_HOME_0550_RESOURCE_ISOLATION_PASS "+stage);
}
function systemctl(...args) {
  const result=spawnSync("/usr/bin/systemctl",["--user",...args],{
    env,encoding:"utf8",timeout:15000
  });
  assert.equal(result.status,0,result.stderr||String(result.error));
  return result.stdout.trim();
}
function liveExecutable(expected) {
  // Reuse the production readiness contract: ActiveState/SubState, stable
  // MainPID and /proc/PID/exe. cmdline argv[0] is mutable argument data, not
  // the kernel's executable identity.
  const code=[
    "import importlib.util,pathlib,sys",
    "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
    "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
    "expected=pathlib.Path(sys.argv[2]).resolve(strict=True)",
    "pid=b.native_wait_started(expected)",
    "executable=b.native_process_executable(pid)",
    "assert b.native_main_pid()==pid,'systemd MainPID changed after executable verification'",
    "print(executable,end='')",
  ].join("\n");
  const result=spawnSync("/usr/bin/python3",["-I","-B","-c",code,
    path.join(source,"scripts/bootstrap-v2.py"),expected],{
    env,encoding:"utf8",timeout:10000
  });
  assert.equal(result.status,0,result.stdout+"\n"+result.stderr);
  return result.stdout.trim();
}
if(rootFixture){
  // Never remove pre-existing Root resources to make the fixture pass.
  for(const item of [base,path.dirname(receipts),unitFile,backupFile,unitFile+".d",cli])
    assert.equal(lstatSync(item,{throwIfNoEntry:false}),undefined,"Root fixture requires absent RCA resources: "+item);
}else{
  for(const dir of [base,path.dirname(unitFile),path.dirname(receipts),path.dirname(cli)])
    rmSync(dir,{recursive:true,force:true});
  mkdirSync(oldRoot,{recursive:true,mode:0o700});
  mkdirSync(nativeRoot,{recursive:true,mode:0o700});
}
for(const [archive,destination] of [[oldArchive,oldRoot],[nativeArchive,nativeRoot]]){
  const tag=destination===oldRoot?oldVersion:nextVersion;
  const result=rootFixture
    ?spawnSync("/usr/bin/python3",["-I","-B","-c",[
      "import importlib.util,pathlib,sys",
      "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
      "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
      "home=b.root_account_home(); programs=b.program_home(home)",
      "destination=pathlib.Path(sys.argv[3]); assert destination.parent==programs",
      "records=b.inspect_archive(sys.argv[2],sys.argv[4],sys.argv[5])",
      "b.unpack_verified(sys.argv[2],destination,records,sys.argv[4],sys.argv[5])",
      "b.validated_owned_version(destination)",
    ].join("\n"),path.join(source,"scripts/bootstrap-v2.py"),archive,destination,tag,target],
    {env,encoding:"utf8",timeout:15000})
    :spawnSync("/usr/bin/tar",["-xzf",archive,"-C",destination],{
      encoding:"utf8",timeout:12000
    });
  assert.equal(result.status,0,result.stderr||String(result.error));
  const bundle=JSON.parse(readFileSync(path.join(destination,"bundle.json"),"utf8"));
  assert.equal(bundle.version,destination===oldRoot?oldVersion:nextVersion);
  assert.equal(bundle.target,target);
  assert.equal(bundle.artifact_profile,"rust-native-only-v1");
}
mkdirSync(base,{recursive:true,mode:0o700});
const privateKey=generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"});
const id=randomUUID();
writeFileSync(key,privateKey,{mode:0o600});
writeFileSync(deviceId,id+"\n",{mode:0o600});
mkdirSync(path.dirname(unitFile),{recursive:true,mode:0o700});
mkdirSync(path.dirname(cli),{recursive:true,mode:0o700});
seedUnknownReceipt(receipts,"914-prior-unknown","read_file","a".repeat(64),
  new Date().toISOString(),"unresolved before cutover");

const renderCode=[
  "import importlib.util,pathlib,sys",
  "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
  "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
  "print(b.native_render_unit(pathlib.Path(sys.argv[2]),sys.argv[3],pathlib.Path(sys.argv[4])),end='')",
].join("\n");
const rendered=spawnSync("/usr/bin/python3",["-I","-B","-c",renderCode,
  path.join(source,"scripts/bootstrap-v2.py"),oldRoot,endpoint,key],
  {env,encoding:"utf8",timeout:10000});
assert.equal(rendered.status,0,rendered.stderr);
const oldUnit=rendered.stdout;
let installed=false;
try {
  // Actual first activation of the Node-free binary. Pairing is represented
  // ONLY by the disposable pre-approved key/ID fixture above; no real grant
  // is created. The invalid loopback endpoint cannot supply a signed proof.
  const firstCode=[
    "import importlib.util,pathlib,sys",
    "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
    "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
    "try:b.native_first_install(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),sys.argv[4],pair=lambda *args:None,verify=lambda *args:False)",
    "except ValueError as e:",
    " assert 'Signed activation unconfirmed' in str(e),str(e)",
    " sys.exit(0)",
    "raise AssertionError('First install accepted without signed proof')",
  ].join("\n");
  const first=spawnSync("/usr/bin/python3",["-I","-B","-c",firstCode,
    path.join(source,"scripts/bootstrap-v2.py"),home,nativeRoot,endpoint],{
    env,encoding:"utf8",timeout:30000});
  assert.equal(first.status,0,first.stdout+"\n"+first.stderr);
  installed=true; // ensure fixture cleanup if a later assertion fails
  assert.equal(liveExecutable(rustExe),rustExe);
  assert.ok(existsSync(key+".native-upgrade-intent"));
  assert.ok(!existsSync(key+".native-upgrade-proof"));
  assert.ok(!existsSync(cli));
  const firstSocket=path.join(base,"upgrade.sock");
  const firstDeadline=Date.now()+10000;
  while(!existsSync(firstSocket)&&Date.now()<firstDeadline)
    await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(existsSync(firstSocket),"first activation must expose the local freeze socket");
  assertRootResourceIsolation("initial_activation",[key,deviceId,receipts,unitFile,rustExe,firstSocket,"/run/user/0/bus",key+".native-upgrade-intent"]);
  const firstRecover=[
    "import importlib.util,json,pathlib,sys",
    "spec=importlib.util.spec_from_file_location('b',sys.argv[1])",
    "b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)",
    "print(json.dumps(b.native_recover(pathlib.Path(sys.argv[2]))))",
  ].join("\n");
  const removed=spawnSync("/usr/bin/python3",["-I","-B","-c",firstRecover,
    path.join(source,"scripts/bootstrap-v2.py"),home],{env,encoding:"utf8",timeout:30000});
  assert.equal(removed.status,0,removed.stdout+"\n"+removed.stderr);
  assert.equal(JSON.parse(removed.stdout).status,"initial_service_removed");
  assert.ok(!existsSync(unitFile)&&!existsSync(cli));
  assert.ok(!existsSync(key+".native-upgrade-intent"));
  assert.equal(readFileSync(key,"utf8"),privateKey);
  assert.equal(readFileSync(deviceId,"utf8"),id+"\n");
  const firstDb=new DatabaseSync(receipts,{readOnly:true});
  assert.equal(firstDb.prepare("SELECT state FROM receipts WHERE operation_id='914-prior-unknown'").get().state,"unknown");
  firstDb.close();
  console.log("NATIVE_FIRST_INSTALL_REAL_SYSTEMD_UNCONFIRMED_RECOVERY_PASS");
  installed=false;
  writeFileSync(unitFile,oldUnit,{mode:0o600});
  systemctl("daemon-reload");
  systemctl("enable","--now",UNIT);
  installed=true;
  symlinkSync(path.join(oldRoot,"apps/remote-control-agent/scripts/rca.sh"),cli);
  assert.equal(liveExecutable(priorExe),priorExe,"prior verified Rust is active before handoff");

  // Run the reviewed switch against actual systemd, with a deliberately
  // missing signed Worker WSS proof. This must restore the ORIGINAL Rust.
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
  assert.equal(liveExecutable(priorExe),priorExe,"rollback MUST restore real Rust service");
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

  // Crash after the actual Rust -> Rust systemd switch, before signed WSS
  // acceptance. Killing the Python owner cannot make an unverified upgrade
  // disappear: the original unit, old launcher, identity and Unknown remain.
  systemctl("start",UNIT);
  assert.equal(liveExecutable(priorExe),priorExe);
  const socketDeadline=Date.now()+10000;
  const upgradeSocket=path.join(base,"upgrade.sock");
  while(!existsSync(upgradeSocket)&&Date.now()<socketDeadline)
    await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(existsSync(upgradeSocket),"old Rust upgrade consent socket was not ready");
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
    assert.equal(liveExecutable(rustExe),rustExe,"real native Rust process was not active");
    assert.equal(readFileSync(backupFile,"utf8"),oldUnit,
      "original Rust service backup lost before commit");
    assert.ok(existsSync(key+".native-upgrade-intent"),
      "durable attempt identity missing after Rust activation");
    assert.equal(readlinkSync(cli),path.join(oldRoot,
      "apps/remote-control-agent/scripts/rca.sh"),
      "unverified native switch must not move the installed CLI");
    child.kill("SIGKILL");
    await new Promise(resolve=>child.once("exit",resolve));
    assert.equal(child.signalCode,"SIGKILL","owner upgrader must be interrupted");
    assert.equal(liveExecutable(rustExe),rustExe,"SIGKILL should not erase native systemd state");
    assert.equal(readFileSync(backupFile,"utf8"),oldUnit);
    assert.ok(existsSync(key+".native-upgrade-intent"));
    assert.equal(readFileSync(key,"utf8"),privateKey);
    assert.equal(readFileSync(deviceId,"utf8"),id+"\n");
    assertRootResourceIsolation("interrupted_switch",[key,deviceId,receipts,unitFile,backupFile,rustExe,priorExe,cli,key+".native-upgrade-intent"]);
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
    // Restore the actual prior Rust service using the durable original unit.
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
    assert.equal(liveExecutable(priorExe),priorExe,"original Rust must be restored");
    assertRootResourceIsolation("restored_service",[key,deviceId,receipts,unitFile,priorExe,cli]);
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
  if(rootFixture)assert.equal(statSync(home).mode&0o777,0o550,"installer changed Root HOME permissions");
  console.log(JSON.stringify({
    real_systemd:true,real_published_rust_baseline:!rootFixture,
    root_home_0550_legacy_same_source_fixture:rootFixture,
    native_executable_activated_then_rejected_without_wss:true,
    rollback_rust_active_verified:true,identity_preserved:true,
    unknown_receipt_preserved:true,
    native_upgrader_sigkill_recovery_evidence_preserved:true,
    pending_upgrade_uninstall_refused:true,
    verified_native_recovery_restored_prior_rust:true,
    verified_native_recovery_restored_published_rust:!rootFixture,
    real_rust_to_rust_rejected_without_wss:true,
    original_rust_service_and_unknown_restored:true
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
