import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(dirname,"../extension/background.js"),"utf8");
const observation=fs.readFileSync(path.join(dirname,"../extension/observation.js"),"utf8");
const mutations=fs.readFileSync(path.join(dirname,"../extension/mutations.js"),"utf8");
const id="11111111-1111-4111-8111-111111111111";
const credential="a".repeat(64);
const service="https://browser-mcp-worker.invalid";
async function setup(initial={},respond=async()=>{throw Error("network_offline");},options={}) {
  const local={...initial,...(initial.endpoint_id?{activation_protocol:2}:{})}; const session={}; const events=[]; const sockets=[];
  const createdTabs=new Map();
  let handler, startup, installed, onRemoved,actionClick,alarm,externalHandler;
  const chrome={
    tabs:{
      query:async()=>[{id:73,windowId:5,incognito:false}],
      onRemoved:{addListener(fn){onRemoved=fn;}},
      async get(tabId){events.push({type:"lookup-tab",tabId});return createdTabs.get(tabId)??{id:73,url:"https://example.com/public",windowId:5,incognito:false,active:false};},
      async update(tabId,options){events.push({type:"focus-tab",tabId,options});return {id:tabId};},
      async create(options){events.push({type:"create-tab",options});const tab={id:74,...options};createdTabs.set(74,tab);return tab;},
      async remove(tabId){events.push({type:"remove-tab",tabId});createdTabs.delete(tabId);},
      async group(options){events.push({type:"group-tab",options});return 8;}
    },
    tabGroups:{query:async()=>[],async update(groupId,options){events.push({type:"group-title",groupId,options});}},
    windows:{async update(windowId,options){events.push({type:"focus-window",windowId,options});return {id:windowId};}},
    webNavigation:{async getFrame({tabId,frameId}){events.push({type:"lookup-document",tabId,frameId});return {url:"https://example.com/public",documentId:"document-73",documentLifecycle:"active"};}},
    action:{setBadgeText:async()=>{},setTitle:async()=>{},onClicked:{addListener(fn){actionClick=fn;}}},
    alarms:{create:async()=>{},onAlarm:{addListener(fn){alarm=fn;}}},
    storage:{
      local:{
        async setAccessLevel({accessLevel}){events.push({type:"access",accessLevel});},
        async get(){return {...local};},
        async set(v){Object.assign(local,v);events.push({type:"persist",values:{...v}});},
        async remove(keys){for(const k of keys)delete local[k];events.push({type:"remove",keys});}
      },
      session:{
        async setAccessLevel(){},
        async clear(){for(const k of Object.keys(session))delete session[k];events.push({type:"session-clear"});},
        async get(keys){if(keys==null)return {...session};const names=Array.isArray(keys)?keys:[keys];return Object.fromEntries(names.filter(k=>Object.hasOwn(session,k)).map(k=>[k,session[k]]));},
        async set(values){Object.assign(session,values);events.push({type:"session-set",keys:Object.keys(values)});},
        async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete session[k];events.push({type:"session-remove",keys});}
      }
    },
    runtime:{
      id:"test-extension",
      getURL:p=>"chrome-extension://test-extension/"+p,
      onMessage:{addListener(fn){handler=fn;}},onMessageExternal:{addListener(fn){externalHandler=fn;}},
      onStartup:{addListener(fn){startup=fn;}},
      onInstalled:{addListener(fn){installed=fn;}}
    }
  };
  class Socket {static OPEN=1;constructor(){this.readyState=0;this.OPEN=1;this.CLOSED=3;sockets.push(this);if(options.fastOpen)queueMicrotask(()=>{this.readyState=1;this.onopen?.();});} send(data){events.push({type:"socket-send",data});} close(){this.readyState=3;}}
  const fetch=async(url,opts)=>{
    events.push({type:"fetch",url,body:JSON.parse(opts.body),localState:{...local}});
    return respond(url,opts,local);
  };
  const ctx=vm.createContext({chrome,fetch,WebSocket:Socket,crypto,URL,Date,Math,JSON,Promise,console,TextEncoder,setTimeout,clearTimeout,setInterval,clearInterval,
    BROWSER_MCP_SERVICE_ORIGIN:service,importScripts:()=>{}});
  ctx.importScripts=(name)=>{if(name==="config.js")return;
    if(name==="observation.js")return vm.runInContext(observation,ctx);
    assert.equal(name,"mutations.js");vm.runInContext(mutations,ctx);};
  vm.runInContext(source,ctx);
  await new Promise(resolve=>setTimeout(resolve,5));
  async function send(type,props={}){
    return new Promise((resolve,reject)=>{
      handler({type,...props},{id:"test-extension",url:"chrome-extension://test-extension/options.html"},answer=>answer?.ok?resolve(answer.result):reject(Error(answer?.error||"unknown")));
    });
  }
  const sendSpoof=(type,sender)=>new Promise(resolve=>handler({type},sender,resolve));
  return {local,session,events,createdTabs,send,sendSpoof,chrome,startup,installed,click:()=>actionClick(),external:(message,sender)=>new Promise(resolve=>externalHandler(message,sender,resolve)),alarm:()=>alarm({name:"browser-activation"}),removed:tabId=>onRemoved(tabId),ctx,sockets};
}
test("fast WSS open authenticates before any asynchronous connection bookkeeping",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"enabled"},undefined,{fastOpen:true});
  try {
    assert.equal(e.sockets.length,1);
    const outbound=e.events.filter(x=>x.type==="socket-send").map(x=>JSON.parse(x.data));
    const frames=outbound.filter(x=>x.type==="authenticate");
    assert.equal(frames.length,1,"fast WSS open must not be lost while awaiting storage");
    assert.equal(frames[0].endpoint_id,id);
    assert.equal(frames[0].service_origin,service);
    assert.equal(frames[0].owner_approval_protocol,1);
  } finally {await e.send("stop");}
});

test("Stop on an unpaired Profile remains local and does not invent unconfirmed cloud work",async()=>{
  const env=await setup();
  const result=await env.send("stop");
  assert.equal(result.authorization,"stopped");
  assert.equal(result.cloud_confirmed,true,"there is no cloud Endpoint to stop");
  assert.equal(env.local.pending_cloud_stop,false);
  assert.equal(env.local.authorization,"stopped");
  assert.equal(env.events.filter(e=>e.type==="fetch").length,0);
  const displayed=await env.send("status");
  assert.equal(displayed.pending_cloud_stop,false);
  assert.equal(displayed.connection,"offline");
});

test("owner Stop is persisted before attempting network and survives an offline denial",async()=>{
  const env=await setup({service,endpoint_id:id,credential,authorization:"enabled"},async()=>{
    throw Error("offline");
  });
  const result=await env.send("stop");
  assert.equal(result.authorization,"stopped");
  assert.equal(result.cloud_confirmed,false);
  assert.equal(env.local.authorization,"stopped");
  assert.equal(env.local.pending_cloud_stop,true);
  assert.equal(env.events[0].accessLevel,"TRUSTED_CONTEXTS");
  const fetch=env.events.findIndex(e=>e.type==="fetch");
  const denied=env.events.findIndex(e=>e.type==="persist"&&e.values.authorization==="stopped");
  assert.ok(denied>=0&&fetch>denied);
  const displayed=await env.send("status");
  assert.equal(displayed.authorization,"stopped");
  assert.ok(!Object.hasOwn(displayed,"credential"));
});
test("extension update waits for sensitive session-grant cleanup before reconnect",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"stopped"});
  let finish;
  e.chrome.storage.session.clear=()=>new Promise(resolve=>{finish=resolve;});
  e.local.authorization="enabled";
  e.installed({reason:"update"});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(e.sockets.length,0,"must not reconnect while session clearance remains unconfirmed");
  finish();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(e.sockets.length,1);
  await e.send("stop");
});

test("a stopped Profile never shows persisted stale transport-online after service worker restart",async()=>{
  const env=await setup({service,endpoint_id:id,credential,authorization:"stopped",connection:"online"});
  const status=await env.send("status");
  assert.equal(status.authorization,"stopped");
  assert.equal(status.connection,"offline");
});

test("only the trusted Options can locate the last observed document, never a stale or unspecified tab",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"enabled"});
  await assert.rejects(e.send("locate"),/no_observed_tab/);
  vm.runInContext("lastObserved={tab_id:73,document_id:'stale-document'}",e.ctx);
  await assert.rejects(e.send("locate"),/stale_target/);
  assert.equal(e.events.some(v=>v.type==="focus-tab"),false);
  vm.runInContext("lastObserved={tab_id:73,document_id:'document-73'}",e.ctx);
  const status=await e.send("status");
  assert.equal(status.last_observed_tab_id,73);
  const located=await e.send("locate");
  assert.equal(located.tab_id,73);
  assert.equal(e.events.filter(v=>v.type==="focus-tab").length,1);
  assert.equal(e.events.filter(v=>v.type==="focus-window").length,1);
});

test("only an authenticated observation response populates the transient locate target; Stop clears it",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"enabled"});
  const ws=e.sockets[0];assert.ok(ws,"an enabled Profile opens its own WSS");
  try {
  ws.readyState=1;
  ws.onopen();
  await ws.onmessage({data:JSON.stringify({type:"authenticated",endpoint_id:id,generation:1})});
  vm.runInContext("executeBrowserRead=async()=>({tab_id:73,document_id:'document-73',text:'public'})",e.ctx);
  await ws.onmessage({data:JSON.stringify({type:"read_request",tool:"snapshot",tab_id:73,
    request_id:"33333333-3333-4333-8333-333333333333",generation:1})});
  assert.equal((await e.send("status")).last_observed_tab_id,73);
  } finally {await e.send("stop");}
  assert.equal((await e.send("status")).last_observed_tab_id,null);
});

test("offline local revocation removes credential before reaching network and reports unconfirmed cloud revocation",async()=>{
  const env=await setup({service,endpoint_id:id,credential,authorization:"enabled"});
  const status=await env.send("revoke");
  assert.equal(status.cloud_confirmed,false);
  assert.equal(env.local.authorization,"revoked");
  assert.equal(env.local.credential,undefined);
  assert.equal(env.local.endpoint_id,undefined);
  assert.equal(env.local.pending_revocation_id,id);
  const removed=env.events.findIndex(e=>e.type==="remove");
  const attempted=env.events.findIndex(e=>e.type==="fetch");
  assert.ok(removed>=0&&attempted>removed);
});
test("replayed execute on one WSS generation consumes the local intent once, never opens two tabs",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"enabled"});
  const ws=e.sockets[0],operation_id="77777777-7777-4777-8777-777777777777";
  const intent_key="019a2b3c-4d5e-7aaa-8bbb-1234567890ab";
  const command={endpoint_id:id,intent_key,action:"tab_open",url:"https://example.com/public"};
  try{
    ws.readyState=1;ws.onopen();
    await ws.onmessage({data:JSON.stringify({type:"authenticated",endpoint_id:id,generation:3})});
    await ws.onmessage({data:JSON.stringify({type:"prepare_request",operation_id,intent_key,generation:3,command})});
    const prepared=e.events.filter(v=>v.type==="socket-send").map(v=>JSON.parse(v.data))
      .find(v=>v.type==="prepare_result"&&v.operation_id===operation_id);
    assert.equal(prepared?.accepted,true);
    const execute={type:"execute_request",operation_id,intent_key,generation:3,execute_token:"b".repeat(64)};
    await ws.onmessage({data:JSON.stringify(execute)});
    assert.equal(e.session["browser_consumed_"+operation_id],true);
    assert.equal(e.events.filter(v=>v.type==="create-tab").length,1);
    assert.equal(e.events.filter(v=>v.type==="group-tab").length,1);
    await ws.onmessage({data:JSON.stringify(execute)});
    assert.equal(e.events.filter(v=>v.type==="create-tab").length,1);
    const replies=e.events.filter(v=>v.type==="socket-send").map(v=>JSON.parse(v.data))
      .filter(v=>v.type==="execute_result"&&v.operation_id===operation_id);
    assert.equal(replies.length,1);
    assert.equal(replies[0].state,"completed");
    assert.equal(replies[0].tab_id,74);
    assert.equal(e.session.browser_source_74,"agent_created");
    vm.runInContext("lastObserved={tab_id:74,document_id:'created-doc'}",e.ctx);
    const status=await e.send("status");
    assert.equal(status.last_observed_tab_source,"agent_created");
  }finally{await e.send("stop");}
  assert.equal(e.session.browser_source_74,"agent_created","Stop must retain user tabs and their provenance");
  e.removed(74);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(e.session.browser_source_74,undefined,"manual close clears provenance");
});

test("a failed durable session consumption denies execution, even after a valid prepare",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"enabled"});
  const ws=e.sockets[0],operation_id="88888888-8888-4888-8888-888888888888";
  const intent_key="019a2b3c-4d5e-7aaa-8bbb-1234567890ac";
  const command={endpoint_id:id,intent_key,action:"tab_open",url:"https://example.com/public"};
  try{
    ws.readyState=1;ws.onopen();
    await ws.onmessage({data:JSON.stringify({type:"authenticated",endpoint_id:id,generation:5})});
    await ws.onmessage({data:JSON.stringify({type:"prepare_request",operation_id,intent_key,generation:5,command})});
    assert.ok(e.session["browser_prepare_"+operation_id]);
    const set=e.chrome.storage.session.set;
    e.chrome.storage.session.set=async values=>{
      if(Object.keys(values).some(k=>k.startsWith("browser_consumed_")))throw Error("storage_failed");
      return set(values);
    };
    const execute={type:"execute_request",operation_id,intent_key,generation:5,execute_token:"c".repeat(64)};
    await ws.onmessage({data:JSON.stringify(execute)});
    await ws.onmessage({data:JSON.stringify(execute)});
    assert.equal(e.events.filter(v=>v.type==="create-tab").length,0);
    assert.equal(e.events.filter(v=>v.type==="socket-send").map(v=>JSON.parse(v.data))
      .filter(v=>v.type==="execute_result"&&v.operation_id===operation_id).length,0);
  }finally{await e.send("stop");}
});

test("Stop between prepare and execute prevents any subsequent browser mutation",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"enabled"});
  const ws=e.sockets[0],operation_id="99999999-9999-4999-8999-999999999999";
  const intent_key="019a2b3c-4d5e-7aaa-8bbb-1234567890ad";
  try{
    ws.readyState=1;ws.onopen();
    await ws.onmessage({data:JSON.stringify({type:"authenticated",endpoint_id:id,generation:7})});
    await ws.onmessage({data:JSON.stringify({type:"prepare_request",operation_id,intent_key,generation:7,
      command:{endpoint_id:id,intent_key,action:"tab_open",url:"https://example.com/public"}})});
    assert.ok(e.session["browser_prepare_"+operation_id]);
    await e.send("stop");
    await ws.onmessage({data:JSON.stringify({type:"execute_request",operation_id,intent_key,generation:7,
      execute_token:"d".repeat(64)})});
    assert.equal(e.events.filter(v=>v.type==="create-tab").length,0);
    assert.equal(e.local.authorization,"stopped");
  }finally{if(e.local.authorization==="enabled")await e.send("stop");}
});


test("popup status uses authorized cloud activity counts and never treats offline as zero",async()=>{
  const live=await setup({service,endpoint_id:id,credential,authorization:"stopped"},
    async url=>url.endsWith("/extension/summary")?Response.json({pending:2,unknown:3}):Response.json({}));
  const observed=await live.send("status");
  assert.equal(observed.activity.available,true);
  assert.equal(observed.activity.pending,2);
  assert.equal(observed.activity.unknown,3);
  assert.equal(observed.last_observed_tab_source,"none");
  assert.ok(!Object.hasOwn(observed,"credential"));
  const offline=await setup({service,endpoint_id:id,credential,authorization:"stopped"});
  const unknown=await offline.send("status");
  assert.equal(unknown.activity.available,false);
  assert.equal(unknown.activity.pending,undefined);
  assert.equal(unknown.activity.unknown,undefined);
  vm.runInContext("lastObserved={tab_id:73,document_id:'document-73'}",live.ctx);
  live.local.authorization="enabled";
  const existing=await live.send("status");
  assert.equal(existing.last_observed_tab_source,"existing_or_unknown");
});

test("provenance persistence failing after tab creation never confirms an uncertain effect",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"enabled"});
  const ws=e.sockets[0],operation_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const intent_key="019a2b3c-4d5e-7aaa-8bbb-1234567890ae";
  const command={endpoint_id:id,intent_key,action:"tab_open",url:"https://example.com/public"};
  try{
    ws.readyState=1;ws.onopen();
    await ws.onmessage({data:JSON.stringify({type:"authenticated",endpoint_id:id,generation:8})});
    await ws.onmessage({data:JSON.stringify({type:"prepare_request",operation_id,intent_key,generation:8,command})});
    const original=e.chrome.storage.session.set;
    e.chrome.storage.session.set=async values=>{
      if(Object.keys(values).some(k=>k.startsWith("browser_source_")))throw Error("storage_failed");
      return original(values);
    };
    const execute={type:"execute_request",operation_id,intent_key,generation:8,execute_token:"e".repeat(64)};
    await ws.onmessage({data:JSON.stringify(execute)});
    assert.equal(e.events.filter(v=>v.type==="create-tab").length,1);
    assert.equal(e.session["browser_consumed_"+operation_id],true);
    assert.equal(e.session.browser_source_74,undefined);
    assert.equal(e.events.filter(v=>v.type==="socket-send").map(v=>JSON.parse(v.data))
      .filter(v=>v.type==="execute_result"&&v.operation_id===operation_id).length,0);
    await ws.onmessage({data:JSON.stringify(execute)});
    assert.equal(e.events.filter(v=>v.type==="create-tab").length,1);
  }finally{await e.send("stop");}
});

test("options preserve original-key Unknown semantics and explicit tab close",()=>{
  const popup=fs.readFileSync(path.join(dirname,"../extension/options.js"),"utf8");
  assert.match(popup,/UNCONFIRMED — do not assume zero/);
  assert.match(popup,/ORIGINAL intent_key/);
  assert.match(popup,/Stop\/disconnect\/turn end never auto-close tabs/);
});



const tickUntil=async(condition)=>{for(let i=0;i<80;i++){if(condition())return;await new Promise(r=>setTimeout(r,2));}assert.fail('state did not settle');};
test('only toolbar clicks start new Access activation, no runtime message can Resume or pair',async()=>{
  let verified=false;
  const e=await setup({activation_protocol:2,authorization:'stopped'},async(url)=>{
    if(url.endsWith('/extension/activate-begin'))return Response.json({state:'pending'});
    if(url.endsWith('/extension/activate-complete'))return verified?Response.json({authorization:'enabled',endpoint_id:id,credential,pairing_mode:'permanent'}):Response.json({state:'awaiting_owner'},{status:409});
    if(url.endsWith('/extension/stop'))return Response.json({authorization:'stopped'});
    if(url.endsWith('/extension/activate-cancel'))return Response.json({state:'cancelled'});
    throw Error('unexpected_route');
  });
  await assert.rejects(e.send('resume'),/unsupported_message/);
  await assert.rejects(e.send('pair',{code:'a'.repeat(24)}),/unsupported_message/);
  assert.equal(e.events.some(x=>x.type==='fetch'),false);
  e.click();await tickUntil(()=>e.events.some(x=>x.url?.endsWith('/extension/activate-begin')));
  assert.equal(e.local.endpoint_id,undefined,'Access page alone must never pair');
  await e.alarm();verified=true;await e.alarm();
  await tickUntil(()=>e.local.authorization==='enabled');
  assert.equal(e.local.endpoint_id,id);assert.ok(e.sockets.length>=1);
  await e.send('stop');assert.equal(e.local.authorization,'stopped');
});
test('Access verified wake finishes immediately and closes only the verified extension-created tab once WSS authenticates',async()=>{
  let verified=false;
  const e=await setup({activation_protocol:2,authorization:'stopped'},async(url)=>{
    if(url.endsWith('/extension/activate-begin'))return Response.json({state:'pending'});
    if(url.endsWith('/extension/activate-complete'))return verified?
      Response.json({authorization:'enabled',endpoint_id:id,credential,pairing_mode:'permanent'}):
      Response.json({state:'awaiting_owner'},{status:409});
    if(url.endsWith('/extension/stop'))return Response.json({authorization:'stopped'});
    throw Error('unexpected_route');
  },{fastOpen:true});
  e.click();
  await tickUntil(()=>e.session.browser_activation_tab?.tab_id===74);
  const attempt=e.session.browser_activation_attempt.attempt_id;
  const sender={origin:service,url:service+'/activate/verify/'+attempt+'?extension=test-extension',tab:{id:74}};
  assert.equal((await e.external({type:'activation-verified',attempt_id:attempt},{...sender,tab:{id:83}})).ok,false);
  assert.equal((await e.external({type:'activation-verified',attempt_id:attempt},{...sender,origin:'https://evil.example'})).ok,false);
  assert.equal(e.local.authorization,'stopped','external wake never grants without server proof');
  verified=true;
  assert.equal((await e.external({type:'activation-verified',attempt_id:attempt},sender)).ok,true);
  await tickUntil(()=>e.local.authorization==='enabled');
  assert.equal(e.events.filter(x=>x.type==='remove-tab').length,0,'never close on Access POST alone');
  assert.equal(e.session.browser_activation_tab.confirmed_endpoint_id,id);
  await tickUntil(()=>e.sockets.some(x=>x.readyState===1));
  const ws=e.sockets.at(-1);
  await ws.onmessage({data:JSON.stringify({type:'authenticated',endpoint_id:id,generation:1})});
  await tickUntil(()=>e.events.some(x=>x.type==='remove-tab'));
  assert.deepEqual(e.events.filter(x=>x.type==='remove-tab').map(x=>x.tabId),[74]);
  assert.equal(e.session.browser_activation_tab,undefined);
  assert.equal(e.local.authorization,'enabled');
  await e.send('stop');
});
test('Access wake is not lost when an initial completion poll is still in flight',async()=>{
  let releaseFirst,first=true;
  const hold=new Promise(resolve=>{releaseFirst=resolve;});
  const e=await setup({activation_protocol:2,authorization:'stopped'},async(url)=>{
    if(url.endsWith('/extension/activate-begin'))return Response.json({state:'pending'});
    if(url.endsWith('/extension/activate-complete')){
      if(first){first=false;await hold;return Response.json({state:'awaiting_owner'},{status:409});}
      return Response.json({authorization:'enabled',endpoint_id:id,credential,pairing_mode:'permanent'});
    }
    if(url.endsWith('/extension/stop'))return Response.json({authorization:'stopped'});
    throw Error('unexpected_route');
  });
  e.click();
  await tickUntil(()=>e.session.browser_activation_tab?.tab_id===74 &&
    e.events.some(x=>x.url?.endsWith('/extension/activate-complete')));
  const attempt=e.session.browser_activation_attempt.attempt_id;
  const sender={origin:service,url:service+'/activate/verify/'+attempt+'?extension=test-extension',tab:{id:74}};
  assert.equal((await e.external({type:'activation-verified',attempt_id:attempt},sender)).ok,true);
  releaseFirst();
  await tickUntil(()=>e.local.authorization==='enabled');
  assert.equal(e.events.filter(x=>x.url?.endsWith('/extension/activate-complete')).length,2,
    'the pending wake must trigger immediate recheck rather than a 30-second alarm');
  await e.send('stop');
});
test('successful Access never auto-closes a navigated tab, and Stop rejects stale confirmation',async()=>{
  let verified=false;
  const e=await setup({activation_protocol:2,authorization:'stopped'},async(url)=>{
    if(url.endsWith('/extension/activate-begin'))return Response.json({state:'pending'});
    if(url.endsWith('/extension/activate-complete'))return verified?
      Response.json({authorization:'enabled',endpoint_id:id,credential,pairing_mode:'permanent'}):
      Response.json({state:'awaiting_owner'},{status:409});
    if(url.endsWith('/extension/stop'))return Response.json({authorization:'stopped'});
    if(url.endsWith('/extension/activate-cancel'))return Response.json({state:'cancelled'});
    throw Error('unexpected_route');
  },{fastOpen:true});
  e.click();await tickUntil(()=>e.session.browser_activation_tab?.tab_id===74);
  const attempt=e.session.browser_activation_attempt.attempt_id;
  const sender={origin:service,url:service+'/activate/verify/'+attempt+'?extension=test-extension',tab:{id:74}};
  verified=true;assert.equal((await e.external({type:'activation-verified',attempt_id:attempt},sender)).ok,true);
  await tickUntil(()=>e.local.authorization==='enabled');
  e.createdTabs.set(74,{...e.createdTabs.get(74),url:'https://example.org/other'});
  await tickUntil(()=>e.sockets.some(x=>x.readyState===1));
  await e.sockets.at(-1).onmessage({data:JSON.stringify({type:'authenticated',endpoint_id:id,generation:1})});
  await tickUntil(()=>e.session.browser_activation_tab===undefined);
  assert.equal(e.events.some(x=>x.type==='remove-tab'),false,'navigated tab must be preserved');
  await e.send('stop');
  assert.equal((await e.external({type:'activation-verified',attempt_id:attempt},sender)).ok,false);
  assert.equal(e.events.some(x=>x.type==='remove-tab'),false);
});
test('Stop during pending Access completion blocks late Enable and never persists proof',async()=>{
  let release;
  const hold=new Promise(resolve=>{release=resolve;});
  const e=await setup({activation_protocol:2,authorization:'stopped'},async(url)=>{
    if(url.endsWith('/extension/activate-begin'))return Response.json({state:'pending'});
    if(url.endsWith('/extension/activate-complete')){await hold;return Response.json({authorization:'enabled',endpoint_id:id,credential,pairing_mode:'permanent'});}
    if(url.endsWith('/extension/activate-cancel'))return Response.json({state:'cancelled'});
    if(url.endsWith('/extension/stop'))return Response.json({authorization:'stopped'});
    throw Error('unexpected_route');
  });
  e.click();await tickUntil(()=>e.events.some(x=>x.url?.endsWith('/extension/activate-complete')));
  await e.send('stop');release();await new Promise(r=>setTimeout(r,20));
  assert.equal(e.local.authorization,'stopped');assert.equal(e.local.credential,undefined);
  assert.equal(e.session.browser_activation_attempt,undefined);assert.equal(e.sockets.length,0);
});
test('temporary grant credential stays in trusted session and disappears on browser session end',async()=>{
  const e=await setup({activation_protocol:2,authorization:'stopped'},async(url)=>{
    if(url.endsWith('/extension/activate-begin'))return Response.json({state:'pending'});
    if(url.endsWith('/extension/activate-complete'))return Response.json({authorization:'enabled',endpoint_id:id,credential,pairing_mode:'temporary',lease_expires_at:Date.now()+3600000});
    if(url.endsWith('/extension/stop'))return Response.json({authorization:'stopped'});
    throw Error('unexpected_route');
  });
  await e.send('pairing-preference',{mode:'temporary'});e.click();
  await tickUntil(()=>e.local.authorization==='enabled');
  assert.equal(e.local.credential,undefined);assert.equal(e.local.endpoint_id,undefined);
  assert.equal(e.session.browser_temporary_grant.credential,credential);
  await e.send('stop');await e.chrome.storage.session.clear();
  assert.equal((await e.send('status')).endpoint_id,undefined);
  assert.equal((await e.send('status')).authorization,'stopped');
});

test('protected Access page can acknowledge only the original Profile activation, never a copied callback',async()=>{
  const respond=async(url)=>{
    if(url.endsWith('/extension/activate-begin'))return Response.json({state:'pending'});
    if(url.endsWith('/extension/activate-complete'))return Response.json({state:'awaiting_owner'},{status:409});
    if(url.endsWith('/extension/activate-cancel'))return Response.json({state:'cancelled'});
    throw Error('unexpected_route');
  };
  const first=await setup({activation_protocol:2,authorization:'stopped'},respond);
  const second=await setup({activation_protocol:2,authorization:'stopped'},respond);
  first.click();await tickUntil(()=>first.session.browser_activation_attempt!==undefined);
  const attempt=first.session.browser_activation_attempt.attempt_id;
  const sender={origin:service,url:service+'/activate/verify/'+attempt+'?extension=test-extension'};
  const message={type:'activation-presence',attempt_id:attempt};
  assert.equal((await first.external(message,sender)).ok,true);
  assert.equal((await second.external(message,sender)).ok,false,'copied URL in another Profile has no local attempt');
  assert.equal((await first.external(message,{origin:'https://evil.example',url:sender.url})).ok,false);
  assert.equal((await first.external(message,{origin:service,url:service+'/activate/verify/'+attempt+'?extension=other'})).ok,false);
  await first.send('stop');assert.equal((await first.external(message,sender)).ok,false);
});
