import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.ts";
import { REVIEWED_WINDOWS_UPGRADE_PIN } from "../src/install-bootstrap.ts";

const ID="2a83dae6-600c-49cc-b643-ab0d5ec7e0c8";
function fixture(configure:boolean){
  const calls:Array<{url:string;body:Record<string,unknown>}>= [];
  const token="owner-portal-test";
  const env = {
    MCP_ACCESS_TOKEN:token,
    DEVICE_COORDINATOR:{
      idFromName:()=>"single-owner-v2",
      get:()=>({fetch:async (url:string,init:{body:string})=>{
        const body=JSON.parse(init.body) as Record<string,unknown>;
        calls.push({url,body});
        return Response.json({status:"prepared",confirmation:"a".repeat(64),
          preview:{device_id:ID,operation_id:"upgrade-test-39",
            current_version:"v0.1.31-rc.1",target:REVIEWED_WINDOWS_UPGRADE_PIN}});
      }}),
    },
    ...(configure ? {
      REMOTE_CONTROL_UPGRADE_ACCESS_TEAM_DOMAIN:"secure-team.cloudflareaccess.com",
      REMOTE_CONTROL_UPGRADE_ACCESS_AUD:"b".repeat(64),
      REMOTE_CONTROL_UPGRADE_OWNER_EMAIL:"owner@example.test",
    }:{}),
  } as unknown as Env;
  const rpc=async(method:string,params?:Record<string,unknown>)=>{
    const response=await worker.fetch(new Request("https://rca.example.test/mcp",{
      method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,...(params?{params}: {})}),
    }),env);
    return await response.json() as {
      result?:{tools?:Array<{name:string}>;content?:Array<{text:string}>;isError?:boolean};
    };
  };
  return {rpc,calls};
}
test("upgrade tool remains hidden when separate Access approval is not configured",async()=>{
  const f=fixture(false);
  const names=(await f.rpc("tools/list")).result?.tools?.map(t=>t.name)??[];
  assert.equal(names.includes("upgrade_agent"),false);
  const result=await f.rpc("tools/call",{name:"upgrade_agent",arguments:{
    device_id:ID,operation_id:"upgrade-test-39",target_version:REVIEWED_WINDOWS_UPGRADE_PIN.tag}});
  assert.equal(result.result?.isError,true);
  assert.equal(f.calls.length,0);
});
test("one trusted reviewed MCP upgrade request prepares approval only, never dispatches",async()=>{
  const f=fixture(true);
  const list=await f.rpc("tools/list");
  assert.ok(list.result?.tools?.some(t=>t.name==="upgrade_agent"));
  const result=await f.rpc("tools/call",{name:"upgrade_agent",arguments:{
    device_id:ID,operation_id:"upgrade-test-39",target_version:REVIEWED_WINDOWS_UPGRADE_PIN.tag,
  }});
  assert.equal(result.result?.isError,undefined);
  const payload=JSON.parse(result.result!.content![0]!.text) as {
    status:string;confirmation_url:string;current_version:string;
  };
  assert.equal(payload.status,"pending_owner_approval");
  assert.match(payload.confirmation_url,/^https:\/\/rca\.lirtual\.dpdns\.org\/upgrade-approve\/upgrade-test-39\/[a-f0-9]{64}$/);
  assert.equal(payload.current_version,"v0.1.31-rc.1");
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0]!.url,"https://v2.internal/upgrade/prepare");
  assert.deepEqual(f.calls[0]!.body.target,REVIEWED_WINDOWS_UPGRADE_PIN);
  assert.equal(Object.hasOwn(f.calls[0]!.body,"command"),false);
});
test("unreviewed Release, raw command injection and another device are denied before owner DO",async()=>{
  const f=fixture(true);
  for(const args of [
    {device_id:ID,operation_id:"upgrade-test-39",target_version:"v0.1.99"},
    {device_id:ID,operation_id:"upgrade-test-39",target_version:REVIEWED_WINDOWS_UPGRADE_PIN.tag,
      command:"powershell -encodedcommand malicious"},
    {device_id:ID,operation_id:"../op",target_version:REVIEWED_WINDOWS_UPGRADE_PIN.tag},
    {device_id:"not-a-uuid",operation_id:"upgrade-test-39",target_version:REVIEWED_WINDOWS_UPGRADE_PIN.tag},
  ]){
    const result=await f.rpc("tools/call",{name:"upgrade_agent",arguments:args});
    assert.equal(result.result?.isError,true);
  }
  assert.equal(f.calls.length,0);
});
