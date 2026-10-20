import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import worker from "../src/worker.ts";
import { BROWSER_TOOLS, parseBrowserCall, parseBrowserDoArguments } from "../src/browser-tools.ts";

const device_id=randomUUID(), session_id=randomUUID(), operation_id="browser-op-"+randomUUID();
test("strict 5-operation browser contract forwards only bounded typed arguments",()=>{
  const start=parseBrowserCall("browser_start",{device_id,operation_id});
  assert.deepEqual(start,{device_id,tool:"browser_start",kind:"operation",operation_id,arguments:{}});
  const nav=parseBrowserCall("browser_navigate",{device_id,operation_id,session_id,url:"https://example.com/"});
  assert.deepEqual(nav?.arguments,{session_id,url:"https://example.com/"});
  const read=parseBrowserCall("browser_snapshot",{device_id,session_id});
  assert.equal(read?.kind,"read");
  assert.deepEqual(read?.arguments,{session_id});
  assert.deepEqual(BROWSER_TOOLS.map(t=>t.name),[
    "browser_start","browser_status","browser_navigate","browser_snapshot","browser_close",
  ]);
});
test("rejects arbitrary JS, CLI/path/profile, missing IDs, unexpected keys, and malformed URLs",()=>{
  for(const [tool,args] of [
    ["browser_start",{device_id,operation_id,command:"whoami"}],
    ["browser_start",{device_id,operation_id,executable:"npx"}],
    ["browser_start",{device_id,operation_id,profile:"C:\\Users\\secret"}],
    ["browser_start",{device_id}],
    ["browser_status",{device_id,shell:"echo hi"}],
    ["browser_snapshot",{device_id,session_id:"nope"}],
    ["browser_navigate",{device_id,operation_id,session_id,url:"file:///etc/passwd"}],
    ["browser_navigate",{device_id,operation_id,session_id,url:"https://u:secret@example.com/"}],
    ["browser_navigate",{device_id,operation_id,session_id,url:"javascript:alert(1)"}],
    ["browser_navigate",{device_id,operation_id,session_id,url:"https://example.com/",script:"alert(1)"}],
  ] as const) assert.equal(parseBrowserCall(tool,args),null,tool);
  assert.equal(parseBrowserDoArguments("browser_start",{operation_id}),true);
  assert.equal(parseBrowserDoArguments("browser_start",{}),false);
  assert.equal(parseBrowserDoArguments("browser_snapshot",{session_id}),true);
  assert.equal(parseBrowserDoArguments("browser_snapshot",{session_id,profile:"personal"}),false);
});
test("staged browser tools are neither advertised nor dispatchable on the current production MCP surface",async()=>{
  let doCalls=0;
  const env={
    MCP_ACCESS_TOKEN:"browser-test-token",
    DEVICE_COORDINATOR:{
      idFromName:()=> "test-owner", get:()=>({fetch:()=>{doCalls++;throw Error("Unexpected routed browser call");}}),
    },
  } as unknown as Env;
  const rpc=async (method:string,params:unknown)=>{
    const res=await worker.fetch(new Request("https://mcp.test/mcp",{
      method:"POST",
      headers:{"content-type":"application/json",authorization:"Bearer browser-test-token"},
      body:JSON.stringify({jsonrpc:"2.0",id:4,method,params}),
    }),env);
    return await res.json() as any;
  };
  const list=await rpc("tools/list",{});
  const exposed=(list.result?.tools??[]).map((tool:any)=>tool.name);
  for(const tool of BROWSER_TOOLS) assert.equal(exposed.includes(tool.name),false);
  const call=await rpc("tools/call",{name:"browser_start",arguments:{device_id,operation_id}});
  assert.equal(call.result?.isError,true);
  assert.equal(doCalls,0);
});
