import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { V2OwnerCoordinator } from "../src/worker.ts";
import { parseBrowserCall } from "../src/browser-tools.ts";

/**
 * Isolated DO/Browser contract gate. Simulates an ALREADY-authorized WSS
 * incarnation; cryptographic nonce proof is verified by v2-session.test.ts
 * and the actual Agent execution path by its own browser-wss.test.ts.
 * No production browser MCP tools are enabled by this test.
 */
test("browser DO routes typed read/effect frames only to the current approved device",async()=>{
  const device=randomUUID(), other=randomUUID(), sid=randomUUID(), epoch="test-epoch";
  const calls:Array<{kind:string;tool:string;args:Record<string,unknown>;operation_id?:string}>=[];
  let owner!:V2OwnerCoordinator;
  const server={
    readyState:WebSocket.OPEN,
    deserializeAttachment:()=>({device_id:device,epoch}),
    send(frame:string){
      const request=JSON.parse(frame) as {kind:string;tool:string;
        request_id:string;operation_id?:string;arguments:Record<string,unknown>};
      calls.push({kind:request.kind,tool:request.tool,
        args:request.arguments,operation_id:request.operation_id});
      // Fake current Agent response. This test verifies only the DO contract.
      const response=request.kind==="read"
        ? {kind:"read_result",request_id:request.request_id,status:"completed",
           text:JSON.stringify({session_id:sid,selected_tab_id:"tab-1"})}
        : {kind:"operation_result",request_id:request.request_id,
           result:{operation_id:request.operation_id,status:"completed",
             session_id:sid,private_internal_note:"never forward this"}};
      queueMicrotask(()=>{void owner.webSocketMessage(server as WebSocket,JSON.stringify(response));});
    },
    close(){},
  } as unknown as WebSocket;
  const records=new Map<string,unknown>([
    ["device:"+device,{device_id:device,revoked:false}],
    ["session:epoch:"+device,epoch],
  ]);
  owner=new V2OwnerCoordinator({
    storage:{get:async<T>(key:string)=>records.get(key) as T|undefined},
    getWebSockets:(tag:string)=>tag==="device:"+device?[server]:[],
  } as unknown as DurableObjectState);
  async function dispatch(tool:string,target:string,args:Record<string,unknown>){
    const parsed=parseBrowserCall(tool,{device_id:target,...args});
    if(!parsed)return {status:400,body:{error:"parser_rejected"}};
    const response=await owner.fetch(new Request("https://v2.internal/"+parsed.kind,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({device_id:parsed.device_id,tool:parsed.tool,
        arguments:parsed.arguments,
        ...(parsed.operation_id?{operation_id:parsed.operation_id}:{})}),
    }));
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  }

  const initial=await dispatch("browser_status",device,{});
  assert.equal(initial.status,200);
  assert.match(String(initial.body.text),new RegExp(sid));
  assert.deepEqual(calls.map(call=>[call.kind,call.tool]),[["read","browser_status"]]);

  const tabList=await dispatch("browser_tabs",device,{session_id:sid,action:"list"});
  assert.equal(tabList.status,200);
  assert.equal(calls.at(-1)?.kind,"read");
  const tabId="spec152-new-"+randomUUID();
  const tabEffect=await dispatch("browser_tabs",device,
    {session_id:sid,action:"new",operation_id:tabId});
  assert.equal(tabEffect.status,200);
  assert.equal(tabEffect.body.status,"completed");
  assert.equal(calls.at(-1)?.kind,"operation");
  assert.equal(calls.at(-1)?.operation_id,tabId);

  const privateValue="test-not-for-receipt";
  const fillId="spec152-fill-"+randomUUID();
  const fill=await dispatch("browser_fill",device,{
    session_id:sid,operation_id:fillId,
    role:"textbox",name:"Search",snapshot_version:1,text:privateValue,
  });
  assert.equal(fill.status,200);
  assert.equal(fill.body.status,"completed");
  assert.equal(calls.at(-1)?.tool,"browser_fill");
  assert.equal(calls.at(-1)?.args.text,privateValue);
  assert.equal(JSON.stringify(fill.body).includes(privateValue),false);
  assert.equal(JSON.stringify(fill.body).includes("private_internal_note"),false);

  const beforeDenied=calls.length;
  const unapproved=await dispatch("browser_status",other,{});
  assert.equal(unapproved.status,503);
  const impersonated=await dispatch("browser_fill",device,{
    session_id:sid,operation_id:"spec152-forged-"+randomUUID(),
    role:"textbox",name:"Search",snapshot_version:1,text:"a",approved:true,
  });
  assert.equal(impersonated.status,400);
  const privateUrl=await dispatch("browser_navigate",device,{
    session_id:sid,operation_id:"spec152-private-"+randomUUID(),
    url:"http://127.0.0.1/private",tab_id:"tab-1",snapshot_version:0,
  });
  assert.equal(privateUrl.status,400);
  assert.equal(calls.length,beforeDenied,"invalid or unapproved commands do not reach Agent WSS");

  // A server-disconnected device must not silently use another socket.
  records.delete("session:epoch:"+device);
  const stale=await dispatch("browser_status",device,{});
  assert.equal(stale.status,503);
  assert.equal(calls.length,beforeDenied);
});
