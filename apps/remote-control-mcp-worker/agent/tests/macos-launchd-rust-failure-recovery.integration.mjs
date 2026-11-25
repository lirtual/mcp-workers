/** Real hosted launchd switch attempt with a synthetic identity and no Worker. */
import assert from "node:assert/strict";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
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
// Match the production observeOnline 10-second observation window. Retain
// only bounded launchd state fields on failure, not environment or paths.
const activePid=async expected=>{
  const deadline=performance.now()+10000;
  let observed={};
  do{
    const state=run(["print",service]);
    observed={status:state.status,state:state.stdout?.match(/^\s*state = ([a-zA-Z ]+)$/m)?.[1],
      runs:state.stdout?.match(/^\s*runs = (\d+)$/m)?.[1],
      lastExit:state.stdout?.match(/^\s*last exit code = (-?\d+)$/m)?.[1]};
    const match=state.status===0&&state.stdout.match(/(?:^|\n)\s*pid = (\d+)(?:\n|$)/);
    if(match){
      const pid=Number(match[1]);
      const ps=spawnSync("/bin/ps",["-p",String(pid),"-o","command="],
        {encoding:"utf8",timeout:2000});
      if(ps.status===0&&ps.stdout.includes(expected))return {pid,command:ps.stdout.trim()};
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(performance.now()<deadline);
  console.error("LaunchAgent observation failed",expected,JSON.stringify(observed));
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
  // Real v1 SQLite history is required for the Rust candidate to reach WSS.
  // A plain text sentinel makes it exit before the intended rollback test.
  await writeFile(receipts,"",{mode:0o600});
  const receiptId=randomUUID();
  const db=new DatabaseSync(receipts);
  try{
    db.exec(`CREATE TABLE receipts (
      operation_id TEXT PRIMARY KEY NOT NULL,
      tool_name TEXT NOT NULL,
      argument_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      safe_result_summary TEXT,
      session_id TEXT,
      guarded INTEGER NOT NULL CHECK(guarded IN (0,1))
    ); PRAGMA user_version=1;`);
    const at="2026-11-22T00:00:00.000Z";
    db.prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?,?,NULL,1)")
      .run(receiptId,"write_file","a".repeat(64),"unknown",at,at,
        "Historical unknown must not replay.");
  }finally{db.close();}
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
      try{
        candidateObserved=!!await activePid("rca-standard-darwin-candidate");
      }catch{
        // An invalid WSS endpoint may make a genuine Rust process exit before
        // a PID snapshot. Require launchd's registered Rust program, a run,
        // and the binary's exit(1), not just a successful plist bootstrap.
        const recorded=run(["print",service]);
        candidateObserved=recorded.status===0&&
          /^\s*program = .*rca-standard-darwin-candidate\s*$/m.test(recorded.stdout)&&
          /^\s*runs = [1-9]\d*\s*$/m.test(recorded.stdout)&&
          /^\s*last exit code = 1\s*$/m.test(recorded.stdout);
      }
      return false;
    },
  }),/Upgrade blocked at signed-wss-activation/);
  assert.equal(candidateObserved,true,"Rust must be observed live or launchd must record its real failed execution");
  const plist=path.join(home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist");
  const restored=parsePlist(await readFile(plist,"utf8"),
    path.join(identity,"macos/programs"),endpoint);
  assert.equal(restored.agentRuntime,"node-v2");
  assert.equal(path.basename(restored.root),"v0.1.56-darwin-"+process.arch);
  const restoredProcess=await activePid("macos-permanent.js");
  assert.notEqual(restoredProcess.pid,oldProcess.pid,"rollback must start a fresh Node process");
  assert.equal(await readFile(keyPath,"utf8"),key);
  const receiptSnapshot=path.join(root,"receipt-snapshot.sqlite");
  await writeFile(receiptSnapshot,await readFile(receipts),{mode:0o600});
  const verified=new DatabaseSync(receiptSnapshot);
  try{
    assert.equal(verified.prepare("PRAGMA user_version").get().user_version,1);
    const receipt=verified.prepare(
      "SELECT operation_id, tool_name, argument_digest, state, guarded FROM receipts"
    ).get();
    assert.equal(receipt.operation_id,receiptId);
    assert.equal(receipt.tool_name,"write_file");
    assert.equal(receipt.argument_digest,"a".repeat(64));
    assert.equal(receipt.state,"unknown");
    assert.equal(receipt.guarded,1,"historical unknown must remain guarded and not replayed");
  }finally{verified.close();}
  assert.equal(await readFile(path.join(macosRoot(home),"switch.json")).then(()=>true,()=>false),false);
});
function macosRoot(home){return path.join(home,".local/share/mcp-workers/remote-control/macos");}
