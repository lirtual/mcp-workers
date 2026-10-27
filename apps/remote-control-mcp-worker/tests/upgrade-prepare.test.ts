import assert from "node:assert/strict";
import { test } from "node:test";
import { V2OwnerCoordinator } from "../src/v2-pairing.ts";
import { REVIEWED_WINDOWS_UPGRADE_PIN, reviewedWindowsUpgradeTarget } from "../src/install-bootstrap.ts";

const DEVICE = "2a83dae6-600c-49cc-b643-ab0d5ec7e0c8";
function fixture(online: boolean) {
  const storageValues = new Map<string, unknown>([
    ["device:"+DEVICE, {device_id:DEVICE,name:"RAY-WORKSPACE",
      public_key:"signed-fixture",fingerprint:"0123456789abcdef01234567",
      revoked:false,grant_type:"permanent",approved_at:Date.now()-60_000,
      device_info:{os:"windows",environment:"native",arch:"x64",
        agent_version:"v0.1.31-rc.1",upgrade_protocol:"owner-one-shot-v1"}}],
    ["session:epoch:"+DEVICE,"signed-session-epoch"],
  ]);
  let tail = Promise.resolve();
  let store: Pick<DurableObjectStorage,"get"|"put"|"transaction">;
  store = {
    get: async <T>(key:string)=>structuredClone(storageValues.get(key)) as T|undefined,
    put:async(key:string,value:unknown)=>{storageValues.set(key,structuredClone(value));},
    transaction:async <T>(fn:(tx:DurableObjectTransaction)=>Promise<T>)=>{
      const prior=tail;let release!:()=>void;
      tail=new Promise(resolve=>{release=resolve;});await prior;
      try{return await fn(store as unknown as DurableObjectTransaction);}
      finally{release();}
    },
  } as unknown as typeof store;
  const state={
    storage:store,
    getWebSockets:()=>online ? [{
      readyState:WebSocket.OPEN,
      deserializeAttachment:()=>({
        device_id:DEVICE,epoch:"signed-session-epoch",
        last_auth_check_at:Date.now()-1000,
      }),
    }] : [],
  } as unknown as DurableObjectState;
  const owner=new V2OwnerCoordinator(state);
  const request=async(body:unknown)=>
    owner.fetch(new Request("https://v2.internal/upgrade/prepare",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(body),
    }));
  const intent=(id="owner-upgrade-39")=>({
    operation_id:id,device_id:DEVICE,target:REVIEWED_WINDOWS_UPGRADE_PIN,
  });
  return {request,intent,storageValues};
}
test("server pin resolver rejects arbitrary version, URLs and checksums",()=>{
  assert.equal(reviewedWindowsUpgradeTarget(REVIEWED_WINDOWS_UPGRADE_PIN.tag),REVIEWED_WINDOWS_UPGRADE_PIN);
  assert.equal(reviewedWindowsUpgradeTarget("v0.1.31-rc.1"),null);
  assert.equal(reviewedWindowsUpgradeTarget("v99.99.99"),null);
  assert.equal(reviewedWindowsUpgradeTarget({tag:REVIEWED_WINDOWS_UPGRADE_PIN.tag}),null);
  assert.equal(Object.isFrozen(REVIEWED_WINDOWS_UPGRADE_PIN),true);
});
test("internal preparation fails closed without currently authenticated device WSS",async()=>{
  const f=fixture(false);
  const res=await f.request(f.intent());
  assert.equal(res.status,503);
  assert.deepEqual(await res.json(),{error:"offline"});
  assert.equal(f.storageValues.has("upgrade:operation:owner-upgrade-39"),false);
});
test("live signed permanent Windows may prepare only one exact immutable request",async()=>{
  const f=fixture(true);
  const first=await f.request(f.intent());
  assert.equal(first.status,200);
  const result=await first.json() as {status:string;confirmation:string;preview:{device_id:string;target:{windows_asset_sha256:string}}};
  assert.equal(result.status,"prepared");
  assert.match(result.confirmation,/^[a-f0-9]{64}$/);
  assert.equal(result.preview.device_id,DEVICE);
  assert.equal(result.preview.target.windows_asset_sha256,REVIEWED_WINDOWS_UPGRADE_PIN.windows_asset_sha256);
  assert.equal((await f.request(f.intent())).status,409,"same operation cannot mint a second secret");
  assert.equal((await f.request(f.intent("second-upgrade"))).status,409,"same device cannot prepare concurrent requests");
  assert.equal(f.storageValues.has("upgrade:operation:second-upgrade"),false);
});
test("internal payload rejects command and arbitrary unknown keys",async()=>{
  const f=fixture(true);
  for(const data of [
    {...f.intent(),command:"powershell -c malicious"},
    {...f.intent(),target:{...REVIEWED_WINDOWS_UPGRADE_PIN,url:"https://evil.example"}},
    {...f.intent(),operation_id:"../../unsafe"},
    {...f.intent(),device_id:"invalid"},
  ]){
    const result=await f.request(data);
    assert.equal(result.status,400);
  }
  assert.equal(f.storageValues.has("upgrade:operation:owner-upgrade-39"),false);
});
