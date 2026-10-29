// Spec #418 T3: isolated REAL workerd process restart with the same SQLite DO storage.
// Tests conservative recovery, never an actual Cloudflare DO hibernation guarantee.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {setTimeout as sleep} from "node:timers/promises";

const cwd=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const state=fs.mkdtempSync(path.join(os.tmpdir(),"spec418-restart-"));
const port=18983, origin="http://127.0.0.1:"+port, bearer="restart-test-bearer";
const extensionOrigin="chrome-extension://"+"a".repeat(32);
let child=null, logs="";
function start(){
  if(child)throw Error("Worker already running");
  logs="";
  child=spawn(path.join(cwd,"node_modules/.bin/wrangler"),
    ["dev","--local","--port",String(port),"--ip","127.0.0.1","--persist-to",state],{
    cwd,detached:true,stdio:["ignore","pipe","pipe"],
    env:{...process.env,MCP_ACCESS_TOKEN:bearer}
  });
  child.stdout.on("data",s=>logs=(logs+String(s)).slice(-5000));
  child.stderr.on("data",s=>logs=(logs+String(s)).slice(-5000));
}
async function stop(){
  const current=child;child=null;
  if(!current)return;
  if(current.exitCode===null && current.signalCode===null){
    const exited=once(current,"exit").catch(()=>{});
    try{process.kill(-current.pid,"SIGTERM");}catch{}
    await Promise.race([exited,sleep(2500)]);
    if(current.exitCode===null&&current.signalCode===null){
      try{process.kill(-current.pid,"SIGKILL");}catch{}
      await Promise.race([exited,sleep(2000)]);
    }
  }
  // Remove the old connection process before a new local workerd binds this port.
  for(let i=0;i<25;i++){
    try{await fetch(origin+"/",{signal:AbortSignal.timeout(200)});}
    catch{return;}
    await sleep(80);
  }
  throw Error("Prior test workerd still bound after explicit stop");
}
process.on("exit",()=>{
  if(child?.pid){try{process.kill(-child.pid,"SIGTERM");}catch{}}
});
async function ready(){
  for(let i=0;i<100;i++){
    if(child?.exitCode!==null)throw Error("Local worker exited: "+logs.slice(-1200));
    try{
      const r=await fetch(origin+"/",{signal:AbortSignal.timeout(400)});
      if(r.status===404)return;
    }catch{}
    await sleep(180);
  }
  throw Error("Local workerd unavailable: "+logs.slice(-1500));
}
async function rpc(name,args={}){
  const r=await fetch(origin+"/mcp",{
    method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}),
    signal:AbortSignal.timeout(5000)
  });
  assert.equal(r.status,200,name+" transport");
  const answer=(await r.json()).result;
  return {value:JSON.parse(answer.content[0].text),error:answer.isError};
}
async function extension(route,data){
  const r=await fetch(origin+"/extension/"+route,{
    method:"POST",headers:{origin:extensionOrigin,"content-type":"application/json"},
    body:JSON.stringify(data),signal:AbortSignal.timeout(5000)
  });
  return {status:r.status,value:await r.json()};
}
const uuid7=(tail=0)=>{
  const stamp=Date.now().toString(16).padStart(12,"0");
  return stamp.slice(0,8)+"-"+stamp.slice(8)+"-7000-8000-"+tail.toString(16).padStart(12,"0");
};
async function endpoint(){
  const one=await rpc("browser_pair");
  assert.equal(one.error,false);
  const claimed=await extension("claim",{code:one.value.pairing_code,alias:"restart-isolated"});
  assert.equal(claimed.status,200);
  const {endpoint_id,credential}=claimed.value;
  const resumed=await extension("resume",{endpoint_id,credential});
  assert.equal(resumed.status,200);
  return {endpoint_id,credential};
}
try{
  start();await ready();
  const a=await endpoint(), b=await endpoint();
  const wa=await websocket(port),wb=await websocket(port);
  wa.send({type:"authenticate",protocol:1,extension_version:"0.1.0",...a});
  wb.send({type:"authenticate",protocol:1,extension_version:"0.1.0",...b});
  const authA=await wa.receive(),authB=await wb.receive();
  assert.equal(authA.type,"authenticated");
  assert.equal(authB.type,"authenticated");
  const keyA=uuid7(1),keyB=uuid7(2);
  const argsA={endpoint_id:a.endpoint_id,intent_key:keyA,url:"https://example.com/restart-controlled"};
  const argsB={endpoint_id:b.endpoint_id,intent_key:keyB,url:"https://example.com/prepare-only"};
  const admittedA=await rpc("browser_tab_open",argsA);
  const admittedB=await rpc("browser_tab_open",argsB);
  assert.equal(admittedA.value.state,"admitted");
  assert.equal(admittedB.value.state,"admitted");
  const prepA=await wa.receive(), prepB=await wb.receive();
  assert.equal(prepA.type,"prepare_request");
  assert.equal(prepB.type,"prepare_request");
  wa.send({type:"prepare_result",operation_id:prepA.operation_id,intent_key:keyA,
    generation:authA.generation,accepted:true});
  const execute=await wa.receive();
  assert.equal(execute.type,"execute_request");
  assert.equal(execute.operation_id,prepA.operation_id);
  assert.match(execute.execute_token,/^[a-f0-9]{64}$/);
  // NO execute_result: the effect might have happened and must remain Unknown.
  const before=await rpc("browser_operation_status",{endpoint_id:a.endpoint_id,intent_key:keyA});
  assert.equal(before.value.state,"dispatching");
  const beforePrepared=await rpc("browser_operation_status",{endpoint_id:b.endpoint_id,intent_key:keyB});
  assert.equal(beforePrepared.value.state,"admitted");
  wa.close();wb.close();
  await stop();
  start();await ready();
  const unknown=await rpc("browser_operation_status",{endpoint_id:a.endpoint_id,intent_key:keyA});
  assert.equal(unknown.value.state,"unknown");
  assert.equal(unknown.value.operation_id,admittedA.value.operation_id);
  const replay=await rpc("browser_tab_open",argsA);
  assert.equal(replay.value.operation_id,admittedA.value.operation_id);
  assert.equal(replay.value.state,"unknown");
  assert.equal((await rpc("browser_tab_open",{...argsA,url:"https://example.com/changed"})).value.error_code,"intent_conflict");
  const activity=await extension("summary",a);
  assert.deepEqual(activity.value,{pending:0,unknown:1});
  const listing=await rpc("browser_endpoints");
  const stored=listing.value.endpoints.find(e=>e.endpoint_id===a.endpoint_id);
  assert.equal(stored.authorization,"enabled");
  assert.equal(stored.online,false);
  // New WSS generation: never retransmit old execute.
  const fresh=await websocket(port);
  fresh.send({type:"authenticate",protocol:1,extension_version:"0.1.0",...a});
  const authenticated=await fresh.receive();
  assert.equal(authenticated.type,"authenticated");
  assert.equal(authenticated.generation,authA.generation+1);
  fresh.send({type:"ping",generation:authenticated.generation});
  assert.equal((await fresh.receive()).type,"pong","recreated owner must not retransmit execute");
  assert.equal((await rpc("browser_operation_status",{endpoint_id:a.endpoint_id,intent_key:keyA})).value.state,"unknown");
  // Recovery of prepared-but-never-dispatched has no possible website effect.
  // Reusing an admitted key cannot dispatch it again, even if still within admission window.
  const replayB=await rpc("browser_tab_open",argsB);
  assert.equal(replayB.value.operation_id,admittedB.value.operation_id);
  // A slow local process restart can exceed the 8-second prepare deadline.
  // Either state is valid here; neither can cause an execute retransmission.
  assert.ok(["admitted","failed"].includes(replayB.value.state),
    "recovered prepare must never become dispatched");
  if(replayB.value.state==="admitted")await sleep(8500);
  const prepareExpired=await rpc("browser_operation_status",{endpoint_id:b.endpoint_id,intent_key:keyB});
  assert.equal(prepareExpired.value.state,"failed");
  const lateReplay=await rpc("browser_tab_open",argsB);
  assert.equal(lateReplay.value.state,"failed");
  assert.equal(lateReplay.value.operation_id,admittedB.value.operation_id);
  const finalUnknown=await rpc("browser_operation_status",{endpoint_id:a.endpoint_id,intent_key:keyA});
  assert.equal(finalUnknown.value.state,"unknown");
  fresh.close();
  console.log("PASS restart recovery: original dispatch stays Unknown, no automatic execute, original key reused, unused prepare expires Failed, stored grant survives; local process restart (not Cloudflare hibernation)");
}catch(error){
  console.error("FAIL restart recovery:",error.stack||error);
  console.error(logs.slice(-1300).replaceAll(bearer,"[redacted]"));
  process.exitCode=1;
}finally{
  try{await stop();}catch(e){console.error("cleanup stop:",e.message);process.exitCode=1;}
  fs.rmSync(state,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
async function websocket(port) {
  const net=await import("node:net");
  const socket=net.connect(port,"127.0.0.1");
  const key=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const frames=[];let waiter=null,header="",upgraded=false,buffer=Buffer.alloc(0);
  let resolveOpen,rejectOpen;
  const opened=new Promise((resolve,reject)=>{resolveOpen=resolve;rejectOpen=reject;});
  socket.once("connect",()=>socket.write([
    "GET /extension/socket HTTP/1.1", "Host: 127.0.0.1:"+port,
    "Upgrade: websocket","Connection: Upgrade","Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Key: "+key,"Origin: chrome-extension://"+"a".repeat(32),"",""
  ].join("\r\n")));
  function consume() {
    while(buffer.length>=2) {
      const kind=buffer[0]&0x0f;let size=buffer[1]&0x7f,offset=2;
      if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}
      if(size===127){if(buffer.length<10)return;size=Number(buffer.readBigUInt64BE(2));offset=10;}
      if(size>1048576)throw Error("unexpected oversized WS frame");
      if(buffer.length<offset+size)return;
      const data=buffer.subarray(offset,offset+size);
      buffer=buffer.subarray(offset+size);
      const frame=kind===1?JSON.parse(data.toString()):{type:kind===8?"close":"other"};
      if(waiter){const f=waiter;waiter=null;f(frame);} else frames.push(frame);
    }
  }
  socket.on("data",data=>{
    buffer=Buffer.concat([buffer,data]);
    if(!upgraded){
      const i=buffer.indexOf("\r\n\r\n");
      if(i<0)return;
      header=buffer.subarray(0,i).toString();buffer=buffer.subarray(i+4);
      if(!header.startsWith("HTTP/1.1 101")){rejectOpen(Error("WS upgrade refused: "+header.slice(0,120)));return;}
      upgraded=true;resolveOpen();
    }
    consume();
  });
  socket.on("error",error=>rejectOpen(error));
  await opened;
  return {
    send(value) {
      const body=Buffer.from(JSON.stringify(value));const mask=Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
      let head;if(body.length<=125){head=Buffer.from([0x81,0x80|body.length]);}
      else if(body.length<=65535){head=Buffer.alloc(4);head[0]=0x81;head[1]=0xfe;head.writeUInt16BE(body.length,2);}
      else {head=Buffer.alloc(10);head[0]=0x81;head[1]=0xff;head.writeBigUInt64BE(BigInt(body.length),2);}
      const masked=Buffer.from(body);for(let i=0;i<masked.length;i++)masked[i]^=mask[i%4];
      socket.write(Buffer.concat([head,mask,masked]));
    },
    async receive(){if(frames.length)return frames.shift();return Promise.race([
      new Promise(resolve=>{waiter=resolve;}),sleep(3000).then(()=>{throw Error("WS response timeout");})
    ]);},
    close(){socket.destroy();}
  };
}
