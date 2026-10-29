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
  const local={...initial}; const session={}; const events=[]; const sockets=[];
  let handler, startup, installed, onRemoved;
  const chrome={
    tabs:{
      query:async()=>[{id:73,windowId:5,incognito:false}],
      onRemoved:{addListener(fn){onRemoved=fn;}},
      async get(tabId){events.push({type:"lookup-tab",tabId});return {id:73,url:"https://example.com/public",windowId:5,incognito:false,active:false};},
      async update(tabId,options){events.push({type:"focus-tab",tabId,options});return {id:tabId};},
      async create(options){events.push({type:"create-tab",options});return {id:74,...options};},
      async remove(tabId){events.push({type:"remove-tab",tabId});},
      async group(options){events.push({type:"group-tab",options});return 8;}
    },
    tabGroups:{query:async()=>[],async update(groupId,options){events.push({type:"group-title",groupId,options});}},
    windows:{async update(windowId,options){events.push({type:"focus-window",windowId,options});return {id:windowId};}},
    webNavigation:{async getFrame({tabId,frameId}){events.push({type:"lookup-document",tabId,frameId});return {url:"https://example.com/public",documentId:"document-73",documentLifecycle:"active"};}},
    action:{setBadgeText:async()=>{},setTitle:async()=>{}},
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
      onMessage:{addListener(fn){handler=fn;}},
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
      handler({type,...props},{id:"test-extension",url:"chrome-extension://test-extension/popup.html"},answer=>answer?.ok?resolve(answer.result):reject(Error(answer?.error||"unknown")));
    });
  }
  const sendSpoof=(type,sender)=>new Promise(resolve=>handler({type},sender,resolve));
  return {local,session,events,send,sendSpoof,chrome,startup,installed,removed:tabId=>onRemoved(tabId),ctx,sockets};
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

test("only the trusted Popup can locate the last observed document, never a stale or unspecified tab",async()=>{
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

test("an unconfirmed cloud Stop blocks local Resume rather than expanding authorization",async()=>{
  const env=await setup({service,endpoint_id:id,credential,authorization:"stopped",pending_cloud_stop:true});
  await assert.rejects(env.send("resume"),/cloud_stop_not_confirmed/);
  assert.equal(env.local.authorization,"stopped");
  assert.equal(env.local.pending_cloud_stop,true);
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
test("pairing keeps a new Profile stopped until local Resume succeeds",async()=>{
  const env=await setup({},async(url)=>{
    if(url.endsWith("/extension/claim"))
      return Response.json({endpoint_id:id,credential,authorization:"stopped"});
    throw Error("offline");
  });
  const outcome=await env.send("pair",{service,alias:"My Chrome Profile",code:"a".repeat(24)});
  assert.equal(outcome.authorization,"stopped");
  assert.equal(env.local.authorization,"stopped");
  assert.equal(env.local.endpoint_id,id);
  assert.equal(env.local.credential,credential);
  await assert.rejects(env.send("resume"),/offline/);
  assert.equal(env.local.authorization,"stopped");
});

test("unconfirmed cloud revocation blocks re-pair until explicit local acknowledgment",async()=>{
  const env=await setup({authorization:"revoked",pending_revocation_id:id});
  await assert.rejects(env.send("pair",{service,alias:"new-profile",code:"a".repeat(24)}),/cloud_revocation_unconfirmed/);
  await env.send("ack-revocation");
  assert.equal(env.local.pending_revocation_id,null);
});

test("extension refuses to send credentials or pairing code to unpinned service host",async()=>{
  const e=await setup({service:"https://attacker.example",endpoint_id:id,credential,authorization:"stopped"});
  await assert.rejects(e.send("resume"),/invalid_service/);
  assert.equal(e.events.filter(x=>x.type==="fetch").length,0);
  const fresh=await setup({});
  await assert.rejects(fresh.send("pair",{service:"https://attacker.example",code:"a".repeat(24),alias:"trusted"}),/invalid_pairing_details/);
  assert.equal(fresh.events.filter(x=>x.type==="fetch").length,0);
});

test("content scripts cannot send privileged commands, and service URL is pinned",async()=>{
  const env=await setup({service,endpoint_id:id,credential,authorization:"stopped"});
  const sender={id:"test-extension",url:"https://example.com/"};
  const result=await env.sendSpoof("resume",sender);
  assert.equal(result.error,"untrusted_sender");
  // The test harness exposes the registered handler below instead of creating a page.
  assert.equal(env.local.authorization,"stopped");
  await assert.rejects(env.send("pair",{service:"https://attacker.example",alias:"x",code:"a".repeat(24)}),/invalid_pairing_details|revoke_existing_endpoint_first/);
  assert.ok(env.events.some(e=>e.type==="access"&&e.accessLevel==="TRUSTED_CONTEXTS"));
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

test("popup explicitly preserves original-key Unknown semantics and explicit tab close",()=>{
  const popup=fs.readFileSync(path.join(dirname,"../extension/popup.js"),"utf8");
  assert.match(popup,/UNCONFIRMED — do not assume zero/);
  assert.match(popup,/ORIGINAL intent_key/);
  assert.match(popup,/Stop\/disconnect\/turn end never auto-close tabs/);
});


test("Stop wins over an earlier delayed local Enable response; stale resume cannot grant or reconnect",async()=>{
  let completeResume;
  const resumePromise=new Promise(resolve=>{completeResume=resolve;});
  let cloud="stopped",stopCalls=0;
  const e=await setup({service,endpoint_id:id,credential,authorization:"stopped"},
    async url=>{
      if(url.endsWith("/extension/resume")){
        await resumePromise;
        cloud="enabled"; // simulate the delayed Cloud request completing AFTER Stop
        return Response.json({authorization:"enabled"});
      }
      if(url.endsWith("/extension/stop")){
        cloud="stopped";stopCalls++;
        return Response.json({authorization:"stopped"});
      }
      throw Error("fixture_unexpected_route");
    });
  const enabling=e.send("resume");
  await new Promise(resolve=>setTimeout(resolve,0));
  const stopping=await e.send("stop");
  assert.equal(stopping.authorization,"stopped");
  assert.equal(stopping.cloud_confirmed,false,"an older pending cloud Enable means cloud Stop is not final yet");
  assert.equal(e.local.pending_cloud_stop,true);
  assert.equal(cloud,"stopped");
  completeResume();
  await assert.rejects(enabling,/authorization_changed|stopped/);
  assert.equal(e.local.authorization,"stopped","stale Enable response must not overwrite Stop");
  assert.equal(e.sockets.length,0,"stale Enable must not connect WSS");
  assert.equal(cloud,"stopped","late cloud Resume needs a compensating stop");
  assert.ok(stopCalls>=2,"Stop must be reasserted after the stale cloud Resume");
  assert.equal(e.local.pending_cloud_stop,false);
});


test("Stop still wins if the earlier Enable storage write completes after Stop's write",async()=>{
  const e=await setup({service,endpoint_id:id,credential,authorization:"stopped"},async url=>{
    if(url.endsWith("/extension/resume"))return Response.json({authorization:"enabled"});
    if(url.endsWith("/extension/stop"))return Response.json({authorization:"stopped"});
    throw Error("unexpected_mock_route");
  });
  let release,arrived;
  const pending=new Promise(resolve=>{arrived=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const original=e.chrome.storage.local.set;
  e.chrome.storage.local.set=async v=>{
    if(v.authorization==="enabled"){
      arrived();
      await gate;
    }
    return original(v);
  };
  const enabling=e.send("resume");
  await pending;
  const stopping=await e.send("stop");
  assert.equal(stopping.authorization,"stopped");
  release();
  await assert.rejects(enabling,/local_authorization_changed/);
  assert.equal(e.local.authorization,"stopped");
  assert.equal(e.local.pending_cloud_stop,false);
  assert.equal(e.sockets.length,0);
});


test("a delayed Enable cannot restore a Profile after local Revoke",async()=>{
  let finishEnable;
  const gate=new Promise(resolve=>{finishEnable=resolve;});
  const e=await setup({service,endpoint_id:id,credential,authorization:"stopped"},async url=>{
    if(url.endsWith("/extension/resume")){
      await gate;
      return Response.json({authorization:"enabled"});
    }
    if(url.endsWith("/extension/revoke"))return Response.json({authorization:"revoked"});
    throw Error("unexpected_route");
  });
  const enabling=e.send("resume");
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal((await e.send("revoke")).cloud_confirmed,true);
  finishEnable();
  await assert.rejects(enabling,/local_authorization_changed/);
  assert.equal(e.local.authorization,"revoked");
  assert.equal(e.local.credential,undefined);
  assert.equal(e.local.endpoint_id,undefined);
  assert.equal(e.sockets.length,0);
});

test("a failed compensating Stop leaves cloud status explicitly pending, never re-enables locally",async()=>{
  let finishEnable,stopCalls=0;
  const gate=new Promise(resolve=>{finishEnable=resolve;});
  const e=await setup({service,endpoint_id:id,credential,authorization:"stopped"},async url=>{
    if(url.endsWith("/extension/resume")){
      await gate;
      return Response.json({authorization:"enabled"});
    }
    if(url.endsWith("/extension/stop")){
      if(++stopCalls===1)return Response.json({authorization:"stopped"});
      throw Error("offline_after_stale_enable");
    }
    throw Error("unexpected_route");
  });
  const enabling=e.send("resume");
  await new Promise(resolve=>setTimeout(resolve,0));
  const stopped=await e.send("stop");
  assert.equal(stopped.cloud_confirmed,false);
  finishEnable();
  await assert.rejects(enabling,/local_authorization_changed/);
  assert.equal(stopCalls,2);
  assert.equal(e.local.authorization,"stopped");
  assert.equal(e.local.pending_cloud_stop,true);
  assert.equal(e.sockets.length,0);
});
