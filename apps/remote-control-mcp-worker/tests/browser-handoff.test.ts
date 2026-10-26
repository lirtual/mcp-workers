import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import worker, {V2OwnerCoordinator} from "../src/worker.ts";
import {parseBrowserCall} from "../src/browser-tools.ts";

const device=randomUUID(),session=randomUUID();
test("handoff MCP has exactly request/status/return, no freely supplied email, CLI or session on return",()=>{
  assert.deepEqual(parseBrowserCall("browser_handoff_request",{device_id:device,session_id:session}),{
    device_id:device,tool:"browser_handoff_request",kind:"read",arguments:{session_id:session}});
  for(const name of ["browser_handoff_status","browser_handoff_return"])
    assert.equal(parseBrowserCall(name,{device_id:device})?.tool,name);
  for(const args of [{device_id:device,session_id:session,email:"attacker@example.com"},
    {device_id:device,session_id:session,token:"stolen"},{device_id:device,session_id:session,command:"cloudflared"},
    {device_id:device,session_id:session,duration:3600},{device_id:device,session_id:"invalid"}])
    assert.equal(parseBrowserCall("browser_handoff_request",args),null);
  assert.equal(parseBrowserCall("browser_handoff_return",{device_id:device,session_id:session}),null);
});

test("authenticated MCP -> existing owner DO -> current signed WSS; other device and unauthenticated callers denied",async()=>{
  const epoch="handoff-socket";
  const frames:Array<Record<string,unknown>>=[];
  let coordinator!:V2OwnerCoordinator;
  const socket={readyState:WebSocket.OPEN,deserializeAttachment:()=>({device_id:device,epoch}),close(){},
    send(wire:string){const message=JSON.parse(wire);frames.push(message);
      queueMicrotask(()=>void coordinator.webSocketMessage(socket,JSON.stringify({kind:"read_result",request_id:message.request_id,status:"completed",
        text:JSON.stringify({state:"pending_return",remaining_ms:0,reason:"protected_tunnel_readiness_unverified"})})));}
  } as unknown as WebSocket;
  const records=new Map<string,unknown>([["device:"+device,{device_id:device,revoked:false}],["session:epoch:"+device,epoch]]);
  coordinator=new V2OwnerCoordinator({storage:{get:async<T>(key:string)=>records.get(key) as T|undefined},getWebSockets:(tag:string)=>tag==="device:"+device?[socket]:[]} as unknown as DurableObjectState);
  const env={MCP_ACCESS_TOKEN:"handoff-mcp-test",DEVICE_COORDINATOR:{idFromName:()=>({}),get:()=>({fetch:(url:string,init:RequestInit)=>coordinator.fetch(new Request(url,init))})}} as unknown as Env;
  const call=async(name:string,args:unknown,authenticated=true)=>{
    const response=await worker.fetch(new Request("https://mcp.example.test/mcp",{method:"POST",headers:{"content-type":"application/json",...(authenticated?{authorization:"Bearer handoff-mcp-test"}:{})},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),env);
    return {status:response.status,body:await response.json() as {result?:{isError?:boolean;content?:Array<{text:string}>}}};
  };
  assert.equal((await call("browser_handoff_request",{device_id:device,session_id:session},false)).status,401);
  assert.equal(frames.length,0);
  for(const name of ["browser_handoff_request","browser_handoff_status","browser_handoff_return"]){
    const result=await call(name,{device_id:device,...(name.endsWith("request")?{session_id:session}:{})});
    assert.equal(result.body.result?.isError,false);
    assert.deepEqual(JSON.parse(result.body.result!.content![0]!.text),{state:"pending_return",remaining_ms:0,reason:"protected_tunnel_readiness_unverified"});
    assert.equal(frames.at(-1)?.tool,name);
  }
  assert.equal(frames.length,3);
  assert.equal((await call("browser_handoff_status",{device_id:randomUUID()})).body.result?.isError,true);
  records.delete("session:epoch:"+device);
  assert.equal((await call("browser_handoff_return",{device_id:device})).body.result?.isError,true);
  assert.equal(frames.length,3,"never default to another device or queue offline control");
});

test("handoff discards earlier device replies even when an old reply is awaiting its DO grant check",async()=>{
  const epoch="delayed-device";
  const frames:Array<{kind:string;request_id:string;tool:string}>=[];
  const socket={readyState:WebSocket.OPEN,deserializeAttachment:()=>({device_id:device,epoch}),close(){},send(wire:string){frames.push(JSON.parse(wire));}} as unknown as WebSocket;
  let delay=false,release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const owner=new V2OwnerCoordinator({storage:{get:async(key:string)=>{
    if(delay){await wait;}
    return key==="device:"+device?{device_id:device,revoked:false}:key==="session:epoch:"+device?epoch:undefined;
  }},getWebSockets:()=>[socket]} as unknown as DurableObjectState);
  const dispatch=(tool:string,args:unknown)=>owner.fetch(new Request("https://v2.internal/read",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({device_id:device,tool,arguments:args})}));
  const old=dispatch("browser_snapshot",{session_id:session});
  while(frames.length<1)await new Promise(resolve=>setTimeout(resolve,0));
  delay=true;
  const oldReply=owner.webSocketMessage(socket,JSON.stringify({kind:"read_result",request_id:frames[0]!.request_id,status:"completed",text:"PRIVATE PAGE ALREADY SENT"}));
  delay=false;
  const handoff=dispatch("browser_handoff_request",{session_id:session});
  while(frames.length<2)await new Promise(resolve=>setTimeout(resolve,0));
  const discarded=await old;
  assert.equal(discarded.status,503);
  assert.equal((await discarded.text()).includes("PRIVATE"),false);
  release();await oldReply;
  await owner.webSocketMessage(socket,JSON.stringify({kind:"read_result",request_id:frames[1]!.request_id,status:"completed",text:'{"state":"pending_return"}'}));
  assert.equal((await handoff).status,200);
});

test("native setup and confirmed cleanup keep bounded response budgets beyond ordinary reads",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const epoch="native-setup-budget";
  let delivered!:(frame:{request_id:string})=>void;
  const socket={readyState:WebSocket.OPEN,deserializeAttachment:()=>({device_id:device,epoch}),close(){},
    send(wire:string){delivered(JSON.parse(wire));}} as unknown as WebSocket;
  const owner=new V2OwnerCoordinator({storage:{get:async(key:string)=>key==="device:"+device?{device_id:device,revoked:false}:key==="session:epoch:"+device?epoch:undefined},getWebSockets:()=>[socket]} as unknown as DurableObjectState);
  const dispatch=(tool:string,args:unknown)=>owner.fetch(new Request("https://v2.internal/read",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({device_id:device,tool,arguments:args})}));
  try {
    for(const tool of ["browser_handoff_request","browser_handoff_return"]) {
      const frame=new Promise<{request_id:string}>(resolve=>{delivered=resolve;});
      let settled=false;
      const pending=dispatch(tool,tool.endsWith("request")?{session_id:session}:{}).then(result=>{settled=true;return result;});
      const request=await frame;
      // Handoff setup may take the full Agent drain + URL mint + 90s challenge.
      // Ordinary return still retains its independent 30s budget.
      t.mock.timers.tick(tool==="browser_handoff_request"?125_000:6000);await Promise.resolve();
      assert.equal(settled,false,"handoff response budget must cover native protected setup");
      await owner.webSocketMessage(socket,JSON.stringify({kind:"read_result",request_id:request.request_id,status:"completed",text:'{"state":"link_ready"}'}));
      assert.equal((await pending).status,200);
    }
    const frame=new Promise<{request_id:string}>(resolve=>{delivered=resolve;});
    const pending=dispatch("browser_handoff_status",{});await frame;t.mock.timers.tick(5001);
    assert.equal((await pending).status,503,"status retains the ordinary bounded budget");
  } finally {t.mock.timers.reset();}
});
