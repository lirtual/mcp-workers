import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve(dir,"..");
const persistence=fs.mkdtempSync(path.join(os.tmpdir(),"spec418-workerd-"));
const port = 18984;
const origin = "http://127.0.0.1:"+port;
const extensionOrigin = "chrome-extension://"+"a".repeat(32);
const bearer = "local-fixture-token";
const child = spawn(path.join(cwd,"node_modules/.bin/wrangler"),
  ["dev","--local","--port",String(port),"--ip","127.0.0.1","--persist-to",persistence],{
    cwd,detached:true,env:{...process.env,MCP_ACCESS_TOKEN:bearer},stdio:["ignore","pipe","pipe"]
  });
let output="";
child.stdout.on("data",b=>{output+=String(b).slice(0,5000);});
child.stderr.on("data",b=>{output+=String(b).slice(0,5000);});
const cleanup=()=>{
  if(child.pid){try{process.kill(-child.pid,"SIGTERM");}catch{}}
};
process.on("exit",cleanup);
async function ready() {
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw Error("workerd ended: "+output.slice(-1500));
    try {const r=await fetch(origin+"/");if(r.status===404)return;}
    catch{}
    await sleep(250);
  }
  throw Error("workerd startup unavailable: "+output.slice(-1500));
}
async function rpc(name,args={},authorization=bearer){
  const r=await fetch(origin+"/mcp",{method:"POST",headers:{
    authorization:"Bearer "+authorization,"content-type":"application/json"
  },body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
  if(!r.ok)return {status:r.status};
  const j=await r.json();
  return {status:r.status,value:j.result?.content?.[0]?.text?JSON.parse(j.result.content[0].text):j,
    isError:j.result?.isError};
}
async function extension(route,payload){
  const r=await fetch(origin+"/extension/"+route,{method:"POST",headers:{
    origin:extensionOrigin,"content-type":"application/json"
  },body:JSON.stringify(payload)});
  return {status:r.status,body:await r.json()};
}
try{
  await ready();
  const bad=await rpc("browser_pair",{},"bad-token");
  assert.equal(bad.status,401);
  const pair=await rpc("browser_pair");
  assert.equal(pair.isError,false,"pair create failed");
  assert.match(pair.value.pairing_code,/^[a-f0-9]{24}$/);
  const code=pair.value.pairing_code;
  const claimed=await extension("claim",{code,alias:"local-test-profile"});
  assert.equal(claimed.status,200,"claim failed");
  const {endpoint_id,credential}=claimed.body;
  assert.match(endpoint_id,/^[0-9a-f-]{36}$/);
  assert.match(credential,/^[a-f0-9]{64}$/);
  assert.equal(claimed.body.authorization,"stopped");
  const emptyActivity=await extension("summary",{endpoint_id,credential});
  assert.equal(emptyActivity.status,200);
  assert.deepEqual(emptyActivity.body,{pending:0,unknown:0});
  assert.equal((await extension("summary",{endpoint_id,credential:"f".repeat(64)})).status,401);
  const missingOperation=await rpc("browser_operation_status",{endpoint_id,
    intent_key:"019a2b3c-4d5e-7aaa-8bbb-1234567890ab"});
  assert.equal(missingOperation.isError,true);
  assert.equal(missingOperation.value.error_code,"not_found");
  const invalidOperation=await rpc("browser_operation_status",{endpoint_id,intent_key:"wrong",extraneous:true});
  assert.equal(invalidOperation.isError,true);
  assert.equal(invalidOperation.value.error_code,"invalid_arguments");
  const replay=await extension("claim",{code,alias:"stolen-profile"});
  assert.equal(replay.status,403);
  const listed=await rpc("browser_endpoints");
  const item=listed.value.endpoints.find(e=>e.endpoint_id===endpoint_id);
  assert.equal(item?.authorization,"stopped");
  assert.equal(item?.online,false);
  assert.equal(item?.control_ready,false);
  const badResume=await extension("resume",{endpoint_id,credential:"f".repeat(64)});
  assert.equal(badResume.status,401);
  const resume=await extension("resume",{endpoint_id,credential});
  assert.equal(resume.status,200);
  assert.equal(resume.body.authorization,"enabled");
  const invalid=await websocket(port);
  invalid.send({type:"authenticate",protocol:1,extension_version:"0.0.0",endpoint_id,credential});
  assert.equal((await invalid.receive()).type,"close");
  invalid.close();
  const noAuth=await websocket(port);
  noAuth.send({type:"ping"});
  assert.equal((await noAuth.receive()).type,"close");
  noAuth.close();
  const first=await websocket(port);
  first.send({type:"authenticate",protocol:1,extension_version:"0.1.0",endpoint_id,credential});
  const one=await first.receive();
  assert.equal(one.type,"authenticated");
  assert.equal(one.generation,1);
  const second=await websocket(port);
  second.send({type:"authenticate",protocol:1,extension_version:"0.1.0",endpoint_id,credential});
  const two=await second.receive();
  assert.equal(two.type,"authenticated");
  assert.equal(two.generation,2);
  const superseded=await first.receive();
  assert.equal(superseded.type,"close");
  second.send({type:"ping",generation:2});
  assert.equal((await second.receive()).type,"pong");
  const readFuture=rpc("browser_tabs",{endpoint_id});
  const request=await second.receive();
  assert.equal(request.type,"read_request");
  assert.equal(request.tool,"tabs");
  assert.equal(request.generation,2);
  second.send({type:"read_result",request_id:request.request_id,generation:2,
    data:{tabs:[{tab_id:15,window_id:1,origin:"https://example.com",active:false}],truncated:false}});
  const readResult=await readFuture;
  assert.equal(readResult.value.tabs[0].tab_id,15);
  const snapshotFuture=rpc("browser_snapshot",{endpoint_id,tab_id:15});
  const request2=await second.receive();
  assert.equal(request2.type,"read_request");
  assert.equal(request2.tab_id,15);
  second.send({type:"read_result",request_id:request2.request_id,generation:2,
    data:{tab_id:15,document_id:"doc-123",frame_id:0,text:"Safe public text",truncated:false}});
  const snapResult=await snapshotFuture;
  assert.equal(snapResult.value.text,"Safe public text");
  const imageFuture=rpc("browser_screenshot",{endpoint_id,tab_id:15});
  const screenshotRequest=await second.receive();
  assert.equal(screenshotRequest.type,"read_request");
  assert.equal(screenshotRequest.tool,"screenshot");
  assert.equal(screenshotRequest.tab_id,15);
  second.send({type:"read_result",request_id:screenshotRequest.request_id,generation:2,
    data:{tab_id:15,document_id:"doc-123",frame_id:0,
      data_url:"data:image/png;base64,ZmFrZQ=="}});
  const imageResult=await imageFuture;
  assert.match(imageResult.value.data_url,/^data:image\/png;base64,/);
  const online=await rpc("browser_endpoints");
  assert.equal(online.value.endpoints.find(e=>e.endpoint_id===endpoint_id).online,true);
  assert.equal(online.value.endpoints.find(e=>e.endpoint_id===endpoint_id).control_ready,true);
  // Read-only through the real MCP -> SQLite DO -> authenticated WSS path.
  const tabPending=rpc("browser_tabs",{endpoint_id});
  const tabCommand=await second.receive();
  assert.equal(tabCommand.type,"read_request");
  assert.equal(tabCommand.tool,"tabs");
  assert.equal(tabCommand.generation,2);
  // No mutation may be admitted while a read is in flight on this Endpoint.
  const busyStamp=Date.now().toString(16).padStart(12,"0");
  const busyIntent=busyStamp.slice(0,8)+"-"+busyStamp.slice(8)+"-7000-8000-0000000000a1";
  const mutateWhileReading=await rpc("browser_tab_open",{endpoint_id,intent_key:busyIntent,url:"https://example.com/not-executed"});
  assert.equal(mutateWhileReading.value.error_code,"busy","an in-flight read must block a new mutation");
  const conflicting=await rpc("browser_tabs",{endpoint_id});
  assert.equal(conflicting.value.error_code,"busy");
  second.send({type:"read_result",request_id:tabCommand.request_id,generation:2,
    data:{tabs:[{tab_id:57,window_id:1,origin:"https://example.org",active:false}],truncated:false}});
  const tabsReply=await tabPending;
  assert.equal(tabsReply.isError,false);
  assert.equal(tabsReply.value.tabs[0].tab_id,57);
  const snapshotPending=rpc("browser_snapshot",{endpoint_id,tab_id:57});
  const snapshotCommand=await second.receive();
  assert.equal(snapshotCommand.tool,"snapshot");
  assert.equal(snapshotCommand.tab_id,57);
  second.send({type:"read_result",request_id:snapshotCommand.request_id,generation:2,
    data:{tab_id:57,document_id:"document-v1",frame_id:0,text:"Non-sensitive public text",truncated:false}});
  const snapshotReply=await snapshotPending;
  assert.equal(snapshotReply.isError,false);
  assert.equal(snapshotReply.value.document_id,"document-v1");
  const screenshotPending=rpc("browser_screenshot",{endpoint_id,tab_id:57});
  const screenshotCommand=await second.receive();
  assert.equal(screenshotCommand.tool,"screenshot");
  const screenshotData="data:image/png;base64,"+"A".repeat(300000);
  second.send({type:"read_result",request_id:screenshotCommand.request_id,generation:2,
    data:{tab_id:57,document_id:"document-v1",frame_id:0,data_url:screenshotData}});
  const screenshotReply=await screenshotPending;
  assert.equal(screenshotReply.isError,false);
  assert.equal(screenshotReply.value.data_url.length,screenshotData.length);
  // Public MCP -> SQLite DO -> authenticated WSS prepare -> single execute token.
  const uuid7=(ms,tail=0)=>{
    const stamp=ms.toString(16).padStart(12,"0");
    return stamp.slice(0,8)+"-"+stamp.slice(8)+"-7000-8000-"+tail.toString(16).padStart(12,"0");
  };
  const openKey=uuid7(Date.now(),1);
  const openCommand={endpoint_id,intent_key:openKey,url:"https://example.com/start"};
  const admittedFuture=rpc("browser_tab_open",openCommand);
  const admitted=await admittedFuture;
  assert.equal(admitted.isError,false,JSON.stringify(admitted.value));
  const prepared=await second.receive();
  assert.equal(prepared.type,"prepare_request");
  assert.equal(prepared.command.action,"tab_open");
  assert.equal(prepared.command.url,openCommand.url);
  assert.equal(prepared.generation,2);
  assert.equal(admitted.value.state,"admitted");
  assert.equal(admitted.value.operation_id,prepared.operation_id);
  const readWhilePreparing=await rpc("browser_tabs",{endpoint_id});
  assert.equal(readWhilePreparing.value.error_code,"busy","an in-flight prepare must block a new read");
  const replayIntent=await rpc("browser_tab_open",openCommand);
  assert.equal(replayIntent.value.operation_id,prepared.operation_id);
  assert.equal((await rpc("browser_tab_open",{...openCommand,url:"https://example.com/different"})).value.error_code,"intent_conflict");
  second.send({type:"prepare_result",operation_id:prepared.operation_id,intent_key:openKey,generation:2,accepted:true});
  const execution=await second.receive();
  assert.equal(execution.type,"execute_request");
  assert.equal(execution.operation_id,prepared.operation_id);
  assert.match(execution.execute_token,/^[a-f0-9]{64}$/);
  const dispatched=await rpc("browser_operation_status",{endpoint_id,intent_key:openKey});
  assert.equal(dispatched.value.state,"dispatching");
  assert.deepEqual((await extension("summary",{endpoint_id,credential})).body,{pending:1,unknown:0});
  // A second intent cannot dispatch concurrently on this Endpoint.
  const concurrent=await rpc("browser_tab_open",{endpoint_id,intent_key:uuid7(Date.now(),2),url:"https://example.com/next"});
  assert.equal(concurrent.value.error_code,"busy");
  second.send({type:"execute_result",operation_id:prepared.operation_id,intent_key:openKey,
    execute_token:execution.execute_token,generation:2,state:"completed",tab_id:101,
    presentation_warning:"tab_group_unavailable"});
  let complete;
  for(let i=0;i<30;i++){
    complete=await rpc("browser_operation_status",{endpoint_id,intent_key:openKey});
    if(complete.value.state==="completed")break;
    await sleep(30);
  }
  assert.equal(complete.value.state,"completed");
  assert.equal(complete.value.tab_id,101);
  assert.equal(complete.value.presentation_warning,"tab_group_unavailable");
  assert.deepEqual((await extension("summary",{endpoint_id,credential})).body,{pending:0,unknown:0});
  // A failed prepare is definitely not executed. Stop after dispatch is conservative Unknown.
  const deniedKey=uuid7(Date.now(),3);
  const deniedFuture=rpc("browser_tab_navigate",{endpoint_id,intent_key:deniedKey,
    tab_id:101,document_id:"doc-101",url:"https://example.com/safe"});
  const deniedOutcome=await deniedFuture;
  assert.equal(deniedOutcome.isError,false);
  const deniedPrepare=await second.receive();
  assert.equal(deniedPrepare.type,"prepare_request");
  second.send({type:"prepare_result",operation_id:deniedPrepare.operation_id,intent_key:deniedKey,generation:2,accepted:false});
  let deniedReceipt;
  for(let i=0;i<30;i++){
    deniedReceipt=await rpc("browser_operation_status",{endpoint_id,intent_key:deniedKey});
    if(deniedReceipt.value.state==="failed")break;
    await sleep(30);
  }
  assert.equal(deniedReceipt.value.state,"failed");
  const unknownKey=uuid7(Date.now(),4);
  const unknownFuture=rpc("browser_tab_close",{endpoint_id,intent_key:unknownKey,
    tab_id:101,document_id:"doc-101"});
  const unknownPrepare=await second.receive();
  assert.equal(unknownPrepare.type,"prepare_request");
  await unknownFuture;
  second.send({type:"prepare_result",operation_id:unknownPrepare.operation_id,intent_key:unknownKey,generation:2,accepted:true});
  const unknownExecution=await second.receive();
  assert.equal(unknownExecution.type,"execute_request");
  // A claimed completed receipt with no tab identity is not valid confirmation.
  second.send({type:"execute_result",operation_id:unknownPrepare.operation_id,intent_key:unknownKey,
    execute_token:unknownExecution.execute_token,generation:2,state:"completed",tab_id:null});
  await sleep(100);
  const rejectedReceipt=await rpc("browser_operation_status",{endpoint_id,intent_key:unknownKey});
  assert.equal(rejectedReceipt.value.state,"dispatching","missing tab ID must never mark completion");
  // No valid completion receipt: Stop must conservatively transition to Unknown.
  const stop=await rpc("browser_stop",{endpoint_id});
  const pushed=await second.receive();
  assert.equal(pushed.type,"stopped");
  first.close();second.close();
  assert.equal(stop.value.authorization,"stopped");
  const unknownReceipt=await rpc("browser_operation_status",{endpoint_id,intent_key:unknownKey});
  assert.equal(unknownReceipt.value.state,"unknown");
  assert.deepEqual((await extension("summary",{endpoint_id,credential})).body,{pending:0,unknown:1});
  const unknownReplay=await rpc("browser_tab_close",{endpoint_id,intent_key:unknownKey,
    tab_id:101,document_id:"doc-101"});
  assert.equal(unknownReplay.value.operation_id,unknownReceipt.value.operation_id);
  assert.equal(unknownReplay.value.state,"unknown");
  const stopped=await extension("state",{endpoint_id,credential});
  assert.equal(stopped.body.authorization,"stopped");
  const beforeRepeat=(await rpc("browser_endpoints")).value.endpoints.find(e=>e.endpoint_id===endpoint_id).updated_at;
  await sleep(10);
  const repeatedStop=await rpc("browser_stop",{endpoint_id});
  assert.equal(repeatedStop.value.authorization,"stopped");
  const afterRepeat=(await rpc("browser_endpoints")).value.endpoints.find(e=>e.endpoint_id===endpoint_id).updated_at;
  assert.equal(afterRepeat,beforeRepeat,"repeated Stop must not change grant state version");
  const revoked=await rpc("browser_revoke",{endpoint_id});
  assert.equal(revoked.value.authorization,"revoked");
  assert.equal((await extension("summary",{endpoint_id,credential})).status,401);
  const again=await rpc("browser_revoke",{endpoint_id});
  assert.equal(again.value.authorization,"revoked");
  const pairOther=await rpc("browser_pair");
  const other=await extension("claim",{code:pairOther.value.pairing_code,alias:"independent-profile"});
  assert.equal(other.status,200);
  assert.notEqual(other.body.endpoint_id,endpoint_id);
  assert.equal((await extension("state",{endpoint_id:other.body.endpoint_id,credential})).status,401);
  assert.equal((await extension("state",{endpoint_id:other.body.endpoint_id,credential:other.body.credential})).body.authorization,"stopped");
  // Revoke before the prepared operation is dispatched: no execute may be sent.
  const otherId=other.body.endpoint_id;
  assert.equal((await extension("resume",{endpoint_id:otherId,credential:other.body.credential})).status,200);
  const otherSocket=await websocket(port);
  otherSocket.send({type:"authenticate",protocol:1,extension_version:"0.1.0",endpoint_id:otherId,credential:other.body.credential});
  assert.equal((await otherSocket.receive()).type,"authenticated");
  const revokedBeforeKey=uuid7(Date.now(),5);
  const waiting=await rpc("browser_tab_open",{endpoint_id:otherId,intent_key:revokedBeforeKey,url:"https://example.com/will-not-open"});
  assert.equal(waiting.value.state,"admitted");
  const preparedBeforeRevoke=await otherSocket.receive();
  assert.equal(preparedBeforeRevoke.type,"prepare_request");
  assert.equal((await rpc("browser_revoke",{endpoint_id:otherId})).value.authorization,"revoked");
  assert.equal((await otherSocket.receive()).type,"revoked");
  otherSocket.close();
  const afterRevoke=await rpc("browser_operation_status",{endpoint_id:otherId,intent_key:revokedBeforeKey});
  assert.equal(afterRevoke.value.state,"failed","pre-dispatch revocation must not be Unknown");
  const afterRevokeReplay=await rpc("browser_tab_open",{endpoint_id:otherId,intent_key:revokedBeforeKey,url:"https://example.com/will-not-open"});
  assert.equal(afterRevokeReplay.value.operation_id,afterRevoke.value.operation_id);
  assert.equal(afterRevokeReplay.value.state,"failed");
  const denied=await extension("resume",{endpoint_id,credential});
  assert.equal(denied.status,403);
  console.log("PASS workerd: bearer, one-time pairing, independent Profiles, WSS generations, read routing/busy, Stop and Revoke");
}catch(e){
  console.error("FAIL workerd integration:",e.stack||e.message);
  console.error(output.slice(-2500).replaceAll(bearer,"[redacted]"));
  process.exitCode=1;
}finally{
  const exiting=once(child,"exit").catch(()=>{});
  cleanup();
  await Promise.race([exiting,sleep(2500)]);
  fs.rmSync(persistence,{recursive:true,force:true,maxRetries:3,retryDelay:100});
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
