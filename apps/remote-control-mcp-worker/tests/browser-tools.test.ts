import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import worker from "../src/worker.ts";
import { BROWSER_TOOLS, parseBrowserCall, parseBrowserDoArguments, browserEffectClientStatus } from "../src/browser-tools.ts";

const device_id=randomUUID(), session_id=randomUUID(), operation_id="browser-op-"+randomUUID();

test("unknown browser effects require receipt lookup, never implicit replay",()=>{
  for (const status of ["unknown","unavailable","admitted","not_found","unexpected",undefined]) {
    assert.equal(browserEffectClientStatus(status),"timeout_unknown",String(status));
  }
  for (const status of ["running","completed","failed","conflict","bad_request"]) {
    assert.equal(browserEffectClientStatus(status),status);
  }
});

test("strict typed browser contract forwards only bounded arguments",()=>{
  const start=parseBrowserCall("browser_start",{device_id,operation_id});
  assert.deepEqual(start,{device_id,tool:"browser_start",kind:"operation",operation_id,arguments:{}});
  const nav=parseBrowserCall("browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/"});
  assert.deepEqual(nav?.arguments,{session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/"});
  const read=parseBrowserCall("browser_snapshot",{device_id,session_id});
  assert.equal(read?.kind,"read");
  assert.deepEqual(read?.arguments,{session_id});
  assert.deepEqual(BROWSER_TOOLS.map(t=>t.name),[
    "browser_start","browser_status","browser_navigate","browser_snapshot","browser_close",
    "browser_tabs","browser_click","browser_fill","browser_press_key","browser_select_option",
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
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"file:///etc/passwd"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://u:secret@example.com/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"javascript:alert(1)"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"http://127.0.0.1:8765/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"http://2130706433:8765/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"http://[::1]/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"http://localhost:1234/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"http://localhost./"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"http://localhost../"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://printer.local./"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://db.internal.."}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"http://127.0.0.1../"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://docs.internal/page"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://printer.local/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://server/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"  https://example.com/"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/\n"}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/",script:"alert(1)"}],
  ] as const) assert.equal(parseBrowserCall(tool,args),null,tool);
  assert.equal(parseBrowserDoArguments("browser_start",{operation_id}),true);
  assert.equal(parseBrowserDoArguments("browser_start",{}),false);
  assert.equal(parseBrowserDoArguments("browser_snapshot",{session_id}),true);
  assert.equal(parseBrowserDoArguments("browser_snapshot",{session_id,profile:"personal"}),false);
});
test("browser tool annotations conservatively describe external effects, not approval",()=>{
  for(const tool of BROWSER_TOOLS) {
    assert.equal(typeof tool.annotations.readOnlyHint,"boolean",tool.name);
    assert.equal(typeof tool.annotations.destructiveHint,"boolean",tool.name);
    assert.equal(typeof tool.annotations.openWorldHint,"boolean",tool.name);
  }
  const hints=Object.fromEntries(BROWSER_TOOLS.map(t=>[t.name,t.annotations]));
  assert.deepEqual(hints.browser_start,{readOnlyHint:false,destructiveHint:false,openWorldHint:false});
  assert.deepEqual(hints.browser_status,{readOnlyHint:true,destructiveHint:false,openWorldHint:false});
  assert.deepEqual(hints.browser_navigate,{readOnlyHint:false,destructiveHint:true,openWorldHint:true});
  assert.deepEqual(hints.browser_snapshot,{readOnlyHint:true,destructiveHint:false,openWorldHint:true});
  assert.deepEqual(hints.browser_close,{readOnlyHint:false,destructiveHint:true,openWorldHint:false});
  // These annotations influence client risk UX; they are NOT server-side
  // approval, so the hard-coded disabled browser-tool gate remains required.
});
test("model-supplied confirmation fields cannot grant browser authorization",()=>{
  const nav={device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/"};
  const agentArgs={operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:nav.url};
  // Owner consent is not a model-authored flag or token. This test is
  // parser-only: it is NOT evidence of a working human approval channel.
  for(const [field,value] of Object.entries({
    approved:true,confirmed:true,user_approved:true,
    approval_token:"forged",confirmation:"yes",human_presence:true,
  })) {
    assert.equal(parseBrowserCall("browser_navigate",{...nav,[field]:value}),null,field);
    assert.equal(parseBrowserDoArguments("browser_navigate",{...agentArgs,[field]:value}),false,field);
  }
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
  for(const [name,args] of [
    ["browser_start",{device_id,operation_id}],
    ["browser_status",{device_id}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/"}],
    ["browser_snapshot",{device_id,session_id}],
    ["browser_close",{device_id,operation_id,session_id}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/",approved:true}],
    ["browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/",confirmation:"yes"}],
  ] as const) {
    const call=await rpc("tools/call",{name,arguments:args});
    assert.equal(call.result?.isError,true,name);
  }
  assert.equal(doCalls,0);
});


test("2026 capability hints do not silently upgrade the legacy MCP bridge",async()=>{
  // Source compatibility probe, NOT a real ChatGPT client/elicitation test.
  const env={MCP_ACCESS_TOKEN:"p11-local-protocol-only"} as unknown as Env;
  const res=await worker.fetch(new Request("https://mcp.test/mcp",{
    method:"POST",headers:{authorization:"Bearer p11-local-protocol-only","content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:23,method:"initialize",params:{
      protocolVersion:"2026-07-28",capabilities:{elicitation:{}},
    }}),
  }),env);
  const rpc=await res.json() as any;
  assert.equal(rpc.result?.protocolVersion,"2025-11-25");
  assert.deepEqual(rpc.result?.capabilities,{tools:{listChanged:false}});
  // The new protocol's input_required multi-round-trip capability is not
  // implemented. Never report this fallback as human-approval support.
});
test("first-hop URL rejection precedes any DO mutation admission; network-level isolation remains unproven",()=>{
  const publicUrl=parseBrowserCall("browser_navigate",{
    device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com/review?q=1",
  });
  assert.equal(publicUrl?.kind,"operation");
  assert.equal(parseBrowserCall("browser_navigate",{device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:"https://example.com./"})?.kind,"operation");
  for(const value of [
    "http://10.0.0.1/", "http://192.168.0.10/", "http://172.16.2.3/",
    "http://127.0.0.1:18781/", "http://169.254.169.254/",
    "http://[::ffff:127.0.0.1]/",
  ]) {
    assert.equal(parseBrowserCall("browser_navigate",{
      device_id,operation_id,session_id,tab_id:"tab-1",snapshot_version:0,url:value,
    }),null,value);
  }
  // Public-host redirects, hostile DNS resolution and HTML subresources
  // are outside these argument-only checks; never advertise SSRF safety.
});

test("browser_tabs list is read-only; selecting/creating/closing tabs always requires a durable operation ID",()=>{
  const list=parseBrowserCall("browser_tabs",{device_id,session_id,action:"list"});
  assert.equal(list?.kind,"read");
  assert.deepEqual(list?.arguments,{session_id,action:"list"});
  assert.equal(parseBrowserDoArguments("browser_tabs",{session_id,action:"list"}),true);
  for(const action of ["select","close"]){
    const valid=parseBrowserCall("browser_tabs",{device_id,session_id,operation_id,action,tab_id:"tab-2"});
    assert.equal(valid?.kind,"operation",action);
    assert.equal(parseBrowserDoArguments("browser_tabs",{session_id,operation_id,action,tab_id:"tab-2"}),true);
    assert.equal(parseBrowserCall("browser_tabs",{device_id,session_id,action,tab_id:"tab-2"}),null);
    assert.equal(parseBrowserCall("browser_tabs",{device_id,session_id,operation_id,action,tab_id:"tab-x"}),null);
  }
  assert.equal(parseBrowserCall("browser_tabs",{device_id,session_id,operation_id,action:"new"})?.kind,"operation");
  assert.equal(parseBrowserCall("browser_tabs",{device_id,session_id,action:"new"}),null);
  assert.equal(parseBrowserCall("browser_tabs",{device_id,session_id,operation_id,action:"list"}),null);
  assert.equal(parseBrowserCall("browser_tabs",{device_id,session_id,operation_id,action:"new",tab_id:"tab-3"}),null);
});

test("semantic interaction calls validate exactly the user-observable target and bounded action data",()=>{
  const target={device_id,session_id,operation_id,role:"button",name:"Next",snapshot_version:2};
  assert.equal(parseBrowserCall("browser_click",target)?.kind,"operation");
  assert.equal(parseBrowserCall("browser_fill",{...target,role:"textbox",name:"Search",text:"private example"})?.kind,"operation");
  assert.equal(parseBrowserCall("browser_select_option",{...target,role:"combobox",name:"Size",value:"M"})?.kind,"operation");
  assert.equal(parseBrowserCall("browser_press_key",{device_id,session_id,operation_id,key:"Enter",snapshot_version:2})?.kind,"operation");
  for(const [tool,args] of [
    ["browser_click",{...target,role:"script"}],
    ["browser_click",{...target,snapshot_version:-1}],
    ["browser_click",{...target,approved:true}],
    ["browser_fill",{...target,role:"textbox",text:"x".repeat(5001)}],
    ["browser_fill",{...target,role:"textbox",text:"secret",approval_token:"forged"}],
    ["browser_select_option",{...target,role:"combobox",value:"x".repeat(513)}],
    ["browser_press_key",{device_id,session_id,operation_id,key:"Alt+F4",snapshot_version:"stale"}],
  ] as const) assert.equal(parseBrowserCall(tool,args),null,tool);
});

test("bounded page snapshot allows explicit offset to inspect long pages",()=>{
  assert.deepEqual(parseBrowserCall("browser_snapshot",{device_id,session_id,offset:8000})?.arguments,{session_id,offset:8000});
  for(const offset of [-1,200001,1.5,"8000"])
    assert.equal(parseBrowserCall("browser_snapshot",{device_id,session_id,offset}),null);
});
