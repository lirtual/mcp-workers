import assert from "node:assert/strict";
import { test } from "node:test";
import { V2OwnerCoordinator } from "../src/worker.ts";
import { REVIEWED_WINDOWS_UPGRADE_PIN } from "../src/install-bootstrap.ts";

const DEVICE = "2a83dae6-600c-49cc-b643-ab0d5ec7e0c8";
const now = Date.now();
const epoch = "fresh-signed-epoch";
function fixture(reply: "admitted" | "silent" = "admitted") {
  const records = new Map<string, unknown>([
    ["device:"+DEVICE,{
      device_id: DEVICE, name: "RAY-WORKSPACE", public_key:"fixed-key",
      fingerprint:"1234567890abcdef12345678", revoked:false, grant_type:"permanent",
      approved_at:now-60000, device_info:{os:"windows",arch:"x64",environment:"native",
        agent_version:"v0.1.31-rc.1",upgrade_protocol:"owner-one-shot-v1"},
    }],
    ["session:epoch:"+DEVICE,epoch],
  ]);
  let serial = Promise.resolve();
  let storage: Pick<DurableObjectStorage,"get"|"put"|"transaction">;
  storage = {
    get:async<T>(key:string)=>structuredClone(records.get(key)) as T|undefined,
    put:async(key:string,value:unknown)=>{records.set(key,structuredClone(value));},
    transaction:async<T>(fn:(tx:DurableObjectTransaction)=>Promise<T>)=>{
      const previous=serial;let release!:()=>void;
      serial=new Promise<void>(resolve=>{release=resolve;});
      await previous;
      try{return await fn(storage as unknown as DurableObjectTransaction);}
      finally{release();}
    },
  } as unknown as typeof storage;
  const frames:Array<Record<string,unknown>>=[];
  let owner!:V2OwnerCoordinator;
  let live = true;
  const ws = {
    readyState:WebSocket.OPEN,
    deserializeAttachment:()=>({device_id:DEVICE,epoch,last_auth_check_at:Date.now()-100,device_info_reported:true}),
    send(frame:string) {
      const request=JSON.parse(frame) as Record<string,unknown>;
      frames.push(request);
      if (reply === "admitted") queueMicrotask(()=>{void owner.webSocketMessage(ws as WebSocket,
        JSON.stringify({kind:"operation_result",request_id:request.request_id,
          result:{operation_id:request.operation_id,status:"admitted"}}));});
    },
    close() {live=false;},
  } as unknown as WebSocket;
  owner = new V2OwnerCoordinator({
    storage,
    getWebSockets:(name:string)=>live && name==="device:"+DEVICE?[ws]:[],
  } as unknown as DurableObjectState);
  const send = async (route:string,body:object)=>{
    const resp=await owner.fetch(new Request("https://v2.internal"+route,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
    }));
    return {code:resp.status, data:await resp.json() as Record<string,unknown>};
  };
  return {send,frames,records,setLive:(v:boolean)=>{live=v;}};
}
test("approved owner POST consumes once, sends one exact signed WSS admission, never switches Task",async()=>{
  const f=fixture();
  const p=await f.send("/upgrade/prepare",{
    device_id:DEVICE,operation_id:"one-wss-upgrade",target:REVIEWED_WINDOWS_UPGRADE_PIN,
  });
  assert.equal(p.code,200,JSON.stringify(p.data));
  assert.equal(p.data.status,"prepared");
  assert.equal(f.frames.length,0);
  const preview=await f.send("/upgrade/preview",{
    operation_id:"one-wss-upgrade",confirmation:p.data.confirmation,
  });
  assert.equal(preview.code,200);
  assert.equal(f.frames.length,0);
  const confirmed=await f.send("/upgrade/confirm",{
    operation_id:"one-wss-upgrade",confirmation:p.data.confirmation,
    form_token:preview.data.form_token,
  });
  assert.equal(confirmed.code,200);
  assert.deepEqual(confirmed.data,{approved:true,status:"admitted"});
  assert.equal(f.frames.length,1,"exactly one WSS frame for one approval");
  const frame=f.frames[0]!;
  assert.equal(frame.kind,"operation");
  assert.equal(frame.tool,"upgrade_agent");
  const payload=frame.arguments as Record<string,unknown>;
  assert.equal(frame.operation_id,"one-wss-upgrade");
  assert.equal(payload.operation_id,"one-wss-upgrade");
  assert.equal(payload.device_id,DEVICE);
  assert.deepEqual(payload.target,REVIEWED_WINDOWS_UPGRADE_PIN);
  assert.ok(typeof payload.approved_at==="number");
  assert.ok(typeof payload.expires_at==="number");
  assert.ok(!Object.hasOwn(payload,"command"));
  assert.ok(!Object.hasOwn(payload,"url"));
  const replay=await f.send("/upgrade/confirm",{
    operation_id:"one-wss-upgrade",confirmation:p.data.confirmation,
    form_token:preview.data.form_token,
  });
  assert.equal(replay.code,409);
  assert.equal(f.frames.length,1);
  const row=f.records.get("upgrade:operation:one-wss-upgrade") as {state:string};
  assert.equal(row.state,"claimed");
});
test("WSS offline after preparation consumes confirmed approval without dispatch replay",async()=>{
  const f=fixture();
  const p=await f.send("/upgrade/prepare",{
    device_id:DEVICE,operation_id:"no-wss-upgrade",target:REVIEWED_WINDOWS_UPGRADE_PIN,
  });
  assert.equal(p.code,200,JSON.stringify(p.data));
  const view=await f.send("/upgrade/preview",{
    operation_id:"no-wss-upgrade",confirmation:p.data.confirmation,
  });
  assert.equal(view.code,200);
  f.setLive(false);
  const result=await f.send("/upgrade/confirm",{
    operation_id:"no-wss-upgrade",confirmation:p.data.confirmation,
    form_token:view.data.form_token,
  });
  assert.equal(result.code,200);
  assert.deepEqual(result.data,{approved:true,status:"needs_attention"});
  assert.equal(f.frames.length,0);
  const row=f.records.get("upgrade:operation:no-wss-upgrade") as {state:string};
  assert.equal(row.state,"needs_attention");
  assert.equal((await f.send("/upgrade/confirm",{
    operation_id:"no-wss-upgrade",confirmation:p.data.confirmation,
    form_token:view.data.form_token,
  })).code,409);
});
