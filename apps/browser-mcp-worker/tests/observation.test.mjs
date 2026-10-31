import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const source=fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../extension/observation.js"),"utf8");
function browserFixture({tabs=[],frame=null,scriptResult=null,afterFrame=null,scriptHandler=null}={}){
  const calls=[];
  const grants={};
  const chrome={
    storage:{session:{get:async()=>({browser_sensitive_grants:grants})}},
    extension:{isAllowedIncognitoAccess:async()=>true},
    tabs:{
      async query(){calls.push(["tabs.query"]);return tabs;},
      async get(tabId){calls.push(["tabs.get",tabId]);return tabs.find(t=>t.id===tabId)??null;}
    },
    webNavigation:{async getFrame(request){calls.push(["getFrame",request.tabId]);return calls.filter(c=>c[0]==="getFrame").length===1?frame:afterFrame??frame;}},
    scripting:{async executeScript(options){calls.push(["executeScript",options.target]);return scriptHandler?scriptHandler(options):scriptResult??[];}}
  };
  const ctx=vm.createContext({URL,chrome,setTimeout,clearTimeout,BROWSER_MCP_SERVICE_ORIGIN:"https://browser-mcp-worker.invalid"});
  vm.runInContext(source,ctx);
  return {ctx,calls,grants,read:(tool,tabId,scopes)=>vm.runInContext(`executeBrowserRead(${JSON.stringify(tool)},${JSON.stringify(tabId)},${JSON.stringify(scopes)})`,ctx)};
}
test("browser policy protects own Owner channel and network boundaries, not ordinary signed-in business URLs",async()=>{
  const f=browserFixture();
  for(const address of [
    "chrome://settings/","file:///etc/passwd","http://127.0.0.1/",
    "http://192.168.1.1/","http://169.254.169.254/latest/meta-data/",
    "https://browser-mcp-worker.invalid/approve",
    "https://browser-mcp-worker.invalid/activate/verify/attempt"
  ])assert.equal(vm.runInContext(`browserEligibleUrl(${JSON.stringify(address)})`,f.ctx),false,address);
  for(const url of ["https://mail.google.com/mail/u/0/","https://accounts.google.com/signin",
    "https://github.com/login","https://example.com/%6cogin","https://example.com/#/post/save",
    "https://example.com/account/oauth/authorize","https://example.cloudflareaccess.com/cdn-cgi/access/login","https://www.example.com/page"])
    assert.equal(vm.runInContext(`browserEligibleUrl(${JSON.stringify(url)})`,f.ctx),true,url);
});
test("browser tab discovery never returns forbidden URL, private tab or page title",async()=>{
  const f=browserFixture({tabs:[
    {id:11,url:"https://example.com/private?token=TOP_SECRET#fragment",title:"SECRET TITLE",windowId:1,active:false,incognito:false},
    {id:12,url:"https://browser-mcp-worker.invalid/",title:"owner",windowId:1,incognito:false},
    {id:13,url:"https://example.com/private",incognito:true,windowId:2}
  ]});
  const result=await f.read("tabs");
  assert.equal(result.tabs.length,1);
  assert.equal(result.tabs[0].tab_id,11);
  assert.equal(result.tabs[0].origin,"https://example.com");
  assert.equal(JSON.stringify(result).includes("TOP_SECRET"),false);
  assert.equal(JSON.stringify(result).includes("SECRET TITLE"),false);
});
test("explicit background tab snapshot binds document ID and blocks navigation races",async()=>{
  const tab={id:41,url:"https://example.com/a",windowId:1,active:false,incognito:false};
  const frame={url:tab.url,documentLifecycle:"active",documentId:"fresh-document"};
  const f=browserFixture({tabs:[tab],frame,scriptResult:[
    {frameId:0,documentId:"fresh-document",result:{text:"Public heading",truncated:false}}
  ]});
  const value=await f.read("snapshot",41);
  assert.equal(value.document_id,"fresh-document");
  assert.equal(value.text,"Public heading");
  assert.equal(f.calls.some(x=>x[0]==="tabs.get"&&x[1]===41),true);
  const changed=browserFixture({tabs:[tab],frame,afterFrame:{url:"https://example.com/next",documentId:"new-document",documentLifecycle:"active"},
    scriptResult:[{frameId:0,documentId:"fresh-document",result:{text:"stale",truncated:false}}]});
  const stale=await changed.read("snapshot",41);
  assert.equal(stale.error_code,"stale_target");
  // Same documentId can survive a SPA route transition; refuse mixed snapshots.
  const spa=browserFixture({tabs:[tab],frame,afterFrame:{
    url:"https://example.com/route-changed",documentId:frame.documentId,documentLifecycle:"active"},
    scriptResult:[{frameId:0,documentId:frame.documentId,result:{text:"new-page",truncated:false}}]});
  assert.equal((await spa.read("snapshot",41)).error_code,"stale_target");
});

test("slow optional element references cannot hold a safe visible-text snapshot past the read deadline",async()=>{
  const tab={id:49,url:"https://example.com/public",windowId:1,active:true,incognito:false};
  const frame={url:tab.url,documentLifecycle:"active",documentId:"doc-49"};
  const f=browserFixture({tabs:[tab],frame,scriptHandler:options=>
    options.func.name==="extractVisibleText"
      ? [{frameId:0,documentId:frame.documentId,result:{text:"Public content",truncated:false}}]
      : new Promise(()=>{})});
  f.ctx.browserPageInteraction=()=>{};
  const outcome=await Promise.race([f.read("snapshot",49),new Promise(resolve=>setTimeout(()=>resolve({error_code:"test_deadline"}),2500))]);
  assert.equal(outcome.text,"Public content");
  assert.equal(outcome.document_id,frame.documentId);
  assert.deepEqual(Array.from(outcome.elements),[]);
  assert.equal(f.calls.filter(c=>c[0]==="executeScript").length,2);
});

test("local/private policy gates both scopes independently and never permits metadata targets",async()=>{
  const f=browserFixture();
  const allowed=(url,grant=false)=>vm.runInContext("browserEligibleUrl("+JSON.stringify(url)+","+JSON.stringify(grant)+")",f.ctx);
  const tab=(url,incognito,lan=false,privateGrant=false)=>vm.runInContext(
    "browserAllowedTab("+JSON.stringify({id:71,url,incognito})+","+JSON.stringify({lan,private:privateGrant})+")",f.ctx);
  for(const url of ["http://169.254.169.254/","http://metadata.google.internal/","http://100.100.100.200/"]){
    assert.equal(allowed(url,false),false,url);
    assert.equal(allowed(url,true),false,url);
  }
  assert.equal(allowed("http://127.0.0.1/login",false),false);
  assert.equal(allowed("http://127.0.0.1/login",true),true);
  for(const url of ["http://localhost:3000/","http://192.168.0.8/app","https://printer.lan/","http://[::1]:8000/"]){
    assert.equal(allowed(url,false),false,url);
    assert.equal(allowed(url,true),true,url);
  }
  assert.equal(tab("https://example.com/public",true,false,false),false);
  assert.equal(tab("https://example.com/public",true,false,true),true);
  assert.equal(tab("http://localhost:3000/",true,true,false),false);
  assert.equal(tab("http://localhost:3000/",true,false,true),false);
  assert.equal(tab("http://localhost:3000/",true,true,true),true);
});


test("top-document visible text survives ordinary embedded frames and forms without reading child or input values",()=>{
  const textNode={textContent:"Published token docs and search form",parentElement:{closest:()=>null,getClientRects:()=>[{}]}};
  const walker={currentNode:null,nextNode(){if(this.currentNode)return false;this.currentNode=textNode;return true;}};
  const document={body:{},querySelector(){throw Error("unexpected iframe traversal");},createTreeWalker:()=>walker};
  const ctx=vm.createContext({document,NodeFilter:{SHOW_TEXT:4},getComputedStyle:()=>({display:"block",visibility:"visible"})});
  vm.runInContext(source,ctx);
  const result=vm.runInContext("extractVisibleText()",ctx);
  assert.equal(result.text,"Published token docs and search form");
  assert.equal(result.truncated,false);
});

test("slow visible-text scanning returns bounded partial text rather than exhausting the read deadline",()=>{
  let visited=0,elapsed=0;
  const parent={closest:()=>null,getClientRects:()=>[{}]};
  const walker={currentNode:null,nextNode(){
    if(visited>=1000)return false;
    this.currentNode={parentElement:parent,textContent:"Public line "+visited++};
    return true;
  }};
  const ctx=vm.createContext({
    document:{body:{},createTreeWalker:()=>walker},NodeFilter:{SHOW_TEXT:4},
    Date:{now:()=>elapsed},
    getComputedStyle:()=>{elapsed+=10;return {display:"block",visibility:"visible"};}
  });
  vm.runInContext(source,ctx);
  const result=vm.runInContext("extractVisibleText()",ctx);
  assert.equal(result.truncated,true,"must identify partial output on slow pages");
  assert.ok(result.text.includes("Public line 0"),"safe partial output should remain usable");
  assert.ok(visited<500,"stop iterating before the five-second read budget");
  assert.ok(elapsed<=2000,"the scanning phase must leave time for transport and element references");
});
