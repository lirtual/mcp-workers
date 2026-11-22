/** Real hosted launchd switch attempt with a synthetic identity and no Worker. */
import assert from "node:assert/strict";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {localMacAction,parsePlist} from "../scripts/macos-local.mjs";

const baseline=process.env.RCA_MACOS_BASELINE_ROOT;
const candidate=process.env.RCA_MACOS_CANDIDATE_ROOT;
if(process.platform!=="darwin"||!baseline||!candidate)
  throw Error("This integration requires published and unpublished bundles on native macOS.");
const run=(args)=>spawnSync("/bin/launchctl",args,{encoding:"utf8",timeout:5000,maxBuffer:32768});
const service="gui/"+process.getuid()+"/org.mcp-workers.remote-control-agent";
const activePid=async expected=>{
  for(let i=0;i<60;i++){
    const state=run(["print",service]);
    const match=state.status===0&&state.stdout.match(/(?:^|\n)\s*pid = (\d+)(?:\n|$)/);
    if(match){
      const pid=Number(match[1]);
      const ps=spawnSync("/bin/ps",["-p",String(pid),"-o","command="],
        {encoding:"utf8",timeout:2000});
      if(ps.status===0&&ps.stdout.includes(expected))return {pid,command:ps.stdout.trim()};
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error("Expected packaged LaunchAgent process did not become observable.");
};

test("published Node LaunchAgent rolls back after a real Rust candidate fails signed activation",async t=>{
  assert.equal(run(["print",service]).status,113,"the disposable service label must start absent");
  const oldMeta=JSON.parse(await readFile(path.join(baseline,"bundle.json"),"utf8"));
  const nextMeta=JSON.parse(await readFile(path.join(candidate,"bundle.json"),"utf8"));
  assert.equal(oldMeta.version,"v0.1.56");
  assert.equal(oldMeta.target,nextMeta.target);
  assert.equal(nextMeta.agent_runtime,"rust-standard-darwin-v1");
  const launchdHome=run(["getenv","HOME"]);
  assert.equal(launchdHome.status,0,"capture launchd's existing HOME for exact cleanup");
  const originalLaunchdHome=launchdHome.stdout.trim();
  const hadLaunchdHome=originalLaunchdHome.length>0;
  if(hadLaunchdHome)assert.ok(originalLaunchdHome.startsWith("/"));
  const root=await mkdtemp(path.join(os.tmpdir(),"rca914-launchd-"));
  const home=path.join(root,"home");
  await mkdir(home,{mode:0o700});
  t.after(async()=>{
    run(["bootout",service]);
    for(let i=0;i<50&&run(["print",service]).status===0;i++)
      await new Promise(resolve=>setTimeout(resolve,100));
    run(hadLaunchdHome
      ?["setenv","HOME",originalLaunchdHome]:["unsetenv","HOME"]);
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  assert.equal(run(["setenv","HOME",home]).status,0);
  assert.equal(run(["getenv","HOME"]).stdout.trim(),home);
  const identity=path.join(home,".local/share/mcp-workers/remote-control");
  const state=path.join(home,".local/state/mcp-workers/remote-control-agent");
  await mkdir(identity,{recursive:true,mode:0o700});
  await mkdir(state,{recursive:true,mode:0o700});
  const key=generateKeyPairSync("ed25519").privateKey
    .export({format:"pem",type:"pkcs8"}).toString();
  const keyPath=path.join(identity,"v2-identity.pem");
  await writeFile(keyPath,key,{mode:0o600});
  await writeFile(keyPath+".device-id",randomUUID()+"\n",{mode:0o600});
  const receipts=path.join(state,"operation-receipts.sqlite");
  const receiptBytes=Buffer.from("synthetic receipt sentinel\n");
  await writeFile(receipts,receiptBytes,{mode:0o600});
  const endpoint="https://127.0.0.1/"; // Deliberately no Worker or network grant.
  let oldGeneration;
  const oldOnline=async(_identity,generation)=>{
    assert.equal(generation,oldGeneration);
    await activePid("macos-permanent.js");
    return true; // Only models the unavailable signed-activation callback.
  };
  const first=await localMacAction("install",{
    home,bundle:baseline,sourceSha:oldMeta.source_commit,endpoint,
    ask:async()=>true,online:async(_identity,generation)=>{
      oldGeneration=generation;
      await activePid("macos-permanent.js");
      return true;
    },
  });
  assert.equal(first.status,"connected_observed");
  oldGeneration=first.generation;
  const oldProcess=await activePid("macos-permanent.js");
  let candidateObserved=false;
  await assert.rejects(localMacAction("upgrade",{
    home,bundle:candidate,sourceSha:nextMeta.source_commit,endpoint,
    ask:async()=>true,freezeAgent:async()=>"ready",
    online:async(_identity,generation)=>{
      if(generation===oldGeneration)return oldOnline(_identity,generation);
      assert.equal(generation!==oldGeneration,true);
      candidateObserved=!!await activePid("rca-standard-darwin-candidate");
      return false;
    },
  }),/Upgrade blocked at signed-wss-activation/);
  assert.equal(candidateObserved,true,"the real Rust candidate must launch before activation is rejected");
  const plist=path.join(home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist");
  const restored=parsePlist(await readFile(plist,"utf8"),
    path.join(identity,"macos/programs"),endpoint);
  assert.equal(restored.agentRuntime,"node-v2");
  assert.equal(path.basename(restored.root),"v0.1.56-darwin-"+process.arch);
  const restoredProcess=await activePid("macos-permanent.js");
  assert.notEqual(restoredProcess.pid,oldProcess.pid,"rollback must start a fresh Node process");
  assert.equal(await readFile(keyPath,"utf8"),key);
  assert.equal(await readFile(receipts),receiptBytes);
  assert.equal(await readFile(path.join(macosRoot(home),"switch.json")).then(()=>true,()=>false),false);
});
function macosRoot(home){return path.join(home,".local/share/mcp-workers/remote-control/macos");}
