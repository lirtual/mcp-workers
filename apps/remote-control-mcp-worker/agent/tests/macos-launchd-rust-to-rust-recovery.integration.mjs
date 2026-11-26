/** Unpublished Rust LaunchAgent to a newer unpublished Rust LaunchAgent.
 * No GitHub Latest request and no production release-guard change.
 * Signed activation is refused; the previous Rust service must be restored. */
import assert from "node:assert/strict";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {localMacAction,parsePlist} from "../scripts/macos-local.mjs";

const baseline=process.env.RCA_MACOS_RUST_BASELINE_ROOT;
const candidate=process.env.RCA_MACOS_RUST_CANDIDATE_ROOT;
if(process.platform!=="darwin"||!baseline||!candidate)
  throw Error("This integration requires two unpublished Rust bundles on native macOS.");
const run=(args)=>spawnSync("/bin/launchctl",args,{encoding:"utf8",timeout:5000,maxBuffer:32768});
const service="gui/"+process.getuid()+"/org.mcp-workers.remote-control-agent";
const rustBinary=root=>path.join(root,"apps/remote-control-agent/.build/rca-standard-darwin-candidate");

function launchdEvidence(expected){
  const state=run(["print",service]);
  const program=state.stdout?.match(/^\s*program = (.*\S)\s*$/m)?.[1];
  const runs=Number(state.stdout?.match(/^\s*runs = (\d+)$/m)?.[1]);
  const lastExit=state.stdout?.match(/^\s*last exit code = (-?\d+)$/m)?.[1];
  const match=state.status===0&&state.stdout.match(/(?:^|\n)\s*pid = (\d+)(?:\n|$)/);
  let live=false;
  if(match){
    const ps=spawnSync("/bin/ps",["-p",match[1],"-o","command="],{encoding:"utf8",timeout:2000});
    live=ps.status===0&&ps.stdout.includes(expected);
  }
  return {status:state.status,program,runs,lastExit,live,
    observed:state.status===0&&program===expected&&(live||(runs>=1&&lastExit==="1"))};
}

async function rustObserved(expected){
  const deadline=performance.now()+10000;
  let observed={};
  do{
    observed=launchdEvidence(expected);
    if(observed.observed)return observed;
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(performance.now()<deadline);
  console.error("Rust LaunchAgent observation failed",expected,JSON.stringify(observed));
  throw Error("Expected Rust LaunchAgent was not observed.");
}

test("unpublished Rust LaunchAgent rolls back to the previous Rust service",async t=>{
  assert.equal(run(["print",service]).status,113,"the disposable service label must start absent");
  const oldMeta=JSON.parse(await readFile(path.join(baseline,"bundle.json"),"utf8"));
  const nextMeta=JSON.parse(await readFile(path.join(candidate,"bundle.json"),"utf8"));
  assert.equal(oldMeta.agent_runtime,"rust-standard-darwin-v1");
  assert.equal(nextMeta.agent_runtime,"rust-standard-darwin-v1");
  assert.equal(oldMeta.target,nextMeta.target);
  assert.notEqual(oldMeta.version,nextMeta.version);
  const launchdHome=run(["getenv","HOME"]);
  assert.equal(launchdHome.status,0,"capture launchd's existing HOME for exact cleanup");
  const originalLaunchdHome=launchdHome.stdout.trim();
  const hadLaunchdHome=originalLaunchdHome.length>0;
  if(hadLaunchdHome)assert.ok(originalLaunchdHome.startsWith("/"));
  const root=await mkdtemp(path.join(os.tmpdir(),"rca914-rust-launchd-"));
  const home=path.join(root,"home");
  await mkdir(home,{mode:0o700});
  t.after(async()=>{
    run(["bootout",service]);
    for(let i=0;i<50&&run(["print",service]).status===0;i++)
      await new Promise(resolve=>setTimeout(resolve,100));
    run(hadLaunchdHome?["setenv","HOME",originalLaunchdHome]:["unsetenv","HOME"]);
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  assert.equal(run(["setenv","HOME",home]).status,0);
  assert.equal(run(["getenv","HOME"]).stdout.trim(),home);
  const identity=path.join(home,".local/share/mcp-workers/remote-control");
  const installed=(meta)=>path.join(identity,"macos/programs",
    meta.version+"-darwin-"+process.arch);
  const oldBinary=rustBinary(installed(oldMeta));
  const nextBinary=rustBinary(installed(nextMeta));
  assert.notEqual(oldBinary,nextBinary);
  const state=path.join(home,".local/state/mcp-workers/remote-control-agent");
  await mkdir(identity,{recursive:true,mode:0o700});
  await mkdir(state,{recursive:true,mode:0o700});
  const key=generateKeyPairSync("ed25519").privateKey.export({format:"pem",type:"pkcs8"}).toString();
  const keyPath=path.join(identity,"v2-identity.pem");
  await writeFile(keyPath,key,{mode:0o600});
  await writeFile(keyPath+".device-id",randomUUID()+"\n",{mode:0o600});
  const receipts=path.join(state,"operation-receipts.sqlite");
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
  const endpoint="https://127.0.0.1/";
  let oldGeneration;
  const oldOnline=async(_identity,generation)=>{
    assert.equal(generation,oldGeneration);
    await rustObserved(oldBinary);
    return true;
  };
  const first=await localMacAction("install",{
    home,bundle:baseline,sourceSha:oldMeta.source_commit,endpoint,
    ask:async()=>true,online:async(_identity,generation)=>{
      oldGeneration=generation;
      await rustObserved(oldBinary);
      return true;
    },
  });
  assert.equal(first.status,"connected_observed");
  oldGeneration=first.generation;
  const oldService=await rustObserved(oldBinary);
  let candidateObserved=false;
  await assert.rejects(localMacAction("upgrade",{
    home,bundle:candidate,sourceSha:nextMeta.source_commit,endpoint,
    ask:async()=>true,freezeAgent:async()=>"ready",
    online:async(_identity,generation)=>{
      if(generation===oldGeneration)return oldOnline(_identity,generation);
      try{
        candidateObserved=(await rustObserved(nextBinary)).observed;
      }catch{
        candidateObserved=launchdEvidence(nextBinary).observed;
      }
      return false;
    },
  }),/Upgrade blocked at signed-wss-activation/);
  assert.equal(candidateObserved,true,"the newer Rust program must be launched before recovery");
  const plist=path.join(home,"Library/LaunchAgents/org.mcp-workers.remote-control-agent.plist");
  const restored=parsePlist(await readFile(plist,"utf8"),
    path.join(identity,"macos/programs"),endpoint);
  assert.equal(restored.agentRuntime,"rust-standard-darwin-v1");
  assert.equal(path.basename(restored.root),oldMeta.version+"-darwin-"+process.arch);
  const restoredService=await rustObserved(oldBinary);
  assert.ok(restoredService.live||restoredService.runs>oldService.runs,
    "rollback must launch the previous Rust program again");
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
  assert.equal(await readFile(path.join(identity,"macos/switch.json")).then(()=>true,()=>false),false);
});
