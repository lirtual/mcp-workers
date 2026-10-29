import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root=new URL("../extension/",import.meta.url);
const html=fs.readFileSync(new URL("popup.html",root),"utf8");
const source=fs.readFileSync(new URL("popup.js",root),"utf8");

function popup(){
  const ids=["status","summary","action-feedback","pairing-details","service","code","alias","pair","locate",
    "stop","resume","revoke","ack","lan","private"];
  const nodes=Object.fromEntries(ids.map(id=>[id,{id,textContent:"",value:"",disabled:false,onclick:null}]));
  const messages=[];
  const state={alias:"chrome",authorization:"enabled",connection:"online",last_update:Date.now(),
    sensitive_permissions:{lan:false,private:false,native_private:false},
    pending_cloud_stop:false,endpoint_id:"11111111-1111-4111-8111-111111111111",activity:{available:true,pending:0,unknown:0,approvals:[]}};
  let respondStop;
  const chrome={runtime:{lastError:null,sendMessage(message,reply){
    messages.push(message.type);
    if(message.type==="status")queueMicrotask(()=>reply({ok:true,result:{...state}}));
    else if(message.type==="stop")respondStop=reply;
    else if(message.type==="resume")queueMicrotask(()=>reply({ok:false,error:"cloud_stop_not_confirmed"}));
    else queueMicrotask(()=>reply({ok:false,error:"unsupported"}));
  }}};
  const ctx=vm.createContext({document:{getElementById:id=>nodes[id]??null},chrome,
    BROWSER_MCP_SERVICE_ORIGIN:"https://browser.lirtual.dpdns.org",
    URL,Date,console,confirm:()=>true,alert:()=>{}});
  vm.runInContext(source,ctx);
  return {nodes,state,messages,finishStop:(reply)=>respondStop(reply)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("stop button provides immediately visible in-place progress and authoritative result",async()=>{
  assert.ok(html.includes('id="action-feedback"'),"inline feedback element required");
  const noticeIndex=html.indexOf('id="action-feedback"');
  assert.ok(noticeIndex<html.indexOf('id="stop"') && noticeIndex>html.indexOf('id="summary"'),
    "feedback belongs adjacent to action buttons, not inside offscreen diagnostics");
  const p=popup();
  await tick();
  const pending=p.nodes.stop.onclick();
  assert.match(p.nodes["action-feedback"].textContent,/Stopping locally/);
  assert.ok(p.messages.includes("stop"),"click must call trusted local Stop message");
  p.state.authorization="stopped";p.state.connection="offline";
  p.finishStop({ok:true,result:{authorization:"stopped",cloud_confirmed:true}});
  await pending;
  assert.match(p.nodes["action-feedback"].textContent,/stopped/i);
  assert.match(p.nodes.summary.textContent,/stopped/i);
});

test("failed local button action shows its rejection in place instead of silent success",async()=>{
  const p=popup();
  await tick();
  const pending=p.nodes.resume.onclick();
  await pending;
  assert.match(p.nodes["action-feedback"].textContent,/cloud_stop_not_confirmed/);
  assert.match(p.nodes.summary.textContent,/enabled/);
});
