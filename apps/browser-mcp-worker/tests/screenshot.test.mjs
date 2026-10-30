import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import {fileURLToPath} from "node:url";

const source=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../extension/observation.js"),"utf8");
const origin="https://browser-mcp-worker.invalid";
function fixture({active=true,focused=true,sensitive=false,bytes=80,change=false,switchDuringCapture=false,navigationDuringCapture=false}={}){
  const calls=[];
  let onActivate, onCommitted;
  const tab={id:56,url:"https://example.com/public",windowId:7,active,incognito:false};
  const frame={url:tab.url,documentLifecycle:"active",documentId:"document-123"};
  const chrome={
    tabs:{
      onActivated:{addListener(fn){onActivate=fn;calls.push("subscribe-tab");},removeListener(fn){onActivate=null;calls.push("unsubscribe-tab");}},
      async get(id){calls.push("get");assert.equal(id,56);return tab;},
      async captureVisibleTab(id,opts){calls.push("capture");assert.equal(id,7);assert.equal(opts.format,"png");
        if(switchDuringCapture)onActivate?.({windowId:7,tabId:999});
        if(navigationDuringCapture)onCommitted?.({tabId:56,frameId:0,documentId:"other-document"});
        return "data:image/png;base64,"+"A".repeat(bytes);
      }
    },
    windows:{onFocusChanged:{addListener(fn){calls.push("subscribe-window");},removeListener(fn){calls.push("unsubscribe-window");}},async get(id){calls.push("window");assert.equal(id,7);return {focused,incognito:false};}},
    webNavigation:{onCommitted:{addListener(fn){onCommitted=fn;calls.push("subscribe-navigation");},removeListener(fn){if(onCommitted===fn)onCommitted=null;calls.push("unsubscribe-navigation");}},async getFrame(){calls.push("frame");return change&&calls.filter(x=>x==="frame").length>1?
      {...frame,documentId:"new-document"}:frame;}},
    scripting:{async executeScript(opts){calls.push("inspect");
      assert.deepEqual(Array.from(opts.target.documentIds),["document-123"]);
      return [{documentId:"document-123",frameId:0,result:{allowed:!sensitive}}];}}
  };
  const ctx=vm.createContext({URL,chrome,BROWSER_MCP_SERVICE_ORIGIN:origin});
  vm.runInContext(source,ctx);
  return {calls,ctx,read:()=>vm.runInContext('executeBrowserRead("screenshot",56)',ctx)};
}
test("screenshot only captures the exact active focused eligible tab with document identity",async()=>{
  const f=fixture();const result=await f.read();
  assert.equal(result.tab_id,56);
  assert.equal(result.document_id,"document-123");
  assert.match(result.data_url,/^data:image\/png;base64,/);
  assert.equal(f.calls.filter(c=>c==="capture").length,1);
  assert.equal(f.calls.filter(c=>c==="unsubscribe-tab").length,1);
});
test("background tabs are never activated just to capture them",async()=>{
  for(const options of [{active:false},{focused:false}]){
    const f=fixture(options);const result=await f.read();
    assert.equal(result.error_code,"unsupported_background_capture");
    assert.equal(f.calls.includes("capture"),false);
  }
});
test("recognizable sensitive surfaces fail closed before screenshot API",async()=>{
  const f=fixture({sensitive:true});const result=await f.read();
  assert.equal(result.error_code,"sensitive_surface");
  assert.equal(f.calls.includes("capture"),false);
  const docFixture=fixture();
  const item=(tag,attrs={},hidden=false)=>({tagName:tag,id:attrs.id||"",getAttribute:k=>attrs[k]??null,
    labels:[],closest:()=>null,getClientRects:()=>hidden?[]:[{}]});
  docFixture.ctx.getComputedStyle=()=>({display:"block",visibility:"visible"});
  docFixture.ctx.document={body:{},querySelectorAll:()=>[item("INPUT",{autocomplete:"one-time-code"})]};
  assert.equal(vm.runInContext("screenshotExposureCheck().allowed",docFixture.ctx),false);
  docFixture.ctx.document={body:{},querySelectorAll:()=>[item("INPUT",{type:"text"}),item("FORM")]};
  assert.equal(vm.runInContext("screenshotExposureCheck().allowed",docFixture.ctx),true);
  docFixture.ctx.document={body:{},querySelectorAll:()=>[item("IFRAME")]};
  assert.equal(vm.runInContext("screenshotExposureCheck().allowed",docFixture.ctx),false);
  docFixture.ctx.document={body:{},querySelectorAll:()=>[item("IFRAME",{},true)]};
  assert.equal(vm.runInContext("screenshotExposureCheck().allowed",docFixture.ctx),true);
});
test("screenshot refuses stale document or oversized image instead of returning partial sensitive data",async()=>{
  const race=fixture({change:true});assert.equal((await race.read()).error_code,"stale_target");
  const huge=fixture({bytes:2*1024*1024});assert.equal((await huge.read()).error_code,"capacity_exceeded");
});

test("any tab activation change during capture discards the entire image",async()=>{
  const f=fixture({switchDuringCapture:true});
  const result=await f.read();
  assert.equal(result.error_code,"stale_target");
  assert.equal(Object.hasOwn(result,"data_url"),false);
  assert.equal(f.calls.filter(c=>c==="unsubscribe-tab").length,1);
});

test("a main-frame navigation event during capture invalidates the screenshot even when a document appears unchanged afterward",async()=>{
  const f=fixture({navigationDuringCapture:true});
  const result=await f.read();
  assert.equal(result.error_code,"stale_target");
  assert.equal(Object.hasOwn(result,"data_url"),false);
});

test("unattended capture has the canonical all_urls permission (executor still excludes protected schemes)",()=>{
  const m=JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../extension/manifest.json"),"utf8"));
  assert.ok(m.host_permissions.includes("<all_urls>"));
  assert.ok(!m.permissions.includes("debugger"));
});
