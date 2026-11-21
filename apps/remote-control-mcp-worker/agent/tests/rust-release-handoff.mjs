// Opt-in disposable local Worker test; never an installed service or release gate.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawn, spawnSync} from "node:child_process";
import {copyFile, chmod, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";

const endpoint="http://127.0.0.1:18777/";
const token="disposable-handoff-owner-token-0000000001";
const releaseSha="7eb0def23325a63a426c8402f7c2ef68d8e5ae0e6739563d13a669887f386ace";
const archive=process.env.RCA_HANDOFF_RELEASE_ARCHIVE;
const rust=process.env.RCA_HANDOFF_RUST_BIN;
const supervisor=process.env.RCA_HANDOFF_SUPERVISOR;
if(process.env.RCA_HANDOFF_DISPOSABLE!=="1" || !archive || !rust || !supervisor)
  throw Error("Explicit disposable archive, Rust binary and Supervisor required");
const sha=data=>createHash("sha256").update(data).digest("hex");
assert.equal(sha(await readFile(archive)),releaseSha,"published Node v0.1.56 archive digest");

const root=await mkdtemp("/tmp/rca-handoff-");
await chmod(root,0o700);
const release=path.join(root,"release"), key=path.join(root,"v2-identity.pem");
let child;
const env={PATH:"/usr/bin:/bin",HOME:root,REMOTE_CONTROL_AGENT_ENDPOINT:endpoint,
           REMOTE_CONTROL_AGENT_KEY_PATH:key};
async function start(program,args=[]) {
  const proc=spawn(program,args,{env,stdio:["ignore","ignore","pipe"]});
  child=proc;
  proc.stderr?.on("data",()=>{});
  proc.on("error",error=>{proc.spawnFailure=error});
  await new Promise((resolve,reject)=>{
    proc.once("spawn",resolve);
    proc.once("error",reject);
  });
  return proc;
}
async function waitExit(proc,timeout=15000,ignoreSpawnError=false) {
  let end=Date.now()+timeout;
  while(proc.exitCode===null && proc.signalCode===null){
    if(proc.spawnFailure && !ignoreSpawnError)throw proc.spawnFailure;
    if(Date.now()>end) throw Error("child exit timeout");
    await delay(50);
  }
  if(proc.spawnFailure && !ignoreSpawnError)throw proc.spawnFailure;
}
async function stop(proc){
  assert.equal(proc.kill("SIGTERM"),true);
  await waitExit(proc);
  assert.equal(proc.exitCode,0,"Agent must stop cleanly");
  child=undefined;
}
async function rpc(name,args){
  const response=await fetch(endpoint+"mcp",{method:"POST",redirect:"error",
    headers:{"content-type":"application/json",authorization:"Bearer "+token},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}),
    signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);
  const data=await response.json();
  assert.notEqual(data.result?.isError,true,JSON.stringify(data));
  const text=data.result.content[0].text;
  try{return JSON.parse(text)}catch{return text}
}
async function ready(proc,id){
  let end=Date.now()+35000;
  for(;;){
    if(proc.spawnFailure)throw proc.spawnFailure;
    if(proc.exitCode!==null || proc.signalCode!==null)throw Error("Agent exited before ready");
    const devices=await rpc("list_devices",{});
    const rows=Array.isArray(devices)?devices:devices.devices;
    if(rows?.some(d=>d.device_id===id&&d.status==="online"))return;
    if(Date.now()>end)throw Error("Agent did not come online");
    await delay(250);
  }
}
async function receiptReady(proc,id,operationId,expected) {
  const end=Date.now()+35000;
  for(;;){
    if(proc.spawnFailure)throw proc.spawnFailure;
    if(proc.exitCode!==null || proc.signalCode!==null)throw Error("Agent exited before receipt query");
    const result=await rpc("get_operation_status",{device_id:id,operation_id:operationId});
    if(result.status===expected)return result;
    if(!["offline","busy","unavailable"].includes(result.status))
      throw Error("Unexpected receipt status: "+result.status);
    if(Date.now()>end)throw Error("Agent receipt query did not become ready");
    await delay(250);
  }
}
async function upgrade(action){
  const socket=path.join(root,"upgrade.sock");
  return await new Promise((resolve,reject)=>{
    let text="";
    const s=net.createConnection(socket);
    s.setTimeout(3000,()=>s.destroy(Error("freeze timed out")));
    s.on("connect",()=>s.write(action+"\n"));
    s.on("data",d=>text+=d);
    s.on("end",()=>resolve(text));
    s.on("error",reject);
  });
}
try{
  const {mkdir}=await import("node:fs/promises");
  await mkdir(release,{mode:0o700});
  const extract=spawnSync("tar",["-xzf",archive,"-C",release],{stdio:"ignore"});
  assert.equal(extract.status,0,"extract pinned official release");
  const node=path.join(release,"bin/node"), app=path.join(release,"apps/remote-control-agent/src");
  const {newEnrollment}=await import(pathToFileURL(path.join(app,"v2-enrollment.js")));
  const enrollment=newEnrollment("isolated-handoff",undefined,"temporary");
  await writeFile(key,enrollment.privateKeyPem,{mode:0o600,flag:"wx"});
  const registration=await fetch(endpoint+"agent/pair/start",{method:"POST",redirect:"error",
    headers:{"content-type":"application/json"},body:JSON.stringify(enrollment.request),
    signal:AbortSignal.timeout(10000)});
  assert.equal(registration.status,202);
  const lookup=await rpc("pairing_lookup",{code:enrollment.code});
  const approved=await rpc("pairing_approve",{pairing_id:lookup.pairing_id,
    expected_fingerprint:lookup.fingerprint,expected_grant_type:"temporary"});
  assert.equal(approved.status,"approved");
  const id=approved.device_id;
  assert.match(id,/^[a-f0-9-]{36}$/);
  await writeFile(key+".device-id",id+"\n",{mode:0o600,flag:"wx"});
  const identityDigest=sha(await readFile(key));
  const candidateDir=path.join(root,"native");
  await mkdir(candidateDir,{mode:0o700});
  const native=path.join(candidateDir,"rca-standard-linux-candidate");
  await copyFile(rust,native);await chmod(native,0o700);
  const nativeHelper=path.join(candidateDir,"session-supervisor");
  await copyFile(supervisor,nativeHelper);await chmod(nativeHelper,0o700);

  let agent=await start(node,[path.join(app,"v2-main.js")]);
  await ready(agent,id);
  await receiptReady(agent,id,"handoff-probe-001","not_found");
  const first=path.join(root,"first.txt");
  const req1={device_id:id,operation_id:"handoff-node-001",path:first,content:"node-write",mode:"rewrite"};
  assert.equal((await rpc("write_file",req1)).status,"completed");
  assert.equal(await readFile(first,"utf8"),"node-write");
  const database=path.join(root,".local/state/mcp-workers/remote-control-agent/operation-receipts.sqlite");
  const originalDb=await stat(database);
  assert.equal(await upgrade("freeze"),"ready\n");
  assert.equal(await upgrade("verify-frozen"),"ready\n");
  await stop(agent);

  agent=await start(native);
  await ready(agent,id);
  await receiptReady(agent,id,req1.operation_id,"completed");
  await writeFile(first,"node-sentinel");
  assert.equal((await rpc("write_file",req1)).status,"completed");
  assert.equal(await readFile(first,"utf8"),"node-sentinel");
  assert.equal((await rpc("write_file",{...req1,content:"different"})).status,"conflict");
  assert.equal(await readFile(first,"utf8"),"node-sentinel");
  const rustDb=await stat(database);
  assert.equal(rustDb.dev,originalDb.dev);
  assert.equal(rustDb.ino,originalDb.ino);
  const second=path.join(root,"second.txt");
  const req2={device_id:id,operation_id:"handoff-rust-001",path:second,content:"rust-write",mode:"rewrite"};
  assert.equal((await rpc("write_file",req2)).status,"completed");
  assert.equal(await readFile(second,"utf8"),"rust-write");
  assert.equal(await upgrade("freeze"),"ready\n");
  await stop(agent);

  const broken=path.join(root,"broken");
  await mkdir(broken,{mode:0o700});
  const badNative=path.join(broken,"rca-standard-linux-candidate");
  await copyFile(rust,badNative);await chmod(badNative,0o700);
  const failed=await start(process.env.RCA_HANDOFF_TEST_SPAWN_FAILURE==="1"
    ? path.join(broken,"missing-binary") : badNative);
  await waitExit(failed);
  assert.notEqual(failed.exitCode,0,"missing Supervisor must fail closed");
  child=undefined;

  agent=await start(node,[path.join(app,"v2-main.js")]);
  await ready(agent,id);
  await receiptReady(agent,id,req2.operation_id,"completed");
  await writeFile(second,"rust-sentinel");
  assert.equal((await rpc("write_file",req2)).status,"completed");
  assert.equal(await readFile(second,"utf8"),"rust-sentinel");
  assert.equal((await rpc("write_file",{...req2,content:"different"})).status,"conflict");
  assert.equal(await readFile(second,"utf8"),"rust-sentinel");
  const restoredDb=await stat(database);
  assert.equal(restoredDb.dev,originalDb.dev);
  assert.equal(restoredDb.ino,originalDb.ino);
  assert.equal(sha(await readFile(key)),identityDigest,"identity preserved");
  assert.equal((await readFile(key+".device-id","utf8")).trim(),id);
  await stop(agent);
  console.log("NODE_RUST_FAILED_START_NODE_HANDOFF_PASS");
}finally{
  if(child?.pid && child.exitCode===null && child.signalCode===null){
    child.kill("SIGTERM");
    try{await waitExit(child,3000,true)}catch{child.kill("SIGKILL");await waitExit(child,3000,true)}
  }
  await rm(root,{recursive:true,force:true});
}
