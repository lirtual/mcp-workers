import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {
  remoteJobLabel,remoteJobPlist,verifiedLaunchdJob,dispatchRemoteMacUpgrade,runRemoteMacUpgrade,
  reconcileFailedRemoteMacUpgrade,
  forwardMacVersion,awaitCallerQuiescence,
} from "../scripts/macos-remote-upgrade.mjs";

const ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LABEL="org.mcp-workers.rca-upgrade-aaaaaaaabbbbccccddddeeeeeeeeeeee";
test("#657 remote macOS operation label is strict, unique and not a service alias",()=>{
  assert.equal(remoteJobLabel(ID),LABEL);
  for(const bad of ["", "../foreign","ABC","aaaa-bbbb","a".repeat(36)])
    assert.throws(()=>remoteJobLabel(bad),/Invalid one-shot/);
});
test("#660 owner-private launchd plist explicitly prevents exit-code replay",()=>{
  const dir="/Users/owner/test & <upgrade>";
  const node=dir+"/bundle/bin/node",worker=dir+"/bundle/worker.mjs";
  const content=remoteJobPlist(ID,node,worker,dir);
  assert.match(content,/<key>LaunchOnlyOnce<\/key><true\/>/);
  assert.match(content,/<key>RunAtLoad<\/key><true\/>/);
  assert.match(content,/<key>KeepAlive<\/key><false\/>/);
  assert.doesNotMatch(content,/KeepAlive<\/key><true\/>/);
  assert.match(content,/&amp; &lt;upgrade&gt;/);
  assert.match(content,/StandardOutPath/);
  assert.match(content,/StandardErrorPath/);
  assert.match(content,/org\.mcp-workers\.rca-upgrade-/);
  assert.throws(()=>remoteJobPlist(ID,"relative",worker,dir),/Absolute owner-private/);
  assert.throws(()=>remoteJobPlist("../bad",node,worker,dir),/Invalid one-shot/);
});

test("#657 detached Mac upgrade rejects same/older versions and other CPU",()=>{
  const base="v0.1.49-rc.4-darwin-arm64";
  for(const good of ["v0.1.49-darwin-arm64","v0.1.49-rc.5-darwin-arm64",
    "v0.1.50-darwin-arm64","v1.0.0-darwin-arm64"])
    assert.equal(forwardMacVersion(base,good),true,good);
  for(const bad of ["v0.1.49-rc.3-darwin-arm64",base,
    "v0.1.48-darwin-arm64","v0.1.49-rc.4-darwin-x64",
    "v0.1.49-darwin-x64","v0.1.49-rc.5-darwin-x64","untrusted"])
    assert.equal(forwardMacVersion(base,bad),false,bad);
  assert.equal(forwardMacVersion("v0.1.49-darwin-arm64",
    "v0.1.49-rc.5-darwin-arm64"),false);
});
test("#657 detached job cannot impersonate arbitrary service or shell PID",()=>{
  const stdout="gui/501/"+LABEL+" = {\n\tpid = 98765\n}";
  const invoke=(cmd,args)=>{
    assert.equal(cmd,"/bin/launchctl");
    assert.deepEqual(args,["print","gui/501/"+LABEL]);
    return {status:0,stdout};
  };
  assert.equal(verifiedLaunchdJob(ID,501,98765,invoke,1),true);
  for(const parent of [0,2,98431])
    assert.equal(verifiedLaunchdJob(ID,501,98765,invoke,parent),false);
  assert.equal(verifiedLaunchdJob(ID,0,98765,invoke,1),false);
  assert.equal(verifiedLaunchdJob(ID,501,98766,invoke,1),false);
  assert.equal(verifiedLaunchdJob(ID,501,98765,()=>({status:5,stderr:"unknown"}),1),false);
  assert.equal(verifiedLaunchdJob(ID,501,98765,()=>({
    status:0,stdout:"\tpid = 987650\n"}),1),false);
});
test("#657 detached handoff waits only for quiescence; never retries uncertain freeze",async()=>{
  let calls=0,pauses=0;
  const status=await awaitCallerQuiescence(async()=>++calls===3?"ready":"busy", "key",{
    attempts:4,pause:async()=>{pauses++;},
  });
  assert.equal(status,"ready");
  assert.equal(calls,3);
  assert.equal(pauses,2);
  calls=0;
  assert.equal(await awaitCallerQuiescence(async()=>{calls++;return "busy";},"key",{
    attempts:2,pause:async()=>{},
  }),"busy");
  assert.equal(calls,2);
  calls=0;
  assert.equal(await awaitCallerQuiescence(async()=>{calls++;return "unknown";},"key",{
    attempts:3,pause:async()=>{},
  }),"unknown");
  assert.equal(calls,1);
  calls=0;
  await assert.rejects(awaitCallerQuiescence(async()=>{calls++;throw Error("socket uncertain");},"key"),
    /socket uncertain/);
  assert.equal(calls,1);
});
test("#657 unreviewed remote launch on non-Darwin cannot stage or switch",async()=>{
  if(process.platform==="darwin")return; // native CI tests cover real platform
  await assert.rejects(dispatchRemoteMacUpgrade({
    home:"/nonexistent",bundle:"/nonexistent",sourceSha:"a".repeat(40),
    endpoint:"https://rca.example.test/",
  }),/Native same-user macOS required/);
  await assert.rejects(runRemoteMacUpgrade(ID),/Not an authorized one-shot owner launchd job/);
});
test("#657 remote launcher references exactly one detached launchd job and durable receipt",()=>{
  const root=path.resolve(import.meta.dirname,"../scripts");
  const driver=readFileSync(path.join(root,"macos-remote-upgrade.mjs"),"utf8");
  const installer=readFileSync(path.join(root,"macos-local.sh"),"utf8");
  const publisher=readFileSync(path.join(root,"build-v2-release.mjs"),"utf8");
  assert.match(driver,/launchctl/);
  assert.match(driver,/\["bootstrap","gui\/"\+process\.getuid\(\),job\]/);
  assert.match(readFileSync(path.join(root,"macos-local.mjs"),"utf8"),/LaunchOnlyOnce/);
  assert.match(driver,/remoteJobPlist\(id,node,worker,dir\)/);
  assert.match(driver,/verifiedLaunchdJob/);
  assert.match(driver,/\bstate:"preparing"/);
  assert.match(driver,/owner_authorized_remote_upgrade/);
  assert.match(driver,/Unreconciled remote upgrade operation/);
  assert.match(driver,/localMacAction\("upgrade"/);
  assert.match(driver,/ask:async\(\)=>true/);
  assert.match(driver,/status:"connected_observed"/);
  assert.match(driver,/status:"needs_attention"/);
  assert.match(installer,/remote-upgrade/);
  assert.match(installer,/\[ -t 0 \] && \[ -t 1 \]/);
  assert.match(installer,/macos-remote-upgrade\.mjs/);
  assert.match(publisher,/scripts\/macos-remote-upgrade\.mjs/);
});
test("#657 remote-upgrade must never execute owner local upgrade on Linux",()=>{
  const sh=path.resolve(import.meta.dirname,"../scripts/macos-local.sh");
  const proc=spawnSync("sh",[sh,"remote-upgrade"],{encoding:"utf8",timeout:5000});
  if(process.platform!=="darwin")assert.match(proc.stderr,/Native macOS required/);
});

test("#657 native owner-on launchd dispatch preserves identity; no replay or silent pairing",{
  skip:process.platform!=="darwin"||!process.env.RCA_MACOS_BUNDLE_ROOT,
},async t=>{
  const {mkdtemp,mkdir,writeFile,readFile,cp,rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const {localMacAction} = await import("../scripts/macos-local.mjs");
  const root=await mkdtemp(path.join(tmpdir(),"rca657-remote-test-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
  const home=path.join(root,"home"),bundle=process.env.RCA_MACOS_BUNDLE_ROOT;
  await mkdir(home,{mode:0o700});
  const identity=path.join(home,".local/share/mcp-workers/remote-control");
  await mkdir(identity,{recursive:true,mode:0o700});
  const key=path.join(identity,"v2-identity.pem");
  await writeFile(key,"synthetic-key",{mode:0o600});
  await writeFile(key+".device-id",ID+"\n",{mode:0o600});
  const sourceSha=JSON.parse(await readFile(path.join(bundle,"bundle.json"),"utf8")).source_commit;
  const endpoint="https://rca.example.test/";
  const call=(cmd,args)=>{assert.equal(cmd,"/bin/launchctl");return {status:0,stdout:"ok"};};
  const installed=await localMacAction("install",{home,bundle,sourceSha,endpoint,
    invoke:call,ask:async()=>true,online:async()=>true});
  const receipts=path.join(home,".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite");
  await writeFile(receipts,"synthetic durable receipts",{mode:0o600});
  await writeFile(path.join(identity,"macos-connection.json"),JSON.stringify({
    generation:installed.generation,state:"connected",pid:process.pid,
    at:new Date(Date.now()-24*60*60*1000).toISOString(),
  }),{mode:0o600});
  const candidate=path.join(root,"new-candidate");
  await cp(bundle,candidate,{recursive:true});
  const metaPath=path.join(candidate,"bundle.json");
  const meta=JSON.parse(await readFile(metaPath,"utf8"));
  // A versioned Release candidate is already newer than v0.0.1-ci.
  // Derive a strictly newer synthetic target so the real downgrade gate remains on.
  const match=/^v(\d+)\.(\d+)\.(\d+)(?:-[a-z0-9.-]+)?$/.exec(meta.version);
  assert.ok(match,"Unrecognized packaged candidate version");
  const nextVersion=`v${match[1]}.${match[2]}.${BigInt(match[3])+1n}`;
  meta.version=nextVersion;
  await writeFile(metaPath,JSON.stringify(meta)+"\n",{mode:0o600});
  const seen=[];
  let registered=true; // The first owner-local install already bootstrapped its service.
  const invoke=(cmd,args)=>{
    assert.equal(cmd,"/bin/launchctl");
    seen.push(args[0]);
    if(args[0]==="print"){
      // The detached job's identity check is independent of the permanent
      // Agent registration. After bootout, only the latter must be absent.
      if(args[1]?.includes("/org.mcp-workers.rca-upgrade-"))
        return {status:0,stdout:"\tpid = "+process.pid+"\n"};
      return registered?{status:0,stdout:"\tpid = "+process.pid+"\n"}:
        {status:113,stderr:"Could not find service"};
    }
    if(args[0]==="bootout")registered=false;
    if(args[0]==="bootstrap")registered=true;
    return {status:0,stdout:""};
  };
  const launched=await dispatchRemoteMacUpgrade({home,bundle:candidate,sourceSha,endpoint,invoke});
  assert.equal(launched.status,"launched");
  assert.equal(launched.version,nextVersion+"-darwin-"+process.arch);
  assert.equal(seen.filter(x=>x==="bootstrap").length,1);
  const jobFile=path.join(identity,"macos/remote-upgrades",launched.operation_id,"job.plist");
  const jobText=await readFile(jobFile,"utf8");
  const lint=spawnSync("/usr/bin/plutil",["-lint",jobFile],
    {encoding:"utf8",timeout:2000});
  assert.equal(lint.status,0,lint.stderr??"launchd plist lint failed");
  assert.equal(jobText,remoteJobPlist(launched.operation_id,
    path.join(identity,"macos/remote-upgrades",launched.operation_id,"bundle/bin/node"),
    path.join(identity,"macos/remote-upgrades",launched.operation_id,
      "bundle/apps/remote-control-agent/scripts/macos-remote-upgrade.mjs"),
    path.join(identity,"macos/remote-upgrades",launched.operation_id)));
  await assert.rejects(dispatchRemoteMacUpgrade({home,bundle:candidate,sourceSha,endpoint,invoke}),
    /Unreconciled remote upgrade/);
  await assert.rejects(runRemoteMacUpgrade(launched.operation_id,{home,invoke,ppid:2}),
    /Not an authorized one-shot/);
  const receiptPath=path.join(identity,"macos/remote-upgrades",launched.operation_id,"result.json");
  await assert.rejects(readFile(receiptPath),{code:"ENOENT"});
  const out=await runRemoteMacUpgrade(launched.operation_id,{home,invoke,ppid:1,
    freezeAgent:async()=> "ready",online:async()=>true});
  assert.equal(out.status,"connected_observed");
  const receipt=JSON.parse(await readFile(receiptPath,"utf8"));
  assert.equal(receipt.version,launched.version);
  assert.equal(receipt.status,"connected_observed");
  assert.equal(await readFile(key+".device-id","utf8"),ID+"\n");
  assert.equal(await readFile(receipts,"utf8"),"synthetic durable receipts");
  await assert.rejects(runRemoteMacUpgrade(launched.operation_id,{home,invoke,ppid:1}),
    /already attempted/);
});

test("#660 hosted native launchd job fails exactly once without automatic restarts",{
  skip:process.platform!=="darwin"||!process.env.RCA_MACOS_BUNDLE_ROOT,
},async t=>{
  const {randomUUID}=await import("node:crypto");
  const {mkdtemp,writeFile,readFile,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const id=randomUUID(),label=remoteJobLabel(id);
  const dir=await mkdtemp(path.join(tmpdir(),"rca660-launchd-once-"));
  const plist=path.join(dir,"job.plist"),script=path.join(dir,"fail-once.sh");
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
  // This is an unpaired CI-only fixture. No owner service, secrets or live
  // remote upgrade is involved; the deliberate failure reproduces #660.
  await writeFile(script,"#!/bin/sh\nprintf 'one invocation\\n'\nsleep 2\nexit 7\n",{mode:0o700});
  await writeFile(plist,remoteJobPlist(id,"/bin/sh",script,dir),{mode:0o600});
  const service="gui/"+process.getuid()+"/"+label;
  const started=spawnSync("/bin/launchctl",["bootstrap","gui/"+process.getuid(),plist],
    {encoding:"utf8",timeout:7000});
  assert.equal(started.status,0,started.stderr??"once-only bootstrap failed");
  try{
    let pid=null;
    for(let i=0;i<35;i++){
      const r=spawnSync("/bin/launchctl",["print",service],
        {encoding:"utf8",timeout:2000});
      if(r.status===0){
        const m=r.stdout.match(/(?:^|\n)\s*pid = (\d+)(?:\n|$)/);
        if(m){pid=Number(m[1]);break;}
      }
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.ok(pid,"once-only native job did not get a launchd PID");
    const ps=spawnSync("/bin/ps",["-p",String(pid),"-o","ppid="],
      {encoding:"utf8",timeout:2000});
    assert.equal(ps.status,0);
    assert.equal(Number(ps.stdout.trim()),1,"job must outlive its submitter");
    // Check across an actual failed child exit, not merely the plist text.
    await new Promise(resolve=>setTimeout(resolve,3100));
    assert.equal(await readFile(path.join(dir,"stdout.log"),"utf8"),"one invocation\n");
    const post=spawnSync("/bin/launchctl",["print",service],
      {encoding:"utf8",timeout:2000});
    if(post.status===0)assert.match(post.stdout,/\bruns = 1\b/);
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(await readFile(path.join(dir,"stdout.log"),"utf8"),"one invocation\n",
      "a failed upgrade must never restart its side-effecting worker");
  }finally{
    // Only this CI fixture label; never the permanent Agent or owner device.
    spawnSync("/bin/launchctl",["bootout",service],
      {encoding:"utf8",timeout:5000});
  }
});

test("#660 historical failed Mac upgrade reconciliation is gated, audited and idempotent",{
  skip:process.platform!=="darwin",
},async t=>{
  const {createHash}=await import("node:crypto");
  const {mkdtemp,mkdir,writeFile,readFile,rename,stat,rm,access}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {plistText,ownerCliText}=await import("../scripts/macos-local.mjs");
  const home=await mkdtemp(path.join(tmpdir(),"rca660-historical-"));
  t.after(()=>rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
  const deviceId="12345678-1234-4234-8234-123456789012";
  const oldGen="22345678-1234-4234-8234-123456789012";
  const nextGen="32345678-1234-4234-8234-123456789012";
  const endpoint="https://rca.example.test/";
  const oldVersion="v0.1.49-rc.4-darwin-"+process.arch;
  const nextVersion="v0.1.50-darwin-"+process.arch;
  const base=path.join(home,".local/share/mcp-workers/remote-control");
  const mac=path.join(base,"macos"),tasks=path.join(mac,"remote-upgrades");
  const dir=path.join(tasks,ID),programs=path.join(mac,"programs");
  const root=path.join(programs,oldVersion),service=path.join(home,"Library/LaunchAgents");
  for(const p of [dir,root,service,path.join(home,".local/bin"),
    path.join(home,".local/state/mcp-workers/remote-control-agent")])
    await mkdir(p,{recursive:true,mode:0o700});
  const ownerWrite=(f,s,mode=0o600)=>writeFile(f,s,{mode});
  await ownerWrite(path.join(base,"v2-identity.pem.device-id"),deviceId+"\n");
  await ownerWrite(path.join(mac,"endpoint"),endpoint+"\n");
  const plist=plistText({node:path.join(root,"bin/node"),
    entry:path.join(root,"apps/remote-control-agent/src/macos-permanent.js"),
    endpoint,generation:oldGen});
  const plistFile=path.join(service,"org.mcp-workers.remote-control-agent.plist");
  await ownerWrite(plistFile,plist);
  await ownerWrite(path.join(home,".local/bin/rca"),ownerCliText(root),0o700);
  await ownerWrite(path.join(home,".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite"),
    "unmodified synthetic SQLite sentinel");
  await ownerWrite(path.join(base,"macos-connection.json"),JSON.stringify({
    generation:oldGen,state:"connected",pid:98765,at:new Date().toISOString(),
  }));
  const label=remoteJobLabel(ID);
  const active=JSON.stringify({id:ID,label,version:nextVersion,state:"preparing"})+"\n";
  const sw=JSON.stringify({version:nextVersion,previous:plist,generation:nextGen,
    stopped:false,phase:"switch_pending"})+"\n";
  await ownerWrite(path.join(tasks,"active.json"),active);
  await ownerWrite(path.join(mac,"switch.json"),sw);
  await ownerWrite(path.join(dir,"context.json"),JSON.stringify({id:ID,label,
    version:nextVersion,sourceSha:"a".repeat(40),endpoint,
    state:"owner_authorized_remote_upgrade"})+"\n");
  await ownerWrite(path.join(dir,"result.json"),JSON.stringify({
    status:"needs_attention",id:ID})+"\n");
  for(const name of ["stdout.log","stderr.log"])
    await ownerWrite(path.join(dir,name),name==="stderr.log"?"failed once\n":"",0o644);
  const digest=s=>createHash("sha256").update(s).digest("hex");
  const invoke=(_cmd,args)=>args[1]?.includes("/org.mcp-workers.rca-upgrade-")?
    {status:113,stderr:"Could not find service"}:
    {status:0,stdout:"state = running\npid = 98765\n"};
  const inspectProcess=()=>({status:0,stdout:
    path.join(root,"apps/remote-control-agent/src/macos-permanent.js")+
    " --service --generation "+oldGen});
  const opts={home,id:ID,deviceId,oldGeneration:oldGen,oldVersion,
    expectedSwitchSha:digest(sw),expectedActiveSha:digest(active),
    invoke,inspectProcess,pause:async()=>{}};
  const archive=path.join(dir,"reconciliation");
  const checkMissing=async p=>assert.rejects(access(p),{code:"ENOENT"});
  assert.equal((await reconcileFailedRemoteMacUpgrade(opts)).status,
    "eligible_failed_reconciliation");
  await checkMissing(archive); // dry run must never create files
  await assert.rejects(reconcileFailedRemoteMacUpgrade({
    ...opts,expectedSwitchSha:"0".repeat(64),apply:true}),/content changed/);
  await checkMissing(archive);
  await assert.rejects(reconcileFailedRemoteMacUpgrade({
    ...opts,apply:true,invoke:()=>({status:0,stdout:"state = running\npid = 98765\n"})}),
    /not confirmed absent/);
  await checkMissing(archive);
  const done=await reconcileFailedRemoteMacUpgrade({...opts,apply:true});
  assert.equal(done.status,"reconciled_failed_operation");
  await checkMissing(path.join(tasks,"active.json"));
  await checkMissing(path.join(mac,"switch.json"));
  assert.equal(await readFile(path.join(archive,"active.json"),"utf8"),active);
  assert.equal(await readFile(path.join(archive,"switch.json"),"utf8"),sw);
  const audit=JSON.parse(await readFile(path.join(archive,"audit.json"),"utf8"));
  assert.equal(audit.hashes.active,digest(active));
  assert.equal(audit.hashes.switch,digest(sw));
  assert.equal(audit.remoteUpgradeReplay,"forbidden");
  assert.equal((await stat(path.join(archive,"audit.json"))).mode&0o777,0o600);
  assert.equal((await reconcileFailedRemoteMacUpgrade({...opts,apply:true})).status,
    "already_reconciled");
  // Simulate a crash between archiving active and archiving switch.
  await rename(path.join(archive,"switch.json"),path.join(mac,"switch.json"));
  assert.equal((await reconcileFailedRemoteMacUpgrade({...opts,apply:true})).status,
    "reconciled_failed_operation");
  assert.equal(await readFile(path.join(archive,"switch.json"),"utf8"),sw);
  assert.equal((await reconcileFailedRemoteMacUpgrade({...opts})).status,
    "already_reconciled");
  assert.equal(JSON.parse(await readFile(path.join(dir,"result.json"),"utf8")).status,
    "needs_attention");
  assert.equal(await readFile(path.join(home,
    ".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite"),"utf8"),
    "unmodified synthetic SQLite sentinel");
  // Duplicate / unexpected historical source must fail closed.
  await ownerWrite(path.join(tasks,"active.json"),active);
  await assert.rejects(reconcileFailedRemoteMacUpgrade({...opts,apply:true}),
    /missing or duplicated/);
  await rm(path.join(tasks,"active.json"));
  // Corrupting the audit fails closed; never silently repairs evidence.
  await ownerWrite(path.join(archive,"audit.json"),"{}\n");
  await assert.rejects(reconcileFailedRemoteMacUpgrade({...opts,apply:true}),
    /audit differs/);
});

test("#1035 completed automatic job cleanup rejects missing, live, foreign and unresolved observations",async t=>{
  const {reconcileAutomaticMacJob}=await import("../scripts/macos-remote-upgrade.mjs");
  const {mkdtemp,mkdir,writeFile,readFile,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const home=await mkdtemp(path.join(tmpdir(),"rca-auto-reap-"));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const base=path.join(home,".local/share/mcp-workers/remote-control");
  const mac=path.join(base,"macos"),tasks=path.join(mac,"remote-upgrades"),dir=path.join(tasks,ID);
  const marker=path.join(tasks,"active.json"),result=path.join(dir,"result.json");
  const job=path.join(dir,"job.plist"),node=path.join(dir,"bundle/bin/node");
  const worker=path.join(dir,"bundle/apps/remote-control-agent/scripts/macos-remote-upgrade.mjs");
  const key=path.join(base,"v2-identity.pem"),version="v1.0.1-darwin-"+process.arch;
  await mkdir(dir,{recursive:true,mode:0o700});
  const put=async(file,value)=>writeFile(file,JSON.stringify(value),{mode:0o600});
  const state={id:ID,label:LABEL,version,state:"preparing",automatic:true};
  await put(marker,state);
  await put(path.join(dir,"context.json"),{...state,state:"owner_authorized_remote_upgrade",sourceSha:"a".repeat(40),expectedBinding:"b".repeat(64)});
  await writeFile(job,remoteJobPlist(ID,node,worker,dir),{mode:0o600});
  await writeFile(key,"synthetic-key",{mode:0o600});
  await writeFile(key+".device-id",ID,{mode:0o600});
  await put(key+".native-upgrade-result",{device_id:ID,operation_id:ID.replaceAll("-",""),
    target_version:"v1.0.1",installed_version:"v1.0.1",status:"success",updated_at_unix_ms:123});
  let mode="live",calls=[],removed=false;
  const service="gui/"+process.getuid()+"/"+LABEL;
  const valid=service+" = {\n path = "+job+"\n state = not running\n program = "+node+
    "\n arguments = {\n "+node+"\n "+worker+"\n worker\n "+ID+"\n }\n}\n";
  const invoke=(_binary,args)=>{
    calls.push(args[0]);
    if(args[0]==="bootout"){removed=true;return {status:0};}
    if(removed)return {status:113,stderr:"Could not find service"};
    if(mode==="unknown")return {status:1,stderr:"unconfirmed"};
    return {status:0,stdout:mode==="live"?valid.replace("state = not running","state = running\n pid = 123"):
      mode==="foreign"?valid.replace("program = "+node,"program = "+node+"-foreign"):
      mode==="other-plan"?valid.replace(worker,worker+"-foreign"):valid};
  };
  const reap=()=>reconcileAutomaticMacJob(home,invoke,async()=>{});
  await assert.rejects(reap()); // result missing: no native request
  assert.deepEqual(calls,[]);
  await put(result,{id:ID,version,status:"connected_observed"});
  for(const invalid of ["live","foreign","other-plan","unknown"]){
    mode=invalid;calls=[];
    await assert.rejects(reap());
    assert(!calls.includes("bootout"),invalid);
    assert.equal(JSON.parse(await readFile(marker,"utf8")).id,ID);
  }
  mode="valid";
  await put(path.join(mac,"switch.json"),{pending:true});
  await assert.rejects(reap(),/outcome unconfirmed/);
  await rm(path.join(mac,"switch.json"));
  await reap();
  assert(removed);
  await assert.rejects(readFile(marker),{code:"ENOENT"});
  await assert.rejects(readFile(result),{code:"ENOENT"});
  assert.equal(JSON.parse(await readFile(key+".native-upgrade-result","utf8")).status,"success");
});
