import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import worker from "../src/worker.ts";
import {BROWSER_TOOLS} from "../src/browser-tools.ts";

const target=randomUUID(), other=randomUUID();
const preview={
  MCP_ACCESS_TOKEN:"preview-isolated-token",
  V2_OWNER:{idFromName:()=>({}),get:()=>({
    fetch:async()=>Response.json({status:"completed",text:"approved-read"}),
  })},
  REMOTE_CONTROL_V2_PREVIEW_ONLY:"true",
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
  return await response.json() as {
    result?:{tools?:Array<{name:string}>;content?:Array<{text:string}>;isError?:boolean}
  };
}
const exposed=async(env:Record<string,unknown>)=>
  (await request(env,"tools/list")).result?.tools?.map(t=>t.name)
    .filter(n=>n.startsWith("browser_"))??[];

test("Preview with a paired owner advertises ten browser tools without approval configuration",async()=>{
  assert.deepEqual((await exposed(preview)).sort(),
    [...BROWSER_TOOLS.map(t=>t.name)].sort());
  assert.equal(BROWSER_TOOLS.length,10);
  for(const overrides of [
    {REMOTE_CONTROL_V2_PREVIEW_ONLY:"false"},
    {V2_OWNER:undefined},
    {DEVICE_COORDINATOR:preview.V2_OWNER},
  ]) assert.deepEqual(await exposed({...preview,...overrides}),[],
    JSON.stringify(Object.keys(overrides)));
});

test("Preview forwards a chosen UUID to owner DO, which independently rejects unpaired identities",async()=>{
  let forwarded=0;
  const env={...preview,V2_OWNER:{idFromName:()=>({}),get:()=>({
    fetch:async(_url:unknown,init:{body?:string})=>{
      forwarded++;
      const input=JSON.parse(init.body??"{}") as {device_id:string};
      if(input.device_id!==target)
        return Response.json({error:"offline"},{status:503});
      return Response.json({status:"completed",text:"approved-read"});
    },
  })}};
  const rejected=await request(env,"tools/call",{
    name:"browser_status",arguments:{device_id:other}});
  assert.equal(rejected.result?.isError,true);
  const allowed=await request(env,"tools/call",{
    name:"browser_status",arguments:{device_id:target}});
  assert.equal(allowed.result?.isError,false);
  assert.equal(allowed.result?.content?.[0]?.text,"approved-read");
  assert.equal(forwarded,2);
  // A forged malformed ID is rejected before any request reaches the DO.
  const invalid=await request(env,"tools/call",{
    name:"browser_status",arguments:{device_id:"not-a-uuid"}});
  assert.equal(invalid.result?.isError,true);
  assert.equal(forwarded,2);
});

test("production owner advertises browser tools independent of browser approval credentials",async()=>{
  let forwarded=0;
  const prod={...preview,V2_OWNER:undefined,REMOTE_CONTROL_V2_PREVIEW_ONLY:undefined,
    DEVICE_COORDINATOR:{idFromName:()=>({}),get:()=>({fetch:async()=>{
      forwarded++;return Response.json({status:"completed",text:"approved-read"});
    }})},
  };
  assert.deepEqual((await exposed(prod)).sort(),BROWSER_TOOLS.map(t=>t.name).sort());
  const result=await request(prod,"tools/call",{name:"browser_status",arguments:{device_id:target}});
  assert.equal(result.result?.isError,false);
  assert.equal(forwarded,1);
  for(const name of ["BROWSER_APPROVAL_ACCESS_ISSUER","BROWSER_APPROVAL_ACCESS_AUD",
    "BROWSER_APPROVAL_ALLOWED_EMAIL","BROWSER_APPROVAL_PUBLIC_ORIGIN"]){
    assert.deepEqual((await exposed({...prod,[name]:undefined})).sort(),BROWSER_TOOLS.map(t=>t.name).sort(),name);
  }
  assert.deepEqual(await exposed({...prod,V2_OWNER:preview.V2_OWNER}),[]);
  assert.deepEqual(await exposed({...prod,REMOTE_CONTROL_V2_PREVIEW_ONLY:"true"}),[]);
});

test("Preview routes browser_fill directly to the signed paired-device operation path",async()=>{
  const device=randomUUID(),operation_id="spec152-fill-"+randomUUID();
  const calls:Array<{path:string;payload:Record<string,unknown>}>=[];
  const env={...preview,V2_OWNER:{idFromName:()=>({}),get:()=>({
    fetch:async(url:string,init:{body?:string})=>{
      const payload=JSON.parse(init.body??"{}") as Record<string,unknown>;
      calls.push({path:new URL(url).pathname,payload});
      return Response.json({operation_id,status:"completed"});
    },
  })}};
  const text="not-safe-to-show-on-approval-page";
  const output=await request(env,"tools/call",{name:"browser_fill",arguments:{
    device_id:device,operation_id,session_id:randomUUID(),role:"textbox",
    name:"Demo field",snapshot_version:7,text,
  }});
  assert.equal(output.result?.isError,false);
  assert.deepEqual(calls.map(x=>x.path),["/operation"]);
  assert.equal(calls[0]?.payload.tool,"browser_fill");
  assert.match(String(output.result?.content?.[0]?.text),/completed/);
  assert.equal(JSON.stringify(output).includes(text),false);
});

test("Preview routes browser_navigate directly while retaining signed-tab validation",async()=>{
  const device=randomUUID(),operation_id="spec152-nav-"+randomUUID();
  const calls:Array<{path:string;payload:Record<string,unknown>}>=[];
  const env={...preview,V2_OWNER:{idFromName:()=>({}),get:()=>({
    fetch:async(url:string,init:{body?:string})=>{
      const payload=JSON.parse(init.body??"{}") as Record<string,unknown>;
      calls.push({path:new URL(url).pathname,payload});
      return Response.json({operation_id,status:"completed"});
    },
  })}};
  const output=await request(env,"tools/call",{name:"browser_navigate",arguments:{
    device_id:device,operation_id,session_id:randomUUID(),
    tab_id:"tab-1",snapshot_version:0,
    url:"https://demo.playwright.dev/todomvc/",
  }});
  assert.equal(output.result?.isError,false);
  assert.deepEqual(calls.map(x=>x.path),["/operation"]);
  assert.equal(calls[0]?.payload.tool,"browser_navigate");
  assert.match(String(output.result?.content?.[0]?.text),/completed/);
});

test("a retired per-action approval URL does not provide an authorization path",async()=>{
  const response=await worker.fetch(
    new Request("https://preview.example.com/browser-approve/"+randomUUID()),
    preview as unknown as Env);
  assert.equal(response.status,404);
});
