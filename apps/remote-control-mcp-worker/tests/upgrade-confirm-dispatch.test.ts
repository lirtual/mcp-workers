import assert from "node:assert/strict";
import { test } from "node:test";
import { V2OwnerCoordinator } from "../src/v2-pairing.ts";
import { presentOwnerUpgrade, readOwnerUpgrade, UPGRADE_UNCONFIRMED_ATTENTION_MS } from "../src/upgrade-approval.ts";
import { REVIEWED_WINDOWS_UPGRADE_PIN } from "../src/install-bootstrap.ts";

const DEVICE="2a83dae6-600c-49cc-b643-ab0d5ec7e0c8";
function fixture() {
  const data=new Map<string,unknown>([
    ["device:"+DEVICE,{device_id:DEVICE,name:"RAY-WORKSPACE",revoked:false,
      public_key:"test-public-spki",fingerprint:"0123456789abcdef01234567",
      approved_at:Date.now()-1000,grant_type:"permanent",
      device_info:{os:"windows",arch:"x64",environment:"native",
        agent_version:"v0.1.31-rc.1",upgrade_protocol:"owner-one-shot-v1"}}],
    ["session:epoch:"+DEVICE,"signed-epoch"],
  ]);
  let serial=Promise.resolve();
  let storage:Pick<DurableObjectStorage,"get"|"put"|"transaction">;
  storage={
    get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined,
    put:async(key:string,v:unknown)=>{data.set(key,structuredClone(v));},
    transaction:async<T>(fn:(tx:DurableObjectTransaction)=>Promise<T>)=>{
      const prior=serial;let release!:()=>void;
      serial=new Promise(resolve=>{release=resolve;}); await prior;
      try{return await fn(storage as unknown as DurableObjectTransaction);}
      finally{release();}
    },
  } as unknown as typeof storage;
  let sent=0;
  let owner:V2OwnerCoordinator;
  let respond=true;
  let currentEpoch="signed-epoch";
  let receiptState:"completed"|"failed"="completed";
  const frames:Record<string,unknown>[]=[];
  const socket={
    readyState:WebSocket.OPEN,
    deserializeAttachment:()=>({device_id:DEVICE,epoch:currentEpoch,
      last_auth_check_at:Date.now()-1000,device_info_reported:true}),
    send: (raw:string)=>{
      sent++;const payload=JSON.parse(raw) as Record<string,unknown>;
      frames.push(payload);
      if(respond){
        queueMicrotask(()=>void owner.webSocketMessage(socket as unknown as WebSocket,
          JSON.stringify({kind:"operation_result",request_id:payload.request_id,
            result:payload.tool==="get_operation_status"
              ? {operation_id:payload.operation_id,status:receiptState,
                  receipt:{operation_id:payload.operation_id,tool_name:"upgrade_agent",state:receiptState}}
              : {operation_id:payload.operation_id,status:"admitted"}})));
      }
    },
    close:()=>{},
  };
  const state={
    storage,
    getWebSockets: (tag:string)=>tag==="device:"+DEVICE?[socket]:[],
  } as unknown as DurableObjectState;
  owner=new V2OwnerCoordinator(state);
  const post=async(route:string,body:unknown)=>
    owner.fetch(new Request("https://v2.internal"+route,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(body),
    }));
  async function prepared(){
    const p=await post("/upgrade/prepare",{
      device_id:DEVICE,operation_id:"full-chain-operation",
      target:REVIEWED_WINDOWS_UPGRADE_PIN,
    });
    assert.equal(p.status,200);
    const result=await p.json() as {confirmation:string;preview:{operation_id:string}};
    assert.match(result.confirmation,/^[a-f0-9]{64}$/);
    const shown=await presentOwnerUpgrade(storage,result.preview.operation_id,result.confirmation);
    assert.ok(shown);
    return {confirmation:result.confirmation,form:shown.form_token};
  }
  return {data,frames,prepared,post,counts:()=>sent,
    setSignedEpoch:(next:string)=>{currentEpoch=next;data.set("session:epoch:"+DEVICE,next);},
    setReceiptState:(next:"completed"|"failed")=>{receiptState=next;},
    disableAgentReply:()=>{respond=false;},storage};
}
test("owner POST atomically claims approved intent and sends exactly one immutable no-execution WSS admission",async()=>{
  const f=fixture();
  const {confirmation,form}=await f.prepared();
  assert.equal(f.counts(),0,"GET preview can never dispatch");
  const confirmed=await f.post("/upgrade/confirm",{
    operation_id:"full-chain-operation",confirmation,form_token:form,
  });
  assert.equal(confirmed.status,200);
  assert.deepEqual(await confirmed.json(),{approved:true,status:"admitted"});
  assert.equal(f.counts(),1);
  assert.equal(f.frames[0]!.kind,"operation");
  assert.equal(f.frames[0]!.tool,"upgrade_agent");
  assert.equal(f.frames[0]!.operation_id,"full-chain-operation");
  const args=f.frames[0]!.arguments as {target:unknown;device_id:string;fingerprint:string;approved_at:number};
  assert.deepEqual(args.target,REVIEWED_WINDOWS_UPGRADE_PIN);
  assert.equal(args.device_id,DEVICE);
  assert.equal(args.fingerprint,"0123456789abcdef01234567");
  assert.ok(Number.isSafeInteger(args.approved_at));
  assert.equal((await readOwnerUpgrade(f.storage,"full-chain-operation"))?.state,"claimed");
  const status = await f.post("/upgrade/status",{operation_id:"full-chain-operation",device_id:DEVICE});
  assert.equal(status.status,200);
  const safe = await status.json() as Record<string,unknown>;
  assert.deepEqual(safe,{
    operation_id:"full-chain-operation",device_id:DEVICE,
    status:"claimed",target_version:REVIEWED_WINDOWS_UPGRADE_PIN.tag,
  });
  assert.ok(!JSON.stringify(safe).includes(confirmation));
  assert.ok(!JSON.stringify(safe).includes(form));
  assert.ok(!JSON.stringify(safe).includes("0123456789abcdef01234567"));
  const wrongDevice = await f.post("/upgrade/status",{operation_id:"full-chain-operation",
    device_id:"11111111-1111-4111-8111-111111111111"});
  assert.equal(wrongDevice.status,404);
  const beforeReplay=f.counts();
  const upgradeFramesBefore=f.frames.filter(frame=>frame.tool==="upgrade_agent").length;
  const replay=await f.post("/upgrade/confirm",{
    operation_id:"full-chain-operation",confirmation,form_token:form,
  });
  assert.equal(replay.status,409);
  assert.equal(f.counts(),beforeReplay,"repeat owner POST cannot dispatch another WSS request");
  assert.equal(f.frames.filter(frame=>frame.tool==="upgrade_agent").length,upgradeFramesBefore,
    "a read-only status reconciliation is not an additional upgrade dispatch");
});
test("owner preview alone cannot claim and a bad CSRF cannot dispatch",async()=>{
  const f=fixture();
  const {confirmation}=await f.prepared();
  const rejected=await f.post("/upgrade/confirm",{
    operation_id:"full-chain-operation",confirmation,form_token:"f".repeat(64),
  });
  assert.equal(rejected.status,409);
  assert.equal(f.counts(),0);
  assert.equal((await readOwnerUpgrade(f.storage,"full-chain-operation"))?.state,"prepared");
});

test("durable ledger finishes only after newly reported signed target and completed local WSS receipt",async()=>{
  const f=fixture();
  const {confirmation,form}=await f.prepared();
  const approved=await f.post("/upgrade/confirm",{
    operation_id:"full-chain-operation",confirmation,form_token:form,
  });
  assert.equal(approved.status,200);
  const old=await f.post("/upgrade/status",{
    device_id:DEVICE,operation_id:"full-chain-operation",
  });
  assert.equal((await old.json() as {status:string}).status,"claimed",
    "WSS ACK alone is not terminal success");
  const current=f.data.get("device:"+DEVICE) as {
    device_info:Record<string,unknown>;
  };
  f.data.set("device:"+DEVICE,{...current,
    device_info:{...current.device_info,
      agent_version:REVIEWED_WINDOWS_UPGRADE_PIN.tag}});
  const oldEpoch=await f.post("/upgrade/status",{
    device_id:DEVICE,operation_id:"full-chain-operation",
  });
  assert.equal((await oldEpoch.json() as {status:string}).status,"claimed",
    "version and completed receipt on the pre-upgrade socket must never complete");
  f.setSignedEpoch("signed-post-switch");
  const completed=await f.post("/upgrade/status",{
    device_id:DEVICE,operation_id:"full-chain-operation",
  });
  assert.equal(completed.status,200);
  assert.equal((await completed.json() as {status:string}).status,"completed");
  assert.equal((await readOwnerUpgrade(f.storage,"full-chain-operation"))?.state,"completed");
  const count=f.counts();
  const reread=await f.post("/upgrade/status",{
    device_id:DEVICE,operation_id:"full-chain-operation",
  });
  assert.equal((await reread.json() as {status:string}).status,"completed");
  assert.equal(f.counts(),count,"terminal ledger must not repeatedly query WSS");
});

test("signed restored old version reports guarded failure without releasing approval",async()=>{
  const f=fixture();
  const {confirmation,form}=await f.prepared();
  const confirmed=await f.post("/upgrade/confirm",{
    operation_id:"full-chain-operation",confirmation,form_token:form,
  });
  assert.deepEqual(await confirmed.json(),{approved:true,status:"admitted"});
  f.setSignedEpoch("signed-restored-old");
  f.setReceiptState("failed");
  const status=await f.post("/upgrade/status",{
    device_id:DEVICE,operation_id:"full-chain-operation",
  });
  assert.equal(status.status,200);
  assert.equal((await status.json() as {status:string}).status,"needs_attention");
  assert.equal((await readOwnerUpgrade(f.storage,"full-chain-operation"))?.state,"needs_attention");
  const replay=await f.post("/upgrade/prepare",{
    device_id:DEVICE,operation_id:"second-after-rollback",
    target:REVIEWED_WINDOWS_UPGRADE_PIN,
  });
  assert.equal(replay.status,409,"confirmed failure must retain the guarded one-shot lock");
});

test("read-only owner status ages an unresponsive one-shot into guarded attention",async()=>{
  const f=fixture();
  const {confirmation,form}=await f.prepared();
  const approved=await f.post("/upgrade/confirm",{
    operation_id:"full-chain-operation",confirmation,form_token:form,
  });
  assert.deepEqual(await approved.json(),{approved:true,status:"admitted"});
  const key="upgrade:operation:full-chain-operation";
  const claimed=f.data.get(key) as Record<string,unknown>;
  assert.equal(claimed.state,"claimed");
  f.data.set(key,{...claimed,approved_at:Date.now()-UPGRADE_UNCONFIRMED_ATTENTION_MS-1000});
  const device=f.data.get("device:"+DEVICE) as {device_info:Record<string,unknown>};
  f.data.set("device:"+DEVICE,{...device,
    device_info:{...device.device_info,agent_version:"v0.1.30-rc.1"}});
  const sentBefore=f.counts();
  const response=await f.post("/upgrade/status",{
    device_id:DEVICE,operation_id:"full-chain-operation",
  });
  assert.equal(response.status,200);
  assert.equal((await response.json() as {status:string}).status,"needs_attention");
  assert.equal((await readOwnerUpgrade(f.storage,"full-chain-operation"))?.state,"needs_attention");
  assert.equal(f.counts(),sentBefore,"offline reconciliation does not dispatch or query WSS");
  const repeat=await f.post("/upgrade/prepare",{
    device_id:DEVICE,operation_id:"unsafe-stale-retry",target:REVIEWED_WINDOWS_UPGRADE_PIN,
  });
  assert.equal(repeat.status,409,"stale one-shot receipt retains the owner device lock");
});
