import assert from "node:assert/strict";
import { test } from "node:test";
import { V2OwnerCoordinator } from "../src/v2-pairing.ts";
import { REVIEWED_WINDOWS_UPGRADE_PIN, reviewedWindowsUpgradeTarget } from "../src/install-bootstrap.ts";

const DEVICE = "2a83dae6-600c-49cc-b643-ab0d5ec7e0c8";
function fixture(online: boolean, reported = true) {
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
        last_auth_check_at:Date.now()-1000,device_info_reported:reported,
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


test("new signed WSS epoch cannot borrow old persisted upgrade capability before fresh runtime report",async()=>{
  const f=fixture(true,false);
  const response=await f.request(f.intent());
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:"offline"});
  assert.equal(f.storageValues.has("upgrade:operation:owner-upgrade-39"),false);
});


test("owner DO chooses only the signed Linux architecture from immutable dual-asset review",async()=>{
  const pin={tag:"v0.1.33",commit:"a".repeat(40),
    linux_x64_asset_sha256:"b".repeat(64),
    linux_arm64_asset_sha256:"c".repeat(64),
    protocol:"owner-one-shot-v1"};
  for(const arch of ["x64","arm64"] as const){
    for(const environment of ["native","wsl2"] as const){
      const f=fixture(true);
      const device=f.storageValues.get("device:"+DEVICE) as {device_info:Record<string,unknown>};
      f.storageValues.set("device:"+DEVICE,{...device,
        device_info:{os:"linux",arch,environment,
          agent_version:"v0.1.22",upgrade_protocol:"owner-one-shot-v1"}});
      const response=await f.request({device_id:DEVICE,
        operation_id:"linux-"+arch+"-"+environment,target:pin});
      assert.equal(response.status,200,arch+"/"+environment);
      const body=await response.json() as {status:string;
        preview:{target:Record<string,unknown>}};
      assert.equal(body.status,"prepared");
      assert.deepEqual(body.preview.target,{
        tag:pin.tag,commit:pin.commit,linux_arch:arch,
        linux_asset_sha256:arch==="x64"?pin.linux_x64_asset_sha256:
          pin.linux_arm64_asset_sha256,
      });
      assert.equal(Object.hasOwn(body.preview.target,"release_url"),false);
    }
  }
});

test("owner DO rejects Linux unreviewed pins, unsupported architecture and stale WSS",async()=>{
  const pin={tag:"v0.1.33",commit:"a".repeat(40),
    linux_x64_asset_sha256:"b".repeat(64),
    linux_arm64_asset_sha256:"c".repeat(64),
    protocol:"owner-one-shot-v1"};
  for(const change of [
    {os:"linux",arch:"x64",environment:"container"},
    {os:"linux",arch:"ia32",environment:"native"},
    {os:"linux",arch:"x64",environment:"wsl1"},
    {os:"windows",arch:"x64",environment:"native"},
    {os:"linux",arch:"arm64",environment:"native",upgrade_protocol:undefined},
  ]){
    const f=fixture(true);
    const device=f.storageValues.get("device:"+DEVICE) as {device_info:Record<string,unknown>};
    f.storageValues.set("device:"+DEVICE,{...device,
      device_info:{os:"linux",arch:"x64",environment:"native",
        agent_version:"v0.1.22",upgrade_protocol:"owner-one-shot-v1",...change}});
    const response=await f.request({device_id:DEVICE,
      operation_id:"linux-reject",target:pin});
    assert.equal(response.status,409,JSON.stringify(change));
    assert.equal(f.storageValues.has("upgrade:operation:linux-reject"),false);
  }
  for(const target of [
    {...pin,linux_arm64_asset_sha256:"invalid"},
    {...pin,linux_x64_asset_sha256:"f".repeat(64),url:"https://other.example"},
    {...pin,tag:"v0.1.22"},
    {...pin,tag:"v0.1.33-rc.1"},
  ]){
    const f=fixture(true);
    const device=f.storageValues.get("device:"+DEVICE) as {device_info:Record<string,unknown>};
    f.storageValues.set("device:"+DEVICE,{...device,
      device_info:{os:"linux",arch:"x64",environment:"native",
        agent_version:"v0.1.22",upgrade_protocol:"owner-one-shot-v1"}});
    const response=await f.request({device_id:DEVICE,
      operation_id:"linux-reject",target});
    assert.ok([400,409].includes(response.status));
    assert.equal(f.storageValues.has("upgrade:operation:linux-reject"),false);
  }
});
