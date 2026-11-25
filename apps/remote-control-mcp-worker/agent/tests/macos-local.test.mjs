import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {chmod,cp,lstat,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {acceptsOwnerConfirmation,admitsMacOwnerUpgrade,awaitLaunchctlUnregistered,candidateName,checked,launchctlServiceState,localMacAction,observeOnline,ownedWrite,ownerCliText,parsePlist,plistText,stopLaunchdForSwitch,verifiedEndpoint} from
  "../scripts/macos-local.mjs";
import {parsePermanentMacArgs} from "../src/macos-permanent.ts";
const ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ENDPOINT="https://rca.example.test/";
const bundle=process.env.RCA_MACOS_BUNDLE_ROOT;

test("#1035 a Freeze response requires the complete exact protocol frame",async()=>{
  const {parseFreezeReply}=await import("../scripts/macos-local.mjs");
  for(const value of ["busy","ready","released"]){
    assert.equal(parseFreezeReply(value+"\n"),value);
    assert.throws(()=>parseFreezeReply(value),/unconfirmed/);
    assert.throws(()=>parseFreezeReply(" "+value+"\n"),/unconfirmed/);
    assert.throws(()=>parseFreezeReply(value+"\r\n"),/unconfirmed/);
  }
});

test("#914 macOS activation reads Rust epoch and Node ISO connection markers",async t=>{
  const identity=await mkdtemp(path.join(os.tmpdir(),"rca914-connection-"));
  t.after(()=>rm(identity,{recursive:true,force:true}));
  const generation=randomUUID();
  const at=Date.now();
  const marker=path.join(identity,"macos-connection.json");
  for(const observed of [at,new Date(at).toISOString()]){
    await writeFile(marker,JSON.stringify({
      generation,version:"rust-candidate",pid:123,state:"connected",at:observed
    })+"\n",{mode:0o600});
    assert.equal(await observeOnline(identity,generation,()=>at),true);
  }
});

test("#661 macOS owner installer dispatch must not silently skip a symlinked/aliased entry path",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"rca-mac-entry-alias-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const canonical=path.resolve(import.meta.dirname,"../scripts/macos-local.mjs");
  const aliased=path.join(root,"macos-local.mjs");
  await symlink(canonical,aliased);
  const r=spawnSync(process.execPath,[aliased,"unsupported-action"],{
    encoding:"utf8",timeout:5000});
  assert.equal(r.status,1,"aliased executable must actually run the owner action");
  assert.match(r.stderr,/macOS local action blocked: Unsupported local action/);
});

test("#1035 all macOS lifecycle paths recognize only exact owned launcher text",async()=>{
  const {matchesOwnerCli}=await import("../scripts/macos-local.mjs");
  const root="/Users/owner/programs/v0.1.60-darwin-arm64";
  for(const legacy of [true,false]){
    const launcher=ownerCliText(root,legacy);
    assert.equal(matchesOwnerCli(launcher,root),true);
    assert.equal(matchesOwnerCli(launcher+"# foreign\n",root),false);
    assert.equal(matchesOwnerCli(launcher,root+"-other"),false);
  }
});
test("#1035 automatic update consent is identity-bound and fail closed",async t=>{
  const {readMacAutoPolicy,writeMacAutoPolicy}=await import("../scripts/macos-local.mjs");
  const root=await mkdtemp(path.join(os.tmpdir(),"rca1035-policy-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const key=path.join(root,"v2-identity.pem"),policy=key+".automatic-update";
  const other="bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  await writeFile(key,"synthetic-key",{mode:0o600});
  await writeFile(key+".device-id",ID+"\n",{mode:0o600});
  assert.equal(await readMacAutoPolicy(key,ID),"off");
  assert.equal(await readMacAutoPolicy(key,other),"off");
  await writeMacAutoPolicy(key,ID,true);
  assert.equal(await readMacAutoPolicy(key,ID),"on");
  assert.equal(await readMacAutoPolicy(key,other),"off");
  assert.equal((await lstat(policy)).mode&0o777,0o600);
  await writeMacAutoPolicy(key,ID,false);
  assert.equal(await readMacAutoPolicy(key,ID),"off");
  for(const value of ["{",JSON.stringify({device_id:ID,enabled:1}),
      JSON.stringify({device_id:ID,enabled:true,extra:true})," ".repeat(257)]){
    await writeFile(policy,value);
    assert.equal(await readMacAutoPolicy(key,ID),"unknown");
  }
  await chmod(policy,0o644);
  assert.equal(await readMacAutoPolicy(key,ID),"unknown");
  await assert.rejects(writeMacAutoPolicy(key,ID,true),/Unsafe/);
  await rm(policy);
  await symlink(key,policy);
  assert.equal(await readMacAutoPolicy(key,ID),"unknown");
  await assert.rejects(writeMacAutoPolicy(key,ID,true),/Unsafe/);
  await rm(policy);
  await writeFile(key+".device-id",other+"\n");
  await assert.rejects(writeMacAutoPolicy(key,ID,true),/identity changed/);
  await assert.rejects(lstat(policy),{code:"ENOENT"});
});

test("#1035 switch journal exclusively reserves the existing transaction before Freeze",async t=>{
  const {reserveMacSwitch}=await import("../scripts/macos-local.mjs");
  const root=await mkdtemp(path.join(os.tmpdir(),"rca1035-journal-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=path.join(root,"switch.json"),record=JSON.stringify({phase:"switch_pending",generation:ID})+"\n";
  let requested=0;
  const ready=async()=>{requested++;assert.equal(await readFile(journal,"utf8"),record);return "ready";};
  assert.equal(await reserveMacSwitch(journal,record,async()=>{},ready),true);
  await assert.rejects(reserveMacSwitch(journal,record,async()=>{},ready),{code:"EEXIST"});
  assert.equal(requested,1);
  assert.equal(await readFile(journal,"utf8"),record);
  await rm(journal);
  await assert.rejects(reserveMacSwitch(journal,record,async()=>{throw Error("changed target");},ready),/changed target/);
  assert.equal(requested,1);
  await assert.rejects(lstat(journal),{code:"ENOENT"});
  await assert.rejects(reserveMacSwitch(journal,record,async()=>{},async()=>"busy"),/Busy or uncertain/);
  await assert.rejects(lstat(journal),{code:"ENOENT"});
  for(const freeze of [async()=>{throw Error("lost reply");},async()=>"",async()=>"unknown"]){
    await assert.rejects(reserveMacSwitch(journal,record,async()=>{},freeze),/Freeze ownership unknown/);
    assert.equal(await readFile(journal,"utf8"),record);
    await rm(journal);
  }
  assert.equal(await reserveMacSwitch(journal,record,async()=>{},null),false);
  assert.equal(await readFile(journal,"utf8"),record);
});

test("#1035 existing macOS upgrade binds exact local identity and configuration",async t=>{
  const {macUpgradeBinding}=await import("../scripts/macos-local.mjs");
  const home=await mkdtemp(path.join(os.tmpdir(),"rca1035-binding-"));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const files=Object.fromEntries(["key","plist","cli","endpointFile","stopMark","journal"].map(name=>[name,path.join(home,name)]));
  const initial={key:"synthetic-key",plist:"old-plist",cli:"owned-launcher",endpointFile:ENDPOINT+"\n"};
  for(const [name,value] of Object.entries(initial))await writeFile(files[name],value,{mode:name==="cli"?0o700:0o600});
  await writeFile(files.key+".device-id",ID+"\n",{mode:0o600});
  const before=await macUpgradeBinding(files);
  assert.deepEqual(await macUpgradeBinding(files),before);
  for(const [name,value] of Object.entries(initial)){
    await writeFile(files[name],value+"changed",{mode:name==="cli"?0o700:0o600});
    assert.notDeepEqual(await macUpgradeBinding(files),before,name);
    await writeFile(files[name],value);
  }
  await writeFile(files.key+".device-id","bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee\n");
  assert.notDeepEqual(await macUpgradeBinding(files),before);
  await writeFile(files.key+".device-id",ID+"\n");
  await writeFile(files.stopMark,"stopped\n",{mode:0o600});
  assert.notDeepEqual(await macUpgradeBinding(files),before);
  await rm(files.stopMark);
  await writeFile(files.journal,"pending",{mode:0o600});
  await assert.rejects(macUpgradeBinding(files),/Unresolved/);
  await rm(files.journal);
  await rm(files.key+".device-id");
  await assert.rejects(macUpgradeBinding(files),/Approved/);
});

test("#1035 macOS Latest check observes the five-platform stable publication only",async()=>{
  const {checkLatestMacVersion}=await import("../scripts/macos-local.mjs");
  const {selectLatestAgentRelease}=await import("../../src/github-latest-agent-release.ts");
  const tag="v0.1.60";
  const fixture=()=>({tag_name:tag,immutable:true,draft:false,prerelease:false,
    html_url:"https://github.com/lirtual/mcp-workers/releases/tag/"+tag,
    assets:["linux-x64-glibc","linux-arm64-glibc","windows-x64","darwin-arm64","darwin-x64"].map(target=>{
      const name="remote-control-agent-"+tag+"-"+target+(target==="windows-x64"?".zip":".tar.gz");
      return {name,state:"uploaded",size:7000000,digest:"sha256:"+"a".repeat(64),
        browser_download_url:"https://github.com/lirtual/mcp-workers/releases/download/"+tag+"/"+name};
    })});
  let requests=0;
  const observe=async(installed,body,status=200)=>checkLatestMacVersion(installed,"arm64",async(url,opts)=>{
    requests++;
    assert.equal(url,"https://api.github.com/repos/lirtual/mcp-workers/releases/latest");
    assert.equal(opts.redirect,"error");
    return new Response(JSON.stringify(body),{status});
  });
  for(const [installed,status] of [["v0.1.59","update_available"],[tag,"up_to_date"],
      ["v0.1.60-rc.1","update_available"],["v0.1.61","older_latest"]]){
    assert.deepEqual(await observe(installed,fixture()),{installed_version:installed,latest_version:tag,status});
  }
  for(const mutate of [
    r=>r.immutable="true",r=>r.html_url="https://example.invalid/release",
    r=>r.assets.pop(),r=>r.assets.push(r.assets[0]),r=>r.assets[0].size="7000000",
    r=>r.assets[0].digest="bad",r=>r.assets[0].browser_download_url="https://example.invalid/asset",
  ]){
    const body=fixture();mutate(body);
    assert.equal(selectLatestAgentRelease({status:200,body}).ok,false);
    assert.deepEqual(await observe("v0.1.59",body),{installed_version:"v0.1.59",latest_version:null,status:"unknown"});
  }
  for(const code of [403,404,429,503])assert.equal((await observe(tag,{},code)).status,"unknown");
  assert.equal((await checkLatestMacVersion(tag,"arm64",async()=>{throw Error("offline")})).status,"unknown");
  assert.equal((await checkLatestMacVersion(tag,"arm64",async()=>new Response(" ".repeat(1048577)))).status,"unknown");
  assert.equal(requests,15);
});

test("#660 owner confirmation is case-insensitive, empty input denies",()=>{
  for(const value of ["y","Y","yes","YES"," Yes "])
    assert.equal(acceptsOwnerConfirmation(value),true);
  for(const value of ["","n","NO","maybe","approve","yess"])
    assert.equal(acceptsOwnerConfirmation(value),false);
});

test("#1035 attended confirmation handles EOF and refuses piped input",{skip:process.platform==="win32"},()=>{
  const moduleUrl=new URL("../scripts/macos-local.mjs",import.meta.url).href;
  const code='import {confirm} from '+JSON.stringify(moduleUrl)+'; console.log("RESULT="+await confirm("Confirm test?"));';
  const pipe=spawnSync(process.execPath,["--input-type=module","-e",code],{
    input:"y\n",encoding:"utf8",timeout:5000});
  assert.notEqual(pipe.status,0);
  assert.match(pipe.stderr,/Owner terminal required/);
  const pty=String.raw`import os,pty,select,subprocess,sys,time
for response,expected in [(b"y\n",b"RESULT=true"),(b"\n",b"RESULT=false"),(b"\x04",b"RESULT=false")]:
    master,slave=pty.openpty()
    child=subprocess.Popen([sys.argv[1],"--input-type=module","-e",sys.argv[2]],stdin=slave,stdout=slave,stderr=slave)
    os.close(slave)
    out=b"";sent=False;deadline=time.monotonic()+4
    try:
        while time.monotonic()<deadline:
            if select.select([master],[],[],0.1)[0]:
                try: chunk=os.read(master,4096)
                except OSError: break
                if not chunk: break
                out+=chunk
            if b"[y/N]" in out and not sent:
                os.write(master,response);sent=True
            if child.poll() is not None: break
        assert sent and expected in out,(response,out)
        assert child.wait(timeout=2)==0,out
    finally:
        if child.poll() is None: child.kill();child.wait()
        os.close(master)
print("CONFIRM_PTY_PASS")
`;
  const result=spawnSync("python3",["-B","-c",pty,process.execPath,code],{encoding:"utf8",timeout:16000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/CONFIRM_PTY_PASS/);
});

test("#660 launch locations permit owner 0755 but not group/other writes",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"rca-parent-mode-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const name of ["LaunchAgents","bin"]){
    const dir=path.join(root,name);
    await mkdir(dir,{mode:0o755});
    await chmod(dir,0o755);
    const file=path.join(dir,"owned-file");
    await assert.rejects(ownedWrite(file,"first",false,0o600),/Unsafe owner/);
    await ownedWrite(file,"first",false,0o600,false);
    assert.equal(await readFile(file,"utf8"),"first");
    assert.equal((await lstat(file)).mode&0o777,0o600);
    await chmod(dir,0o777);
    await assert.rejects(ownedWrite(file,"second",true,0o600,false),/Unsafe owner/);
    assert.equal(await readFile(file,"utf8"),"first");
  }
});

test("#660 launchctl check distinguishes a missing service from an unknown failure",()=>{
  const absent={status:113,stderr:'Bad request. Could not find service "rca"'};
  assert.equal(launchctlServiceState('gui/501/rca',()=>absent),'absent');
  assert.equal(launchctlServiceState('gui/501/rca',()=>({status:0})),'present');
  assert.equal(launchctlServiceState('gui/501/rca',()=>({status:5,stderr:'EIO'})),'unknown');
});

test("#660 stop waits for two observed launchd deregistration checks",async()=>{
  let reads=0,waits=0;
  const invoke=(command,args)=>{
    assert.equal(args[0],'print');
    reads++;
    return reads<4?{status:0}:{status:113,stderr:'Could not find service'};
  };
  assert.equal(await awaitLaunchctlUnregistered('gui/501/rca',invoke,
    async()=>{waits++;}),true);
  assert.equal(reads,5);
  assert.equal(waits,4);
  await assert.rejects(awaitLaunchctlUnregistered('gui/501/rca',
    ()=>({status:5}),async()=>{}),/state unknown/);
  assert.equal(await awaitLaunchctlUnregistered('gui/501/rca',
    ()=>({status:0}),async()=>{}),false);
});

test("#660 upgrade switch waits for confirmed launchd absence before any bootstrap",async()=>{
  const calls=[];
  let remaining=3;
  const invoke=(command,args)=>{
    assert.equal(command,"/bin/launchctl");
    calls.push(args[0]);
    if(args[0]==="bootout")return {status:0};
    assert.equal(args[0],"print");
    return remaining-->0?{status:0}:{status:113,stderr:"Could not find service"};
  };
  await stopLaunchdForSwitch("gui/501/org.mcp-workers.remote-control-agent",invoke,
    async()=>{});
  assert.deepEqual(calls,["bootout","print","print","print","print","print"]);
  calls.length=0;
  await assert.rejects(stopLaunchdForSwitch("gui/501/rca",
    (command,args)=>{calls.push(args[0]);return {status:5};},async()=>{}),
    /bootout unconfirmed/);
  assert.deepEqual(calls,["bootout"]);
  await assert.rejects(stopLaunchdForSwitch("gui/501/rca",
    ()=>({status:0}),async()=>{}),/deregistration not confirmed/);
  await assert.rejects(stopLaunchdForSwitch("gui/501/rca",
    ()=>({status:5}),async()=>{},false),/state unknown/);
});

test("#660 owner-local rca executable quotes paths and refuses unverified commands",async t=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"rca660-cli-"));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,"o'neill;touch BAD","programs","v0.0.0-ci-darwin-arm64");
  await mkdir(path.join(root,"bin"),{recursive:true,mode:0o700});
  await writeFile(path.join(root,"bin/node"),'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o700});
  const script=ownerCliText(root);
  const file=path.join(temp,"rca");
  await writeFile(file,script,{mode:0o700});
  assert.equal(spawnSync("/bin/sh",["-n",file]).status,0);
  for(const action of ["upgrade","install","status",""]) {
    const args=action?[action]:[];
    const r=spawnSync("/bin/sh",[file,...args],{encoding:"utf8",cwd:temp});
    if(action==="status"||action==="upgrade"){
      assert.equal(r.status,0,r.stderr);
      assert.deepEqual(r.stdout.trim().split("\n"),[
        path.join(root,"apps/remote-control-agent/scripts/macos-local.mjs"),action]);
    }else{
      assert.equal(r.status,2);
      assert.equal(r.stdout,"");
    }
  }
  await assert.rejects(lstat(path.join(temp,"BAD")),{code:"ENOENT"});
  assert.match(script,/status\|doctor/);
  assert.match(script,/stop\|start/);
  assert.ok(script.includes("o'\"'\"'neill"));
});

test("#1035 macOS CLI routes supported commands and rejects arbitrary options",async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"rca1035-cli-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,"bin"),{mode:0o700});
  await writeFile(path.join(root,"bin/node"),'#!/bin/sh\nprintf "%s\\n" "$@"\n',{mode:0o700});
  const file=path.join(root,"rca");
  await writeFile(file,ownerCliText(root),{mode:0o700});
  const invoke=args=>spawnSync("/bin/sh",[file,...args],{encoding:"utf8"});
  for(const args of [["status","--json"],["doctor"],["doctor","--json"],["update","--check"],["upgrade","--check"],["update","--auto"],["update","--auto","on"],["upgrade","--auto","off"],["update"],["upgrade"],["--help"],["--version"]]){
    const result=invoke(args);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n").slice(1),args);
  }
  for(const args of [["status","--repair"],["doctor","--repair"],["start","--json"],["--help","extra"],["--version","extra"],["update","--auto","yes"],["update","--auto","on","extra"],["install"]])
    assert.equal(invoke(args).status,2,args.join(" "));
});

test("#1035 macOS status and doctor do not create absent directories",{skip:process.platform!=="darwin"},async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"rca1035-readonly-"));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const fail=()=>{throw Error("read-only action invoked a service or consent");};
  const opts={home,invoke:fail,ask:fail,ownerIntent:fail};
  const state=await localMacAction("status",opts);
  assert.equal(state.local_service,"not_installed");
  const diagnosis=await localMacAction("doctor",opts);
  assert.deepEqual(diagnosis.status,state);
  assert.ok(diagnosis.findings.includes("permanent_service_not_installed"));
  assert.ok(diagnosis.findings.includes("cloud_authorization_unconfirmed"));
  assert.deepEqual(await readdir(home),[]);
  await symlink(home,path.join(home,".local"));
  await assert.rejects(localMacAction("status",opts),/Unsafe owner/);
  assert.deepEqual(await readdir(home),[".local"]);
});

test("#660 permanent service accepts only exact approved existing grant and managed generation",()=>{
  const approved=parsePermanentMacArgs(["--service","--endpoint",ENDPOINT,"--generation",ID]);
  assert.equal(approved.service,true);
  assert.equal(approved.endpoint,ENDPOINT);
  for(const args of [
    ["--service","--endpoint",ENDPOINT],
    ["--service","--endpoint",ENDPOINT,"--retry-pairing","--generation",ID],
    ["--service","--endpoint",ENDPOINT,"--name","foreign","--generation",ID],
    ["--service","--endpoint",ENDPOINT,"--generation","bad"],
  ])assert.throws(()=>parsePermanentMacArgs(args));
  assert.throws(()=>verifiedEndpoint("http://rca.example.test/"));
  assert.throws(()=>verifiedEndpoint("https://example.test/path"));
});

test("#660 LaunchAgent plist is strictly owned, deterministic and rejects foreign mutations",()=>{
  const programs="/Users/test/.local/share/mcp-workers/remote-control/macos/programs";
  const root=path.join(programs,"v0.0.0-ci-darwin-arm64");
  const node=path.join(root,"bin/node");
  const entry=path.join(root,"apps/remote-control-agent/src/macos-permanent.js");
  const xml=plistText({node,entry,endpoint:ENDPOINT,generation:ID});
  assert.deepEqual(parsePlist(xml,programs,ENDPOINT,"arm64"),
    {root,generation:ID,agentRuntime:"node-v2"});
  const intelRoot=path.join(programs,"v0.0.0-ci-darwin-x64");
  const intelXml=plistText({node:path.join(intelRoot,"bin/node"),
    entry:path.join(intelRoot,"apps/remote-control-agent/src/macos-permanent.js"),
    endpoint:ENDPOINT,generation:ID});
  assert.deepEqual(parsePlist(intelXml,programs,ENDPOINT,"x64"),
    {root:intelRoot,generation:ID,agentRuntime:"node-v2"});
  assert.throws(()=>parsePlist(intelXml,programs,ENDPOINT,"arm64"));
  for(const other of [
    xml.replace("/bin/node","/bin/sh"),
    xml.replace("KeepAlive</key><true/>","KeepAlive</key><false/>"),
    xml.replace("</dict>","<key>Disabled</key><true/></dict>"),
  ])assert.throws(()=>parsePlist(other,programs,ENDPOINT,"arm64"));
});

test("#809 installed v0.1.51 source commit does not authorize the next macOS download",()=>{
  const oldCommit="03a14fd4138ca8d77fa8aced78f7a53ccc51724e";
  const newCommit="b".repeat(40);
  assert.equal(admitsMacOwnerUpgrade({
    installedVersion:"v0.1.51-darwin-arm64",
    installedSourceCommit:oldCommit,
    candidateVersion:"v0.2.0-darwin-arm64",
    candidateSourceCommit:newCommit,
  }),true);
  assert.equal(admitsMacOwnerUpgrade({
    installedVersion:"v0.1.51-darwin-x64",
    installedSourceCommit:oldCommit,
    candidateVersion:"v0.2.0-darwin-x64",
    candidateSourceCommit:newCommit,
  }),true);
  assert.equal(admitsMacOwnerUpgrade({
    installedVersion:"v0.1.51-darwin-arm64",
    installedSourceCommit:oldCommit,
    candidateVersion:"v0.2.0-darwin-arm64",
    candidateSourceCommit:oldCommit,
  }),true);
  assert.equal(admitsMacOwnerUpgrade({
    installedVersion:"v0.1.51-darwin-arm64",
    installedSourceCommit:oldCommit,
    candidateVersion:"v0.1.51-darwin-arm64",
    candidateSourceCommit:newCommit,
  }),false);
  assert.equal(admitsMacOwnerUpgrade({
    installedVersion:"v0.1.52-darwin-arm64",
    installedSourceCommit:newCommit,
    candidateVersion:"v0.1.51-darwin-arm64",
    candidateSourceCommit:oldCommit,
  }),false);
  assert.equal(admitsMacOwnerUpgrade({
    installedVersion:"v0.1.51-darwin-arm64",
    installedSourceCommit:oldCommit,
    candidateVersion:"v0.2.0-darwin-x64",
    candidateSourceCommit:newCommit,
  }),false);
  assert.equal(admitsMacOwnerUpgrade({
    installedVersion:"v0.1.51-darwin-arm64",
    installedSourceCommit:"03a14fd",
    candidateVersion:"v0.2.0-darwin-arm64",
    candidateSourceCommit:newCommit,
  }),false);
});
test("#660 candidate provenance requires exact pinned source and no change of protocol",()=>{
  const meta={version:"v0.0.0-ci",target:"darwin-arm64",source_commit:"a".repeat(40),
    artifact_schema:1,device_protocol:2,receipt_schema:1,
    agent_runtime:"node-v2",candidate_profile:"darwin-permanent-local-v1",
    native_supervisor:"darwin-owned-group-v1",modules:["macos-permanent.ts"]};
  assert.equal(candidateName(meta,"a".repeat(40),"arm64"),"v0.0.0-ci-darwin-arm64");
  const publishedNode={...meta};
  delete publishedNode.agent_runtime;
  assert.equal(candidateName(publishedNode,"a".repeat(40),"arm64"),
    "v0.0.0-ci-darwin-arm64","published v0.1.56 Node manifests predate agent_runtime");
  assert.throws(()=>candidateName({...publishedNode,agent_runtime:"unknown"},"a".repeat(40),"arm64"));
  assert.equal(candidateName({...meta,target:"darwin-x64"},"a".repeat(40),"x64"),"v0.0.0-ci-darwin-x64");
  assert.throws(()=>candidateName(meta,"a".repeat(40),"x64"));
  assert.throws(()=>candidateName(meta,"b".repeat(40),"arm64"));
  assert.throws(()=>candidateName({...meta,target:"linux-x64-glibc"},"a".repeat(40),"arm64"));
  assert.throws(()=>candidateName({...meta,device_protocol:3},"a".repeat(40),"arm64"));
  const rust={...meta,version:"v0.1.57-rust-candidate.1",
    agent_runtime:"rust-standard-darwin-v1",
    runtime_profile:"standard-darwin-rust-runtime-v1"};
  assert.equal(candidateName(rust,"a".repeat(40),"arm64"),
    "v0.1.57-rust-candidate.1-darwin-arm64");
  assert.throws(()=>candidateName({...rust,runtime_profile:"standard-linux-rust-runtime-v1"},
    "a".repeat(40),"arm64"));
  const programs="/Users/test/.local/share/mcp-workers/remote-control/macos/programs";
  const root=path.join(programs,"v0.1.57-rust-candidate.1-darwin-arm64");
  const rustExecutable=path.join(root,"apps/remote-control-agent/.build/rca-standard-darwin-candidate");
  const rustXml=plistText({node:path.join(root,"bin/node"),entry:rustExecutable,
    endpoint:ENDPOINT,generation:ID,agentRuntime:"rust-standard-darwin-v1"});
  assert.match(rustXml,/rca-standard-darwin-candidate/);
  assert.doesNotMatch(rustXml,/macos-permanent\\.js/);
  assert.deepEqual(parsePlist(rustXml,programs,ENDPOINT,"arm64"),
    {root,generation:ID,agentRuntime:"rust-standard-darwin-v1"});
  assert.throws(()=>parsePlist(rustXml.replace("rca-standard-darwin-candidate","/bin/sh"),
    programs,ENDPOINT,"arm64"));
});

const native=process.platform==="darwin"&&["arm64","x64"].includes(process.arch)&&!!bundle;
function nextCandidateVersion(version){
  const match=/^v(\d+)\.(\d+)\.(\d+)(?:-[a-z0-9.-]+)?$/.exec(version);
  if(!match) throw new Error("Unrecognized packaged candidate version");
  return `v${match[1]}.${match[2]}.${BigInt(match[3])+1n}`;
}

test("#803 synthetic macOS upgrade target stays one patch ahead of the packaged candidate",()=>{
  assert.equal(nextCandidateVersion("v0.0.0-ci"),"v0.0.1");
  assert.equal(nextCandidateVersion("v0.1.52"),"v0.1.53");
});

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),"rca660-test-"));
  const home=path.join(root,"home");
  await mkdir(home,{mode:0o700});
  const identity=path.join(home,".local/share/mcp-workers/remote-control");
  await mkdir(identity,{recursive:true,mode:0o700});
  // The fixture is an already explicitly authorized permanent identity;
  // no remote pairing and NO real launchctl commands are performed by tests.
  const key=path.join(identity,"v2-identity.pem");
  await writeFile(key,"synthetic-private-key",{mode:0o600});
  await writeFile(key+".device-id",ID+"\n",{mode:0o600});
  const manifest=JSON.parse(await readFile(path.join(bundle,"bundle.json"),"utf8"));
  t.after(async()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20}));
  return {root,home,identity,sourceSha:manifest.source_commit,version:manifest.version,
    commands:[],invoke:(command,args)=>{assert.equal(command,"/bin/launchctl");
      const entry=args.join(" ");return {status:0,stdout:entry};}};
}
test("#662 temporary bootstrap reuses foreground runtime without LaunchAgent writes",{skip:!native},async t=>{
  const f=await fixture(t), calls=[];
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    terminal:()=>true,runTemporary:(file,args,settings)=>{
      calls.push({file,args,settings});return {status:0};}};
  const result=await localMacAction("temporary",opts);
  assert.equal(result.status,"temporary_session_ended");
  assert.equal(calls.length,1);
  assert.equal(calls[0].file,path.join(bundle,"bin/node"));
  assert.deepEqual(calls[0].args,[
    path.join(bundle,"apps/remote-control-agent/src/macos-temporary.js"),
    "--endpoint",ENDPOINT,"--bootstrap-selected"]);
  assert.deepEqual(calls[0].settings,{stdio:"inherit"});
  await assert.rejects(readFile(path.join(f.home,
    "Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist")),{code:"ENOENT"});
  await assert.rejects(localMacAction("temporary",{...opts,sourceSha:"b".repeat(40)}),
    /Unexpected source commit/);
  await assert.rejects(localMacAction("temporary",{...opts,terminal:()=>false}),
    /Owner terminal required/);
  await assert.rejects(localMacAction("temporary",{...opts,runTemporary:()=>({status:2})}),
    /without confirmed success/);
});

test("#1035 unresolved macOS switch allows diagnosis and consent withdrawal only",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const key=path.join(f.identity,"v2-identity.pem");
  const journal=path.join(f.identity,"macos/switch.json");
  const {writeMacAutoPolicy}=await import("../scripts/macos-local.mjs");
  await mkdir(path.dirname(journal),{mode:0o700});
  await writeFile(journal,"synthetic interrupted switch\n",{mode:0o600});
  await writeMacAutoPolicy(key,ID,true);
  const opts={home:f.home,invoke:()=>{throw Error("No launchd access");},
    ask:()=>{throw Error("No confirmation");},
    doFetch:()=>{throw Error("No network");}};
  const status=await localMacAction("status",opts);
  assert.equal(status.installed,null);
  assert.equal(status.automatic_update,"on");
  assert.equal(status.automatic_update_activity,"needs_attention");
  assert.ok((await localMacAction("doctor",opts)).findings.includes("unresolved_upgrade_journal"));
  assert.deepEqual(await localMacAction("update-policy",opts),{automatic_update:"on"});
  await assert.rejects(localMacAction("update-policy",{...opts,policyAction:"on"}),/Unresolved/);
  await assert.rejects(localMacAction("update-latest",opts),/Unresolved/);
  assert.deepEqual(await localMacAction("update-policy",{...opts,policyAction:"off"}),{automatic_update:"off"});
  assert.equal((await localMacAction("status",opts)).automatic_update_activity,"needs_attention");
  assert.equal(await readFile(journal,"utf8"),"synthetic interrupted switch\n");
  assert.equal(await readFile(key,"utf8"),"synthetic-private-key");
});

test("#660 native offline install → stopped state → upgrade without restart",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:f.invoke,ask:async()=>true,online:async()=>true,
    ownerIntent:async()=>({status:'stopped',idle_expires_at:Date.now()+14*86_400_000}),
    freezeAgent:async()=>{throw Error("Stopped service must not freeze");}};
  const first=await localMacAction("install",opts);
  assert.equal(first.status,"connected_observed");
  const cli=path.join(f.home,".local/bin/rca");
  const firstRoot=path.join(f.identity,"macos/programs",f.version+"-darwin-"+process.arch);
  assert.equal(first.cli,cli);
  assert.equal(await readFile(cli,"utf8"),ownerCliText(firstRoot));
  assert.equal((await lstat(cli)).mode&0o777,0o700);
  assert.equal(spawnSync("/bin/sh",["-n",cli]).status,0);
  const help=spawnSync("/bin/sh",[cli,"--help"],{encoding:"utf8"});
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/doctor/);
  const version=spawnSync("/bin/sh",[cli,"--version"],{encoding:"utf8"});
  assert.equal(version.status,0,version.stderr);
  assert.equal(version.stdout.trim(),f.version);
  assert.notEqual(spawnSync("/bin/sh",[cli,"upgrade"],{encoding:"utf8"}).status,0,
    "unattended bare update must be refused");
  const state=await localMacAction("status",{home:f.home,invoke:f.invoke});
  assert.equal(state.installed,true);
  assert.equal(state.automatic_update,"off");
  assert.deepEqual(await localMacAction("update-policy",{home:f.home}),{automatic_update:"off"});
  if(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(f.version)){
    assert.deepEqual(await localMacAction("update-policy",{home:f.home,policyAction:"on"}),{automatic_update:"on"});
    assert.equal((await localMacAction("status",{home:f.home})).automatic_update,"on");
    assert.deepEqual(await localMacAction("update-policy",{home:f.home,policyAction:"off"}),{automatic_update:"off"});
  }else{
    await assert.rejects(localMacAction("update-policy",{home:f.home,policyAction:"on"}),/requires a stable Agent/);
  }
  // The old published launcher remains valid until an explicit upgrade
  // installs the new launcher; a read-only action must never replace it.
  const legacy=ownerCliText(firstRoot,true);
  await writeFile(cli,legacy,{mode:0o700});
  assert.deepEqual(await localMacAction("status",{home:f.home,invoke:f.invoke}),state);
  assert.equal(await readFile(cli,"utf8"),legacy);
  const launches=[];
  const {macUpgradeBinding,macBindingDigest}=await import("../scripts/macos-local.mjs");
  const scripts=path.join(firstRoot,"apps/remote-control-agent/scripts");
  const updater=path.join(scripts,"macos-update.sh");
  const {renderPackagedMacUpdateShell}=await import("../../src/install-macos-latest.ts");
  assert.equal(await readFile(updater,"utf8"),renderPackagedMacUpdateShell());
  assert.equal((await lstat(updater)).mode&0o777,0o600);
  const update=await localMacAction("update-latest",{home:f.home,invoke:f.invoke,terminal:()=>true,
    ask:()=>{throw Error("No redundant confirmation before verified manager");},
    runUpdate:(command,args,options)=>{launches.push({command,args,options});return {status:0};}});
  assert.equal(update.status,"installer_completed");
  const mac=path.join(f.identity,"macos");
  const binding=await macUpgradeBinding({key:path.join(f.identity,"v2-identity.pem"),
    plist:path.join(f.home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist"),
    cli,endpointFile:path.join(mac,"endpoint"),stopMark:path.join(mac,"stopped"),journal:path.join(mac,"switch.json")});
  assert.deepEqual(launches,[{command:"/bin/sh",args:[updater,ENDPOINT,f.version,macBindingDigest(binding)],
    options:{stdio:"inherit"}}]);
  let checks=0;
  const observed=await localMacAction("check-update",{home:f.home,
    invoke:()=>{throw Error("read-only check must not call launchctl");},
    ask:()=>{throw Error("read-only check must not confirm");},
    doFetch:async()=>{checks++;return new Response("",{status:429});}});
  assert.equal(observed.installed_version,f.version);
  assert.equal(observed.status,"unknown");
  assert.equal(checks,/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:rc|rust-candidate)\.[1-9]\d*)?$/.test(f.version)?1:0);
  assert.equal(await readFile(cli,"utf8"),legacy);
  let unloaded=false;
  await localMacAction("stop",{...opts,pauseLaunchd:async()=>{},invoke:(command,args)=>{
    f.commands.push(args[0]);
    if(args[0]==="bootout")unloaded=true;
    return args[0]==="print"&&unloaded
      ?{status:113,stderr:"Could not find service"}:{status:0};}});
  const alt=path.join(f.root,"second");
  await cp(bundle,alt,{recursive:true});
  const manifestFile=path.join(alt,"bundle.json");
  const manifest=JSON.parse(await readFile(manifestFile,"utf8"));
  const nextVersion=nextCandidateVersion(manifest.version);
  manifest.version=nextVersion;
  await writeFile(manifestFile,JSON.stringify(manifest)+"\n",{mode:0o600});
  f.commands.length=0;
  const result=await localMacAction("upgrade",{...opts,bundle:alt,
    invoke:(command,args)=>{f.commands.push(args[0]);
      return {status:args[0]==="print"?1:0};}});
  assert.equal(result.status,"stopped_preserved");
  assert.equal(await readFile(cli,"utf8"),
    ownerCliText(path.join(f.identity,"macos/programs",nextVersion+"-darwin-"+process.arch)));
  assert.deepEqual(f.commands,["print"],
    "intentionally stopped service may only be checked, never auto-launched");
  assert.equal((await localMacAction("status",{home:f.home,invoke:f.invoke})).local_service,
    "stopped_requested_unverified");
  assert.equal((await readFile(path.join(f.identity,"v2-identity.pem.device-id"),"utf8")).trim(),ID);
});

test("#660 first install bootstrap refusal preserves approved device and staged bundle",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:(command,args)=>({status:args[0]==="bootstrap"?1:0}),
    ask:async()=>true,online:async()=>true};
  const keyId=path.join(f.identity,"v2-identity.pem.device-id");
  const previous=await readFile(keyId,"utf8");
  await assert.rejects(localMacAction("install",opts),/Install blocked at launchagent-bootstrap/);
  assert.equal(await readFile(keyId,"utf8"),previous);
  for(const relative of ["Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist",
    ".local/bin/rca",".local/share/mcp-workers/remote-control/macos/switch.json"])
    await assert.rejects(readFile(path.join(f.home,relative)),{code:"ENOENT"});
  const staged=path.join(f.identity,"macos/programs",f.version+"-darwin-"+process.arch);
  assert.equal((await lstat(staged)).isDirectory(),true);
  await assert.rejects(localMacAction("install",opts),/already staged; never overwrite/);
});

test("#1035 identity changed during owner confirmation refuses existing upgrade before staging",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:f.invoke,ask:async()=>true,online:async()=>true};
  await localMacAction("install",opts);
  const alt=path.join(f.root,"changed-target");
  await cp(bundle,alt,{recursive:true});
  const manifestFile=path.join(alt,"bundle.json");
  const meta=JSON.parse(await readFile(manifestFile,"utf8"));
  meta.version=nextCandidateVersion(meta.version);
  await writeFile(manifestFile,JSON.stringify(meta)+"\n",{mode:0o600});
  const next=path.join(f.identity,"macos/programs",meta.version+"-darwin-"+process.arch);
  await assert.rejects(localMacAction("upgrade",{...opts,bundle:alt,expectedBinding:"0".repeat(64),
    ask:async()=>{throw Error("Changed download target must not confirm");}
  }),/Existing upgrade target changed during download/);
  await assert.rejects(lstat(next),{code:"ENOENT"});
  await assert.rejects(localMacAction("upgrade",{...opts,bundle:alt,
    ask:async()=>{await writeFile(path.join(f.identity,"v2-identity.pem"),"changed-synthetic-key");return true;},
    freezeAgent:async()=>{throw Error("Changed target must not freeze");}
  }),/Existing upgrade target changed/);
  await assert.rejects(lstat(next),{code:"ENOENT"});
});

test("#660 native upgrade busy/activation failure retains identity and rolls back",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const base={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:f.invoke,ask:async()=>true,online:async()=>true};
  await localMacAction("install",base);
  const alt=path.join(f.root,"update");
  await cp(bundle,alt,{recursive:true});
  const manifestFile=path.join(alt,"bundle.json");
  const m=JSON.parse(await readFile(manifestFile,"utf8"));
  m.version=nextCandidateVersion(m.version);
  await writeFile(manifestFile,JSON.stringify(m)+"\n",{mode:0o600});
  const opts={...base,bundle:alt,freezeAgent:async()=> "busy"};
  await assert.rejects(localMacAction("upgrade",opts),/Busy or uncertain/);
  assert.equal((await localMacAction("status",{home:f.home,invoke:f.invoke})).version,
    f.version+"-darwin-"+process.arch);
  const programs=path.join(f.identity,"macos/programs");
  const next=path.join(programs,m.version+"-darwin-"+process.arch);
  await assert.rejects(lstat(next),{code:"ENOENT"});
  await assert.rejects(localMacAction("upgrade",opts),/Busy or uncertain/);
  await assert.rejects(lstat(next),{code:"ENOENT"});
  assert.equal((await readFile(path.join(f.identity,"v2-identity.pem.device-id"),"utf8")).trim(),ID);
});

test("#1035 lost macOS Freeze reply leaves the existing service and recovery journal",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const calls=[];
  const invoke=(command,args)=>{calls.push(args[0]);return f.invoke(command,args);};
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke,ask:async()=>true,online:async()=>true};
  await localMacAction("install",opts);
  const plist=path.join(f.home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist");
  const cli=path.join(f.home,".local/bin/rca");
  const journal=path.join(f.identity,"macos/switch.json");
  const before=[await readFile(plist,"utf8"),await readFile(cli,"utf8")];
  const alt=path.join(f.root,"lost-reply");
  await cp(bundle,alt,{recursive:true});
  const manifestFile=path.join(alt,"bundle.json");
  const meta=JSON.parse(await readFile(manifestFile,"utf8"));
  meta.version=nextCandidateVersion(meta.version);
  await writeFile(manifestFile,JSON.stringify(meta)+"\n",{mode:0o600});
  calls.length=0;
  const freezeCalls=[];
  await assert.rejects(localMacAction("upgrade",{...opts,bundle:alt,
    freezeAgent:async(key,action="freeze")=>{
      freezeCalls.push(action);
      assert.equal(JSON.parse(await readFile(journal,"utf8")).previous,before[0]);
      throw Error("Simulated lost response");
    }}),/Freeze ownership unknown/);
  assert.deepEqual(freezeCalls,["freeze"]);
  assert.ok(calls.length>0&&calls.every(action=>action==="print"));
  assert.deepEqual([await readFile(plist,"utf8"),await readFile(cli,"utf8")],before);
  assert.equal((await localMacAction("status",{home:f.home})).automatic_update_activity,"needs_attention");
  assert.equal(JSON.parse(await readFile(journal,"utf8")).phase,"switch_pending");
});

test("#660 native refuses unsafe identity, LaunchAgent and file links",{
  skip:!native},async t=>{
  const f=await fixture(t);
  await chmod(path.join(f.identity,"v2-identity.pem"),0o644);
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:f.invoke,ask:async()=>true,online:async()=>true};
  await assert.rejects(localMacAction("install",opts),/Unsafe owner/);
});

test("#660 native activation failure restores prior reviewed LaunchAgent and identity",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const actions=[];
  let registered=false;
  const mock=(command,args)=>{
    actions.push(args[0]);
    if(args[0]==="print")return registered?{status:0}
      :{status:113,stderr:"Could not find service"};
    if(args[0]==="bootstrap")registered=true;
    if(args[0]==="bootout")registered=false;
    return {status:0};
  };
  const first={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:mock,ask:async()=>true,online:async()=>true,pauseLaunchd:async()=>{}};
  await localMacAction("install",first);
  // Verify real-world 0755 parent modes do not block rollback restoration.
  await chmod(path.join(f.home,"Library/LaunchAgents"),0o755);
  await chmod(path.join(f.home,".local/bin"),0o755);
  const plist=path.join(f.home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist");
  const before=await readFile(plist,"utf8");
  const cli=path.join(f.home,".local/bin/rca");
  const beforeCli=await readFile(cli,"utf8");
  const alt=path.join(f.root,"rollback-candidate");
  await cp(bundle,alt,{recursive:true});
  const manifestFile=path.join(alt,"bundle.json");
  const meta=JSON.parse(await readFile(manifestFile,"utf8"));
  meta.version=nextCandidateVersion(meta.version);
  await writeFile(manifestFile,JSON.stringify(meta)+"\n",{mode:0o600});
  let onlineCalls=0;
  await assert.rejects(localMacAction("upgrade",{
    ...first,bundle:alt,freezeAgent:async()=> "ready",
    online:async()=>++onlineCalls===2,
  }),/Upgrade blocked at signed-wss-activation/);
  assert.deepEqual(actions.filter(x=>x==="bootout"||x==="bootstrap"),
    ["bootstrap","bootout","bootstrap","bootout","bootstrap"]);
  assert.equal(registered,true);
  // The switch and rollback both waited for two confirmed absent checks.
  assert.ok(actions.filter(x=>x==="print").length>=5);
  assert.equal(await readFile(plist,"utf8"),before);
  assert.equal(await readFile(cli,"utf8"),beforeCli);
  assert.equal((await readFile(path.join(f.identity,"v2-identity.pem.device-id"),"utf8")).trim(),ID);
  await assert.rejects(readFile(path.join(f.home,
    ".local/share/mcp-workers/remote-control/macos/switch.json")),{code:"ENOENT"});
});

test("#660 native stale bootout blocks upgrade and restores old LaunchAgent",{
  skip:!native},async t=>{
  const f=await fixture(t);
  let registered=false,bootouts=0,bootstraps=0;
  const invoke=(command,args)=>{
    const a=args[0];
    if(a==="print")return bootouts===1?{status:0}:
      registered?{status:0}:{status:113,stderr:"Could not find service"};
    if(a==="bootstrap"){registered=true;bootstraps++;return {status:0};}
    if(a==="bootout"){bootouts++;registered=bootouts===1;return {status:0};}
    throw Error("Unexpected launchctl action");
  };
  const first={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke,ask:async()=>true,online:async()=>true,pauseLaunchd:async()=>{}};
  await localMacAction("install",first);
  const plist=path.join(f.home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist");
  const before=await readFile(plist,"utf8");
  const candidate=path.join(f.root,"stale-update");
  await cp(bundle,candidate,{recursive:true});
  const manifest=path.join(candidate,"bundle.json");
  const meta=JSON.parse(await readFile(manifest,"utf8"));
  meta.version=nextCandidateVersion(meta.version);
  await writeFile(manifest,JSON.stringify(meta)+"\n",{mode:0o600});
  await assert.rejects(localMacAction("upgrade",{
    ...first,bundle:candidate,freezeAgent:async()=> "ready",
  }),/Upgrade blocked at wait-old-service-unregistered/);
  assert.equal(bootouts,2);
  assert.equal(bootstraps,2,"never bootstrap a new Agent during stale old deregistration");
  assert.equal(registered,true);
  assert.equal(await readFile(plist,"utf8"),before);
  await assert.rejects(readFile(path.join(f.identity,"macos/switch.json")),{code:"ENOENT"});
});

test("#660 native unreconciled new deregistration preserves switch journal",{
  skip:!native},async t=>{
  const f=await fixture(t);
  let registered=false,bootouts=0,bootstraps=0;
  const invoke=(command,args)=>{
    const a=args[0];
    if(a==="print")return registered?{status:0}:
      {status:113,stderr:"Could not find service"};
    if(a==="bootstrap"){registered=true;bootstraps++;return {status:0};}
    if(a==="bootout"){
      bootouts++;
      registered=bootouts===2; // new bootout acknowledged but remains registered
      return {status:0};
    }
    throw Error("Unexpected launchctl action");
  };
  const first={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke,ask:async()=>true,online:async()=>true,pauseLaunchd:async()=>{}};
  await localMacAction("install",first);
  const candidate=path.join(f.root,"uncertain-rollback");
  await cp(bundle,candidate,{recursive:true});
  const manifest=path.join(candidate,"bundle.json");
  const meta=JSON.parse(await readFile(manifest,"utf8"));
  meta.version=nextCandidateVersion(meta.version);
  await writeFile(manifest,JSON.stringify(meta)+"\n",{mode:0o600});
  await assert.rejects(localMacAction("upgrade",{
    ...first,bundle:candidate,freezeAgent:async()=> "ready",
    online:async()=>false,
  }),/UNKNOWN rollback at stop-new-service after signed-wss-activation/);
  assert.equal(bootstraps,2,"must not bootstrap old over uncertain new registration");
  assert.equal(registered,true);
  const journal=JSON.parse(await readFile(path.join(f.identity,"macos/switch.json"),"utf8"));
  assert.equal(journal.phase,"switch_pending");
});

test("#660 local rca path cannot overwrite foreign files or symlinks",{skip:!native},async t=>{
  const f=await fixture(t);
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:f.invoke,ask:async()=>true,online:async()=>true};
  const dir=path.join(f.home,".local/bin"),cli=path.join(dir,"rca");
  await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(cli,"#!/bin/sh\necho foreign\n",{mode:0o700});
  await assert.rejects(localMacAction("install",opts),/Foreign or inconsistent local rca/);
  assert.equal(await readFile(cli,"utf8"),"#!/bin/sh\necho foreign\n");
  await rm(cli);
  await symlink(path.join(f.identity,"v2-identity.pem"),cli);
  await assert.rejects(localMacAction("install",opts),/Unsafe owner/);
  assert.equal((await readFile(path.join(f.identity,"v2-identity.pem.device-id"),"utf8")).trim(),ID);
});

test("#660 native suspicious LaunchAgent symlink refused before any mutation",{
  skip:!native},async t=>{
  const f=await fixture(t);
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke:f.invoke,ask:async()=>true,online:async()=>true};
  await localMacAction("install",opts);
  const plist=path.join(f.home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist");
  await rm(plist);
  await symlink(path.join(f.identity,"v2-identity.pem"),plist);
  await assert.rejects(localMacAction("status",opts),/Unsafe owner/);
  assert.equal(await readFile(path.join(f.identity,"v2-identity.pem"),"utf8"),"synthetic-private-key");
});


test('#660 native failed bootstrap records exit code and preserves STOP and key',{
  skip:!native},async t=>{
  const f=await fixture(t),identity=path.join(f.identity,'v2-identity.pem.device-id');
  const device=await readFile(identity,'utf8');
  let registered=false,bootstraps=0;
  const invoke=(command,args)=>{
    if(args[0]==='print')return registered?{status:0}
      :{status:113,stderr:'Could not find service'};
    if(args[0]==='bootstrap'){
      if(++bootstraps===1){registered=true;return {status:0};}
      return {status:5,stderr:'Bootstrap failed: 5: Input/output error'};
    }
    if(args[0]==='bootout'){registered=false;return {status:0};}
    return {status:0};
  };
  const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
    invoke,ask:async()=>true,online:async()=>true,pauseLaunchd:async()=>{},
    ownerIntent:async(action)=>({status:action==='resume'?'resume_pending':'stopped'})};
  await localMacAction('install',opts);
  assert.equal((await localMacAction('stop',opts)).status,'intentionally_stopped');
  await assert.rejects(localMacAction('start',opts),/bootstrap failed \(exit=5\)/);
  assert.equal(await readFile(path.join(f.identity,'macos/stopped'),'utf8'),'stopped\n');
  assert.equal(await readFile(identity,'utf8'),device);
  assert.equal(registered,false);
});

test('#666 native owner Stop/Resume preserves same identity and demands signed activation',{
 skip:!native},async t=>{
 const f=await fixture(t),calls=[];
 const opts={home:f.home,bundle,sourceSha:f.sourceSha,endpoint:ENDPOINT,
   invoke:(command,args)=>{calls.push('launch:'+args[0]);return args[0]==='print'
     ?{status:113,stderr:'Could not find service'}:{status:0}},
  ask:async()=>true,online:async()=>true,
  ownerIntent:async(action)=>{calls.push('cloud:'+action);
   return {status:action==='stop'?'stopped':'resume_pending',idle_expires_at:Date.now()+14*86_400_000}}};
 await localMacAction('install',opts);
 await localMacAction('stop',opts);
 const marker=path.join(f.identity,'macos','stopped');
 assert.equal(await readFile(marker,'utf8'),'stopped\n');
 assert.equal((await localMacAction('status',opts)).local_service,'stopped_requested_unverified');
 assert.equal((await localMacAction('start',opts)).status,'connected_observed');
 await assert.rejects(readFile(marker),{code:'ENOENT'});
 assert.deepEqual(calls.filter(x=>x.startsWith('cloud:')),['cloud:stop','cloud:stop','cloud:resume']);
 assert.equal((await readFile(path.join(f.identity,'v2-identity.pem.device-id'),'utf8')).trim(),ID);
});
