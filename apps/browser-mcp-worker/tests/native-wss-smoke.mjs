// Isolated Windows Chrome/Edge -> local HTTPS/WSS -> workerd -> extension lifecycle.
// Developer-only test: temporary browser Profile and ephemeral TLS key, no production.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { X509Certificate,createHash,randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const [exe,source,certPath,keyPath]=process.argv.slice(2);
if(process.platform!=="win32"||![exe,source,certPath,keyPath].every(Boolean))
  throw Error("Use Windows node with browser.exe extension-dir temporary-cert temporary-key");
const backend="http://127.0.0.1:18985";
const host="spec418-gateway.example",fixtureHost="spec418-test.example",port=18743;
const service="https://"+host+":"+port;
const root=fs.mkdtempSync(path.join(os.tmpdir(),"spec418-realwss-"));
const profile=path.join(root,"profile"),extension=path.join(root,"extension");
fs.cpSync(source,extension,{recursive:true});
fs.writeFileSync(path.join(extension,"config.js"),
  "const BROWSER_MCP_SERVICE_ORIGIN = "+JSON.stringify(service)+";\n");
const cert=fs.readFileSync(certPath),key=fs.readFileSync(keyPath);
const fingerprint=createHash("sha256").update(
  new X509Certificate(cert).publicKey.export({type:"spki",format:"der"})).digest("base64");
const trackedSockets=new Set();
const gateway=https.createServer({key,cert},(req,res)=>{
  const up=http.request({host:"127.0.0.1",port:18985,path:req.url,method:req.method,
    headers:{...req.headers,host:"127.0.0.1:18985"}},response=>{
    res.writeHead(response.statusCode,response.headers);response.pipe(res);
  });
  up.on("error",()=>{res.writeHead(502);res.end();});
  req.pipe(up);
});
gateway.on("upgrade",(req,socket,head)=>{
  trackedSockets.add(socket);socket.on("close",()=>trackedSockets.delete(socket));
  const upstream=net.connect(18985,"127.0.0.1");
  trackedSockets.add(upstream);upstream.on("close",()=>trackedSockets.delete(upstream));
  upstream.on("connect",()=>{
    const hdr=req.rawHeaders.map((v,i)=>i%2===0?v+": "+req.rawHeaders[i+1]+"\r\n":null)
      .filter(Boolean).join("");
    upstream.write(req.method+" "+req.url+" HTTP/1.1\r\n"+hdr+"\r\n");
    if(head.length)upstream.write(head);
    socket.pipe(upstream);upstream.pipe(socket);
  });
  socket.on("error",()=>upstream.destroy());
  upstream.on("error",()=>socket.destroy());
});
const fixture=http.createServer((req,res)=>{
  res.writeHead(200,{"content-type":"text/html;charset=utf-8","cache-control":"no-store"});
  res.end(req.url==="/clean" ? "<!doctype html><title>Clean</title><h1>Clean browser 418 fixture</h1>" :
    req.url==="/next" ? "<!doctype html><title>Next</title><h1>Navigated browser 418 fixture</h1>" :
    "<!doctype html><title>Sensitive</title><h1>Observed browser 418 fixture</h1><input type=password value=secret-must-not-leak>");
});
await Promise.all([
  new Promise(resolve=>gateway.listen(port,"127.0.0.1",resolve)),
  new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve))
]);
const fixtureOrigin="http://"+fixtureHost+":"+fixture.address().port;
const browser=spawn(exe,[
  "--headless=new","--no-first-run","--no-default-browser-check",
  "--disable-background-networking","--disable-sync","--disable-component-update",
  "--remote-debugging-pipe","--enable-unsafe-extension-debugging","--no-proxy-server",
  "--host-resolver-rules=MAP spec418-gateway.example 127.0.0.1, MAP spec418-test.example 127.0.0.1",
  "--ignore-certificate-errors-spki-list="+fingerprint,
  "--user-data-dir="+profile,"about:blank"
],{stdio:["ignore","pipe","pipe","pipe","pipe"],windowsHide:true});
let stderr="";
browser.stderr.on("data",d=>stderr=(stderr+String(d)).slice(-1500));
const pending=new Map();let seq=0,buffer=Buffer.alloc(0);
browser.stdio[4].on("data",d=>{
  buffer=Buffer.concat([buffer,d]);let cut;
  while((cut=buffer.indexOf(0))>=0){
    const frame=buffer.subarray(0,cut);buffer=buffer.subarray(cut+1);
    if(!frame.length)continue;
    let obj;try{obj=JSON.parse(frame.toString("utf8"));}catch{continue;}
    if(pending.has(obj.id)){const done=pending.get(obj.id);pending.delete(obj.id);done(obj);}
  }
});
function cdp(method,params={},sessionId,timeout=12000){
  const id=++seq;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+": timeout"));},timeout);
    pending.set(id,response=>{
      clearTimeout(timer);
      if(response.error)reject(Error(method+": "+JSON.stringify(response.error)));
      else resolve(response.result);
    });
    browser.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+"\0");
  });
}
async function retry(fn,attempts=40){
  let last;for(let i=0;i<attempts;i++){
    try{return await fn();}catch(e){last=e;await sleep(250);}
  }throw last;
}
async function mcp(name,args={}){
  const response=await fetch(backend+"/mcp",{method:"POST",headers:{
    authorization:"Bearer local_fixture_418_not_production",
    "content-type":"application/json"
  },body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
  if(!response.ok)throw Error("MCP HTTP "+response.status);
  const value=(await response.json()).result;
  return {data:JSON.parse(value.content[0].text),error:value.isError};
}
function uuid7(){
  const stamp=Date.now().toString(16).padStart(12,"0");
  return stamp.slice(0,8)+"-"+stamp.slice(8)+"-7000-8000-"+randomBytes(6).toString("hex");
}
async function awaitMutation(name,args){
  const intent_key=uuid7();
  const submitted=await mcp(name,{...args,intent_key});
  if(submitted.error)throw Error(name+" admission: "+JSON.stringify(submitted.data));
  if(!submitted.data.operation_id)throw Error(name+" missing operation_id");
  return retry(async()=>{
    const response=await mcp("browser_operation_status",{
      endpoint_id:args.endpoint_id,intent_key:intent_key
    });
    if(response.error||response.data.state!=="completed"){
      if(response.data.state==="unknown"||response.data.state==="failed"||response.data.state==="expired")
        throw Error(name+" final state "+JSON.stringify(response.data));
      throw Error(name+" pending "+JSON.stringify(response.data));
    }
    return response.data;
  },80);
}
async function run(){
  const version=await retry(()=>cdp("Browser.getVersion",{},undefined,2000));
  console.log("BROWSER",version.product);
  const {id}=await cdp("Extensions.loadUnpacked",{path:extension});
  console.log("EXTENSION_LOADED",id);
  const targets=await retry(async()=>{
    const all=(await cdp("Target.getTargets")).targetInfos;
    if(!all.some(t=>t.type==="service_worker"&&t.url.startsWith("chrome-extension://"+id+"/")))
      throw Error("Extension worker unavailable");
    return all;
  });
  const popup=await cdp("Target.createTarget",{url:"chrome-extension://"+id+"/popup.html"});
  const popupSession=(await cdp("Target.attachToTarget",{targetId:popup.targetId,flatten:true})).sessionId;
  await cdp("Runtime.enable",{},popupSession);
  async function evalPopup(expression){
    const r=await cdp("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true},popupSession);
    if(r.exceptionDetails)throw Error("Popup evaluation: "+r.exceptionDetails.text);
    return r.result.value;
  }
  async function invoke(type,args={}){
    const message=JSON.stringify({type,...args});
    return evalPopup("new Promise((resolve,reject)=>chrome.runtime.sendMessage("+message+
      ",r=>r?.ok?resolve(r.result):reject(Error(r?.error||'unavailable'))))");
  }
  const initial=await invoke("status");
  if(initial.authorization!=="unpaired")throw Error("Non-empty initial grant");
  const p=await mcp("browser_pair");
  if(p.error||!p.data.pairing_code)throw Error("No pairing code");
  const paired=await invoke("pair",{service,code:p.data.pairing_code,alias:"spec418-isolated-profile"});
  if(paired.authorization!=="stopped")throw Error("Pair should default stopped");
  const endpoint_id=paired.endpoint_id;
  console.log("PAIR_CLAIMED",endpoint_id,"default-stopped");
  if((await invoke("status")).authorization!=="stopped")throw Error("Pair improperly enables control");
  await invoke("resume");
  const live=await retry(async()=>{
    const e=(await mcp("browser_endpoints")).data.endpoints.find(e=>e.endpoint_id===endpoint_id);
    if(!e?.online)throw Error("WSS pending: "+JSON.stringify(e));
    return e;
  },50);
  console.log("WSS_AUTHENTICATED",live.generation);
  await cdp("Target.createTarget",{url:fixtureOrigin+"/sensitive"});
  const tab=await retry(async()=>{
    const t=await mcp("browser_tabs",{endpoint_id});
    if(t.error)throw Error(JSON.stringify(t.data));
    const found=t.data.tabs.find(t=>t.origin===fixtureOrigin);
    if(!found)throw Error("Fixture absent");
    return found;
  });
  const snap=await retry(async()=>{
    const r=await mcp("browser_snapshot",{endpoint_id,tab_id:tab.tab_id});
    if(!r.data.text?.includes("Observed browser 418 fixture"))throw Error(JSON.stringify(r.data));
    return r.data;
  });
  if(JSON.stringify(snap).includes("secret-must-not-leak"))throw Error("Password leaked");
  const existingStatus=await invoke("status");
  if(existingStatus.last_observed_tab_id!==tab.tab_id ||
     existingStatus.last_observed_tab_source!=="existing_or_unknown" ||
     existingStatus.activity?.available!==true || existingStatus.activity.pending!==0 || existingStatus.activity.unknown!==0)
    throw Error("Existing target/activity status incorrect: "+JSON.stringify(existingStatus.activity));
  console.log("REAL_MCP_SNAPSHOT",tab.tab_id,snap.document_id,"password_excluded");
  const denied=await mcp("browser_screenshot",{endpoint_id,tab_id:tab.tab_id});
  if(denied.data.data_url||!["sensitive_surface","unsupported_background_capture"].includes(denied.data.error_code))
    throw Error("Sensitive screenshot accepted");
  console.log("SCREENSHOT_DENIED",denied.data.error_code);
  // Real browser-side tab effects: MCP -> workerd DO -> WSS -> MV3 -> Chromium Tabs API.
  // Use only this disposable profile and our local fixture server.
  const opened=await awaitMutation("browser_tab_open",{endpoint_id,url:fixtureOrigin+"/clean"});
  if(!Number.isSafeInteger(opened.tab_id))throw Error("Open missing confirmed tab ID");
  const newTab=opened.tab_id;
  const openedSnapshot=await retry(async()=>{
    const r=await mcp("browser_snapshot",{endpoint_id,tab_id:newTab});
    if(!r.data.text?.includes("Clean browser 418 fixture"))throw Error("Open not observed: "+JSON.stringify(r.data));
    return r.data;
  });
  const agentStatus=await invoke("status");
  if(agentStatus.last_observed_tab_id!==newTab || agentStatus.last_observed_tab_source!=="agent_created" ||
     agentStatus.activity?.available!==true || agentStatus.activity.pending!==0 || agentStatus.activity.unknown!==0)
    throw Error("Agent-created target/activity status incorrect: "+JSON.stringify(agentStatus));
  console.log("REAL_TAB_SOURCE_AND_ACTIVITY",newTab,"agent_created",agentStatus.activity.pending,agentStatus.activity.unknown);
  console.log("REAL_TAB_OPEN",newTab,openedSnapshot.document_id);
  // Real Chromium group semantics: one neutral group per window, no reclaim
  // after a human-style manual rename.
  const secondCreated=await awaitMutation("browser_tab_open",{endpoint_id,url:fixtureOrigin+"/clean"});
  const secondTab=secondCreated.tab_id;
  const pairGroups=await evalPopup("(async()=>{const a=await chrome.tabs.get("+newTab+
    ");const b=await chrome.tabs.get("+secondTab+
    ");const g=await chrome.tabGroups.get(a.groupId);return {first:a.groupId,second:b.groupId,title:g.title};})()");
  if(pairGroups.first<0||pairGroups.first!==pairGroups.second||pairGroups.title!=="Browser MCP")
    throw Error("Named tab group was not reused: "+JSON.stringify(pairGroups));
  await evalPopup("chrome.tabGroups.update("+pairGroups.first+",{title:'Owner renamed group'}).then(()=>true)");
  const thirdCreated=await awaitMutation("browser_tab_open",{endpoint_id,url:fixtureOrigin+"/clean"});
  const thirdTab=thirdCreated.tab_id;
  const renamedGroups=await evalPopup("(async()=>{const old=await chrome.tabGroups.get("+pairGroups.first+
    ");const created=await chrome.tabs.get("+thirdTab+
    ");const fresh=await chrome.tabGroups.get(created.groupId);return {oldTitle:old.title,oldId:old.id,newTitle:fresh.title,newId:fresh.id};})()");
  if(renamedGroups.oldTitle!=="Owner renamed group" ||
     renamedGroups.newTitle!=="Browser MCP" || renamedGroups.oldId===renamedGroups.newId)
    throw Error("User-renamed group was forcibly reused: "+JSON.stringify(renamedGroups));
  for(const tabId of [secondTab,thirdTab]){
    const snapshot=await retry(async()=>{
      const r=await mcp("browser_snapshot",{endpoint_id,tab_id:tabId});
      if(!r.data.document_id)throw Error("Temporary grouped tab not ready");
      return r.data;
    });
    const closedGroupTab=await awaitMutation("browser_tab_close",{endpoint_id,tab_id:tabId,
      document_id:snapshot.document_id});
    if(closedGroupTab.tab_id!==tabId)throw Error("Wrong grouped tab closed");
  }
  console.log("REAL_TAB_GROUP_REUSE_AND_MANUAL_RENAME","PASS",pairGroups.first,renamedGroups.newId);
  const moved=await awaitMutation("browser_tab_navigate",{endpoint_id,tab_id:newTab,
    document_id:openedSnapshot.document_id,url:fixtureOrigin+"/next"});
  if(moved.tab_id!==newTab)throw Error("Navigate changed target tab");
  const movedSnapshot=await retry(async()=>{
    const r=await mcp("browser_snapshot",{endpoint_id,tab_id:newTab});
    if(!r.data.text?.includes("Navigated browser 418 fixture"))throw Error("Navigate not observed: "+JSON.stringify(r.data));
    return r.data;
  });
  console.log("REAL_TAB_NAVIGATE",newTab,movedSnapshot.document_id);
  const closed=await awaitMutation("browser_tab_close",{endpoint_id,tab_id:newTab,
    document_id:movedSnapshot.document_id});
  if(closed.tab_id!==newTab)throw Error("Close changed target tab");
  const absent=await mcp("browser_snapshot",{endpoint_id,tab_id:newTab});
  if(absent.data.text || absent.data.tab_id===newTab)throw Error("Closed tab still observable");
  console.log("REAL_TAB_CLOSE",newTab);
  const sw=targets.find(t=>t.type==="service_worker"&&t.url.includes(id));
  const workerSession=(await cdp("Target.attachToTarget",{targetId:sw.targetId,flatten:true})).sessionId;
  await cdp("Runtime.enable",{},workerSession);
  const breaking=await cdp("Runtime.evaluate",{expression:"({ready:socket?.readyState??null,generation:currentGeneration})",returnByValue:true},workerSession);
  if(breaking.exceptionDetails)throw Error("Cannot inspect active socket");
  console.log("BEFORE_DISCONNECT",JSON.stringify(breaking.result.value));
  if(breaking.result.value?.ready!==1)throw Error("Attached worker lacks the authenticated WSS");
  // Simulate a real network break: drop only the test gateway WebSocket transport.
  // Calling WebSocket.close() initiates a clean handshake, not a link failure.
  if(trackedSockets.size===0)throw Error("No test WSS transport to disconnect");
  for(const connection of [...trackedSockets])connection.destroy();
  await sleep(1500);
  const afterClose=await cdp("Runtime.evaluate",{expression:"({ready:socket?.readyState??null,pending:!!reconnect,generation:currentGeneration})",returnByValue:true},workerSession);
  console.log("AFTER_DISCONNECT",JSON.stringify(afterClose.result.value));
  const next=await retry(async()=>{
    const e=(await mcp("browser_endpoints")).data.endpoints.find(e=>e.endpoint_id===endpoint_id);
    if(!e?.online||e.generation<=live.generation)throw Error("Waiting for reconnect");
    return e;
  },80);
  console.log("WSS_RECONNECTED",next.generation);
  const after=(await mcp("browser_snapshot",{endpoint_id,tab_id:tab.tab_id})).data;
  if(!after.text?.includes("Observed browser 418 fixture"))throw Error("Read after reconnect failed");
  await evalPopup("document.getElementById('stop').click()");
  await retry(async()=>{
    const e=(await mcp("browser_endpoints")).data.endpoints.find(e=>e.endpoint_id===endpoint_id);
    if(e?.authorization!=="stopped")throw Error("Waiting for Stop");
  });
  const stopped=await mcp("browser_tabs",{endpoint_id});
  if(!stopped.error||stopped.data.error_code!=="stopped")throw Error("Stopped Profile still readable");
  console.log("STOP_DENIED_NEW_READ");
  // Real upgrade/reload needs a stable user-installed extension, not a DevTools-only install.
  if((await invoke("resume")).authorization!=="enabled")throw Error("Local Resume unavailable");
  await retry(async()=>{
    const e=(await mcp("browser_endpoints")).data.endpoints.find(e=>e.endpoint_id===endpoint_id);
    if(!e?.online)throw Error("Post-resume WSS offline");
  });
  const revoked=await mcp("browser_revoke",{endpoint_id});
  if(revoked.data.authorization!=="revoked")throw Error("Revoke not committed");
  if(!(await mcp("browser_tabs",{endpoint_id})).error)throw Error("Revoked endpoint accepted read");
  const local=await retry(async()=>{
    const s=await invoke("status");
    if(s.authorization!=="revoked")throw Error("Local revoke not reflected");
    return s;
  });
  if(local.credential||local.endpoint_id)throw Error("Credential remained after revoke");
  console.log("REVOKE_DENIED_NEW_READ_AND_CLEARED_CREDENTIAL");
  console.log("PASS local workerd -> real Chrome/Edge WSS integration");
}
try{await run();}
catch(e){console.error("FAIL real WSS smoke:",e.message,"browser:",stderr.slice(-700));process.exitCode=1;}
finally{
  for(const [id,done] of pending){pending.delete(id);done({error:{message:"test finished"}});}
  browser.kill();await sleep(500);
  if(browser.exitCode===null&&browser.pid){
    const killer=spawn("taskkill",["/F","/T","/PID",String(browser.pid)],{windowsHide:true});
    await new Promise(resolve=>killer.on("exit",resolve));
  }
  for(const socket of trackedSockets)socket.destroy();
  await Promise.all([
    new Promise(resolve=>gateway.close(resolve)),
    new Promise(resolve=>fixture.close(resolve))
  ]);
  try{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
  catch(e){console.error("CLEANUP_WARNING",e.message);}
}
