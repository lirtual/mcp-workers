import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

test("Worker reassembles bounded signed-device image frames without durable image storage",async()=>{
  const deviceId=randomUUID(),epoch="epoch-image";
  const uuid=randomUUID();
  const jpeg=Buffer.from([255,216,255,224,...Array.from({length:32000},()=>0),255,217]).toString("base64");
  const observed={
    type:"desktop_image",mime_type:"image/jpeg",data:jpeg,
    width:800,height:450,native_width:1600,native_height:900,
    origin_x:0,origin_y:0,target_id:"primary",session_id:1,
    observation_id:uuid,grant_generation:randomUUID(),
  };
  const records=new Map<string,unknown>([
    ["device:"+deviceId,{device_id:deviceId,revoked:false}],
    ["session:epoch:"+deviceId,epoch],
  ]);
  let writes=0;
  const storage={
    get:async<T>(key:string)=>records.get(key) as T|undefined,
    put:async()=>{writes++;throw Error("Screenshot should not persist in Durable Object");},
  };
  let owner!:V2OwnerCoordinator;
  let corruptNext=false, simulateStop=false;
  const fromDevice:Array<Record<string,unknown>>=[];
  const server={
    readyState:WebSocket.OPEN,
    deserializeAttachment:()=>({device_id:deviceId,epoch}),
    send(text:string){
      const request=JSON.parse(text) as Record<string,unknown>;
      assert.equal(request.kind,"read");
      assert.equal(request.tool,"computer_observe");
      assert.deepEqual(request.arguments,{target_kind:"display",target_id:"primary"});
      const id=request.request_id;
      const deliver=(frame:Record<string,unknown>)=>{
        fromDevice.push(frame);
        queueMicrotask(()=>{void owner.webSocketMessage(server as WebSocket,JSON.stringify(frame));});
      };
      queueMicrotask(()=>{
        if(simulateStop){
          deliver({kind:"read_result",request_id:id,status:"failed",error:"desktop_stopped"});
          return;
        }
        for(let offset=0,seq=0;offset<observed.data.length;offset+=24000,seq++){
          deliver({kind:"image_chunk",request_id:id,
            seq:corruptNext?99:seq,chunk:observed.data.slice(offset,offset+24000)});
        }
        const {data,...metadata}=observed;
        deliver({kind:"image_result",request_id:id,status:"completed",metadata});
      });
    },
    close(){ /* simulated peer closure */ },
  } as unknown as WebSocket;
  owner=new V2OwnerCoordinator({
    storage,getWebSockets:()=>[server],
  } as unknown as DurableObjectState);
  const env={
    MCP_ACCESS_TOKEN:"test-token",
    DEVICE_COORDINATOR:{
      idFromName:()=> "owner",
      get:()=>({fetch:(u:RequestInfo|URL,init?:RequestInit)=>owner.fetch(u instanceof Request?u:new Request(u,init))}),
    },
  } as unknown as Env;
  const call=async(id:string)=> {
    const response=await worker.fetch(new Request("https://example.test/mcp",{
      method:"POST",headers:{"authorization":"Bearer test-token","content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{
        name:"computer_observe",arguments:{device_id:id,target_kind:"display",target_id:"primary"},
      }}),
    }),env);
    return response.json() as Promise<{result:{isError:boolean;content:Array<{type:string;data?:string;text?:string}>}}>;
  };
  try{
    const good=await call(deviceId);
    assert.equal(good.result.isError,false);
    assert.equal(good.result.content[0]?.type,"image");
    assert.equal(good.result.content[0]?.data,jpeg);
    assert.match(good.result.content[1]?.text??"",/native_width/);
    assert.ok(fromDevice.filter(f=>f.kind==="image_chunk").length>1);
    assert.equal(fromDevice.at(-1)?.kind,"image_result");
    assert.equal(writes,0);
    simulateStop=true;
    const stopped=await call(deviceId);
    assert.equal(stopped.result.isError,true);
    assert.match(stopped.result.content[0]?.text ?? "",/stopped locally/);
    simulateStop=false;
    corruptNext=true;
    const damaged=await call(deviceId);
    assert.equal(damaged.result.isError,true);
    corruptNext=false;
    records.set("device:"+deviceId,{device_id:deviceId,revoked:true});
    const revoked=await call(deviceId);
    assert.equal(revoked.result.isError,true);
    const missing=await call(randomUUID());
    assert.equal(missing.result.isError,true);
    assert.equal(writes,0);
  } finally{
    server.close();
  }
});
