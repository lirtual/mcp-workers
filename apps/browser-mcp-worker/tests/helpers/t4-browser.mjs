import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";
import worker from "../../src/worker.ts";
import {BrowserOwner} from "../../src/coordinator.ts";
const service="https://browser.example",extensionOrigin="chrome-extension://jhifaghneomgcfollcdbncjkcloedfem";
const pause=()=>new Promise(resolve=>setImmediate(resolve));
let sequence=0;
export function intent(){const t=Date.now().toString(16).padStart(12,"0");return t.slice(0,8)+"-"+t.slice(8)+"-7000-8000-"+(++sequence).toString(16).padStart(12,"0");}
// Public Chrome adapters only. Injected functions run serialized in a distinct
// VM, exercising Chrome's no-closure scripting contract. No private entrypoints.
export async function fixture(config={},options={}){
  const db=new DatabaseSync(":memory:"),sockets=[],pending=[],effects=[],retired=[];
  const sql={exec(query,...args){const stmt=db.prepare(query);
    if(stmt.columns().length){const rows=stmt.all(...args);return {toArray:()=>rows,rowsWritten:0};}
    return {toArray:()=>[],rowsWritten:Number(stmt.run(...args).changes)};
  }};
  const state={storage:{sql},getWebSockets:()=>sockets};
  let owner=new BrowserOwner(state,config),receiver,ws,dropReceipt=false,dropApprovalReply=false,holdExecute=false,held;
  const env={...config,MCP_ACCESS_TOKEN:"test-token",BROWSER_OWNER:{idFromName:()=>"owner",get:()=>({fetch:(url,init)=>owner.fetch(new Request(url,init))})}};
  async function rpc(name,args={},method="tools/call"){
    const r=await worker.fetch(new Request(service+"/mcp",{method:"POST",headers:{authorization:"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:method==="tools/call"?{name,arguments:args}:{}})}),env);
    const value=await r.json();return value.result?.content?JSON.parse(value.result.content[0].text):value;
  }
  const enqueue=p=>{pending.push(p);};
  class Socket {
    static OPEN=1;
    constructor(){this.readyState=1;ws=this;
      this.server={readyState:1,attachment:{deadline:Date.now()+5000,authenticated:false},
        deserializeAttachment(){return this.attachment;},serializeAttachment(a){this.attachment=a;},
        send:data=>{const m=JSON.parse(data);if(holdExecute&&m.type==="execute_request"){held=data;return;}
          enqueue(Promise.resolve().then(()=>this.onmessage({data})));},
        close:()=>{this.readyState=3;this.server.readyState=3;}};
      sockets.push(this.server);
    }
    send(data){
      if(dropReceipt&&JSON.parse(data).type==="execute_result")return;
      if(dropApprovalReply&&JSON.parse(data).type==="approval_result"){dropApprovalReply=false;return;}
      if(options.legacyOwnerProtocol&&JSON.parse(data).type==="authenticate"){
        const frame=JSON.parse(data);delete frame.owner_approval_protocol;data=JSON.stringify(frame);
      }
      enqueue(owner.webSocketMessage(this.server,data));
    }
    close(){this.readyState=3;this.server.readyState=3;}
  }
  const local={},session={};
  const storage=values=>({setAccessLevel:async()=>{},get:async keys=>keys==null?{...values}:
    Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>Object.hasOwn(values,k)).map(k=>[k,values[k]])),
    set:async v=>Object.assign(values,v),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete values[k];},clear:async()=>{for(const k of Object.keys(values))delete values[k];}});
  let scriptGate=null;
  const event=()=>{const listeners=[];return {addListener(fn){listeners.push(fn);},removeListener(){},emit:async data=>{for(const fn of listeners)await fn(data);}};};
  const pageState={url:"https://example.com/clean",document_id:"doc-1",incognito:false,text:"Public fixture",sensitive:false};
  class Element {
    constructor(tag,attrs={}){this.tagName=tag;this.attrs=attrs;this.id=attrs.id||"";this.isConnected=true;this.textContent=attrs.label||"";this.children=[];
      this.labels=[];this.parentElement=null;this.scrollHeight=500;this.clientHeight=100;this.options=[];this._value="";this.style={};this.removed=false;}
    get innerText(){return this.textContent;}
    getAttribute(k){return this.attrs[k]??null;}
    setAttribute(k,v){this.attrs[k]=v;}
    closest(selector){return this.form&&String(selector).split(",").some(s=>s.trim()==="form")?{}:null;}
    getClientRects(){return [{}];}
    click(){effects.push(["click",this.tagName]);if(this.throwAfterEffect)throw Error("lost");}
    focus(){effects.push(["focus",this.tagName]);document.activeElement=this;}
    dispatchEvent(e){effects.push([e.type,e.key??this._value]);return true;}
    scrollBy(v){effects.push(["scroll",v.top]);}
    getBoundingClientRect(){return {left:10,top:20,width:70,height:30};}
    remove(){this.removed=true;}
    get value(){return this._value;}
    set value(v){this._value=v;if(this.tagName==="SELECT")for(const o of this.options)o.selected=o.value===v;}
  }
  const nodes=[new Element("BODY"),new Element("INPUT",{type:"text"}),new Element("INPUT",{type:"checkbox"}),
    new Element("SELECT"),new Element("BUTTON",{label:"Submit payment"}),new Element("INPUT",{type:"password"})];
  nodes[2].labels=[{textContent:"Show grid"}];
  nodes[3].options=[{value:"blue",textContent:"Blue",parentElement:nodes[3],disabled:false}];
  const document={body:nodes[0],scrollingElement:nodes[0],documentElement:{appendChild(el){pageState.marker=el;}},createElement:tag=>new Element(tag.toUpperCase()),querySelector:selector=>(pageState.sensitive||pageState.embedded&&/iframe/.test(selector))?nodes[5]:null,
    querySelectorAll:selector=>nodes.slice(1).filter(n=>pageState.sensitive||n.attrs.type!=="password").filter(n=>selector==="input,textarea,select"?["INPUT","TEXTAREA","SELECT"].includes(n.tagName):true),
    createTreeWalker:()=>({nextNode:()=>false})};
  Object.defineProperty(nodes[0],"innerText",{get:()=>pageState.text});
  const page=vm.createContext({URL,document,location:{get href(){return pageState.url;}},crypto,Date:class extends Date{static now(){return pageState.now??Date.now();}},Map,
    getComputedStyle:()=>({display:"block",visibility:"visible"}),NodeFilter:{SHOW_TEXT:4},
    MutationObserver:class{observe(){}disconnect(){}takeRecords(){if(pageState.mutated){pageState.mutated=false;return [{type:"attributes",target:pageState.mutationTarget??nodes[1]}];}return [];}},
    HTMLInputElement:Element,HTMLTextAreaElement:Element,HTMLSelectElement:Element,
    Event:class{constructor(type,opts){this.type=type;Object.assign(this,opts);}},
    KeyboardEvent:class{constructor(type,opts){this.type=type;Object.assign(this,opts);}},setTimeout,clearTimeout});
  const actionClicked=event(),activationAlarm=event();
  const chrome={extension:{isAllowedIncognitoAccess:async()=>{if(pageState.nativeFailure)throw Error("native failure");return pageState.nativePrivate===true;}},storage:{local:storage(local),session:storage(session)},action:{setBadgeText:async()=>{},setTitle:async()=>{},onClicked:actionClicked},alarms:{create:async()=>{},onAlarm:activationAlarm},
    runtime:{id:"jhifaghneomgcfollcdbncjkcloedfem",getURL:p=>extensionOrigin+"/"+p,onMessage:{addListener(fn){receiver=fn;}},onMessageExternal:event(),onStartup:event(),onInstalled:event()},
    tabs:{onRemoved:event(),onActivated:event(),captureVisibleTab:async()=>"data:image/png;base64,SCREENSHOT_SEED",
      create:async opts=>{
        if(opts.url.startsWith(service+"/activate/verify/")){
          const attempt_id=new URL(opts.url).pathname.split("/").at(-1);
          const r=await owner.fetch(new Request("https://owner.internal/activate-authorize",{method:"POST",body:JSON.stringify({attempt_id})}));
          assert.equal(r.status,200);return {id:42,windowId:1};
        }
        effects.push(["tab_open",opts.url,opts.windowId]);return {id:2,windowId:1};},
      update:async(id,opts)=>{effects.push(["tab_navigate",id,opts.url]);return {id};},
      remove:async id=>{effects.push(["tab_close",id]);},get:async id=>({id,url:pageState.url,incognito:pageState.incognito,windowId:pageState.incognito?2:1,active:true}),query:async()=>[{id:1,url:pageState.url,incognito:pageState.incognito,windowId:pageState.incognito?2:1},{id:9,url:"https://ordinary.example/",incognito:false,windowId:1}]},
    windows:{get:async id=>({id,focused:true,incognito:pageState.incognito}),onFocusChanged:event()},
    webNavigation:{onCommitted:event(),getFrame:async()=>({documentId:pageState.document_id,url:pageState.frameUrl??pageState.url,documentLifecycle:"active"})},
    scripting:{executeScript:async opts=>{if(scriptGate){const gate=scriptGate;scriptGate=null;gate.enter();await gate.ready;}assert.equal(opts.world,"ISOLATED");assert.deepEqual(Array.from(opts.target.documentIds),[pageState.document_id]);
      page.args=JSON.parse(JSON.stringify(opts.args||[]));
      const result=vm.runInContext("("+opts.func.toString()+")(...args)",page);
      return [{frameId:0,documentId:pageState.document_id,result:JSON.parse(JSON.stringify(result))}];
    }}
  };
  const intervals=new Set();
  let ctx;
  // Simulate independent Chrome and Worker wall clocks without changing the host clock.
  const ExtensionDate=class extends Date {static now(){return Date.now()+(options.extensionClockOffsetMs??0);}};
  function loadExtension(){
  ctx=vm.createContext({chrome,crypto,URL,Date:ExtensionDate,Math,JSON,Promise,TextEncoder,setTimeout,clearTimeout,setInterval:(fn,ms)=>{const id=setInterval(fn,ms);intervals.add(id);return id;},clearInterval,WebSocket:Socket,
    BROWSER_MCP_SERVICE_ORIGIN:service,
    fetch:(url,opts)=>worker.fetch(new Request(url,{...opts,headers:{...opts.headers,origin:extensionOrigin}}),env)});
  ctx.importScripts=name=>{if(name!=="config.js")vm.runInContext(fs.readFileSync(new URL("../../extension/"+name,import.meta.url),"utf8"),ctx);};
  vm.runInContext(fs.readFileSync(new URL("../../extension/background.js",import.meta.url),"utf8"),ctx);
  }
  loadExtension();await pause();
  async function popup(type,extra={}){
    if(type==="resume"){
      await clickOn();ws.onopen();await flush();return {authorization:"enabled"};
    }
    return new Promise((resolve,reject)=>receiver({type,...extra},{id:chrome.runtime.id,url:chrome.runtime.getURL("options.html")},r=>r.ok?resolve(r.result):reject(Error(r.error))));}
  async function clickOn(){
    await actionClicked.emit();
    for(let i=0;i<120&&local.authorization!=="enabled";i++){await new Promise(r=>setTimeout(r,5));await activationAlarm.emit({name:"browser-activation"});}
    assert.ok(local.endpoint_id&&local.authorization==="enabled","toolbar activation must pair after Access verification");
    for(let i=0;i<20&&!ws;i++)await pause();
    assert.ok(ws,"verified activation opens WSS");
  }
  await clickOn();await pause();ws.onopen();
  async function flush(){for(let i=0;i<30;i++){await pause();if(!pending.length)return;await Promise.all(pending.splice(0));}throw Error("unsettled socket");}
  await flush();const endpoint_id=local.endpoint_id;
  async function snapshot(){const result=await rpc("browser_snapshot",{endpoint_id,tab_id:1});await flush();return result;}
  async function command(action,find,params={}){const snap=await snapshot();const el=snap.elements.find(find);assert.ok(el,JSON.stringify(snap));
    return {endpoint_id,intent_key:intent(),tab_id:1,document_id:snap.document_id,element_id:el.element_id,...params};}
  async function perform(action,args){const admitted=await rpc("browser_"+action,args);await flush();
    return {admitted,result:await rpc("browser_operation_status",{endpoint_id,intent_key:args.intent_key})};}
  return {rpc,popup,flush,snapshot,command,perform,nodes,pageState,effects,db,session,local,chrome,
    spoof:(message,sender)=>new Promise(resolve=>receiver(message,sender,resolve)),
    restartExtension:async(clearSession=false)=>{
      ws.close();for(const id of intervals)clearInterval(id);intervals.clear();
      if(clearSession)await chrome.storage.session.clear();
      loadExtension();await pause();ws.onopen();await flush();
    },
    pauseNextScript:()=>{let enter,release;const entered=new Promise(resolve=>{enter=resolve;});const ready=new Promise(resolve=>{release=resolve;});scriptGate={enter,ready};return {entered,release};},
    http:(path,init={})=>worker.fetch(new Request(new URL(path,service),init),env),
    drop:()=>{dropReceipt=true;},hold:()=>{holdExecute=true;},release:async(extra={})=>{if(held)await ws.onmessage({data:JSON.stringify({...JSON.parse(held),...extra})});},
    transientDisconnect:()=>{const live=sockets.filter(socket=>socket.readyState===1);assert.ok(live.length);for(const socket of live)socket.readyState=3;return ()=>{for(const socket of live)socket.readyState=1;};},
    dropNextApprovalReply:()=>{dropApprovalReply=true;},
    restart:()=>{retired.push(owner);owner=new BrowserOwner(state,config);},
    doRequest:async body=>(await owner.fetch(new Request("https://owner.internal/mutate",{method:"POST",body:JSON.stringify(body)}))).json(),
    close:async()=>{await popup("stop");await flush();for(const id of intervals)clearInterval(id);for(const prior of retired)for(const socket of sockets)prior.webSocketClose(socket,1000,"test cleanup",true);db.close();}};
}
