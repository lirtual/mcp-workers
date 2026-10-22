import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import worker from "../src/worker.ts";

const target=randomUUID(), different=randomUUID();
const preview={MCP_ACCESS_TOKEN:"preview-isolated-token",
  V2_OWNER:{idFromName:()=>({}),get:()=>({
    fetch:async()=>Response.json({status:"completed",text:"preview-only-read"}),
  })},
  REMOTE_CONTROL_V2_PREVIEW_ONLY:"true",
  SPEC152_PREVIEW_BROWSER_TOOLS:"true",
  SPEC152_PREVIEW_BROWSER_DEVICE_ID:target,
  BROWSER_APPROVAL_ENABLED:"true",
  BROWSER_APPROVAL_ACCESS_ISSUER:"https://test.cloudflareaccess.com",
  BROWSER_APPROVAL_ACCESS_AUD:"a".repeat(64),
  BROWSER_APPROVAL_ALLOWED_EMAIL:"owner@example.com",
  BROWSER_APPROVAL_PUBLIC_ORIGIN:"https://preview.example.com",
};

async function request(env:Record<string,unknown>,method:string,params:unknown={}) {
  const response=await worker.fetch(new Request("https://preview.example.com/mcp",{
    method:"POST",headers:{"content-type":"application/json",
      authorization:"Bearer preview-isolated-token"},
    body:JSON.stringify({jsonrpc:"2.0",id:17,method,params}),
  }),env as unknown as Env);
  assert.equal(response.status,200);
  return await response.json() as {result?:{tools?:Array<{name:string}>;
    content?:Array<{text:string}>;isError?:boolean}};
}
const exposed=async(env:Record<string,unknown>)=>
  (await request(env,"tools/list")).result?.tools?.map(t=>t.name)
    .filter(n=>n.startsWith("browser_"))??[];

test("only the explicitly scoped Preview binding exposes four browser test tools",async()=>{
  assert.deepEqual((await exposed(preview)).sort(),
    ["browser_click","browser_snapshot","browser_status","browser_tabs"].sort());
  for(const overrides of [
    {SPEC152_PREVIEW_BROWSER_TOOLS:"false"},
    {SPEC152_PREVIEW_BROWSER_DEVICE_ID:""},
    {SPEC152_PREVIEW_BROWSER_DEVICE_ID:"not-a-uuid"},
    {BROWSER_APPROVAL_ENABLED:"false"},
    {REMOTE_CONTROL_V2_PREVIEW_ONLY:"false"},
    {DEVICE_COORDINATOR:preview.V2_OWNER},
    {V2_OWNER:undefined},
  ]) assert.deepEqual(await exposed({...preview,...overrides}),[],JSON.stringify(overrides));
});

test("a different device cannot use any preview browser tool; no preview shell escalation",async()=>{
  let forwarded=0;
  const env={...preview,V2_OWNER:{idFromName:()=>({}),get:()=>({
    fetch:async()=>{forwarded++;return Response.json({status:"completed",text:"test"});},
  })}};
  const args={device_id:different};
  for(const name of ["browser_status","browser_click","browser_start",
    "browser_navigate","browser_fill","browser_press_key","browser_close"]) {
    const result=await request(env,"tools/call",{name,arguments:args});
    assert.equal(result.result?.isError,true,name);
  }
  assert.equal(forwarded,0);
  const allowed=await request(env,"tools/call",{
    name:"browser_status",arguments:{device_id:target}});
  assert.equal(allowed.result?.isError,false);
  assert.equal(forwarded,1);
});

test("even with preview flags, production DeviceCoordinator binding keeps every staged browser tool hidden",async()=>{
  const actual={...preview,DEVICE_COORDINATOR:preview.V2_OWNER,V2_OWNER:undefined};
  assert.deepEqual(await exposed(actual),[]);
  const out=await request(actual,"tools/call",{
    name:"browser_click",arguments:{device_id:target,
      operation_id:"test-"+randomUUID(),session_id:randomUUID(),
      role:"button",name:"Confirm demo",snapshot_version:1}});
  assert.equal(out.result?.isError,true);
});
