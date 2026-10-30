import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";

function fixture(){
  const calls=[];
  const env={MCP_ACCESS_TOKEN:"private-browser-token",BROWSER_OWNER:{
    idFromName(name){assert.equal(name,"owner-v1");return name;},
    get(){return {async fetch(url,init){
      const body=init?.body?JSON.parse(String(init.body)):{};
      calls.push({path:new URL(url).pathname,body});
      return Response.json({endpoints:[], pairing_code:"test-one-time-code", authorization:"stopped"});
    }};}
  }};
  return {env,calls};
}
async function rpc(env,method,params,headers={}){
  return worker.fetch(new Request("https://browser.example/mcp",{method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer private-browser-token",...headers},
    body:JSON.stringify({jsonrpc:"2.0",id:13,method,params})}),env);
}
test("Browser MCP rejects missing, wrong and cross-origin Portal credentials before any DO action",async()=>{
  const {env,calls}=fixture();
  for(const header of [
    {authorization:""}, {authorization:"Bearer wrong"},
    {origin:"https://unexpected.website"}]){
    const response=await rpc(env,"tools/call",{name:"browser_endpoints",arguments:{}},header);
    assert.ok(response.status===401||response.status===403);
  }
  const missing=await rpc({...env,MCP_ACCESS_TOKEN:undefined},"tools/call",{name:"browser_endpoints",arguments:{}});
  assert.equal(missing.status,503);
  assert.equal(calls.length,0);
});
test("tool discovery publishes only implemented lifecycle tools and strict explicit IDs",async()=>{
  const {env,calls}=fixture();
  const response=await rpc(env,"tools/list",{});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.result.tools.map(x=>x.name),["browser_click","browser_fill","browser_keypress","browser_scroll","browser_select","browser_endpoints","browser_tabs","browser_snapshot","browser_screenshot","browser_tab_open","browser_tab_navigate","browser_tab_close","browser_stop","browser_revoke","browser_operation_status"]);
  for(const entry of body.result.tools)assert.equal(entry.inputSchema.additionalProperties,false);
  for(const args of [{endpoint_id:"invalid"},{endpoint_id:"11111111-1111-4111-8111-111111111111",unexpected:true},{}]){
    const rejected=await rpc(env,"tools/call",{name:"browser_revoke",arguments:args});
    assert.equal((await rejected.json()).result.isError,true);
  }
  assert.equal(calls.length,0);
});
test("pair and revoke route only through single owner Durable Object",async()=>{
  const {env,calls}=fixture();
  for(const [tool,args,path] of [
    ["browser_endpoints",{},"/list"],
    ["browser_tabs",{endpoint_id:"11111111-1111-4111-8111-111111111111"},"/read"],
    ["browser_snapshot",{endpoint_id:"11111111-1111-4111-8111-111111111111",tab_id:23},"/read"],
    ["browser_screenshot",{endpoint_id:"11111111-1111-4111-8111-111111111111",tab_id:23},"/read"],
    ["browser_stop",{endpoint_id:"11111111-1111-4111-8111-111111111111"},"/stop"],
    ["browser_revoke",{endpoint_id:"11111111-1111-4111-8111-111111111111"},"/revoke"],
    ["browser_operation_status",{endpoint_id:"11111111-1111-4111-8111-111111111111",intent_key:"019a2b3c-4d5e-7aaa-8bbb-1234567890ab"},"/operation-status"]]){
    const result=await rpc(env,"tools/call",{name:tool,arguments:args});
    assert.equal((await result.json()).result.isError,false,tool);
    assert.equal(calls.at(-1).path,path);
  }
});
test("operation status rejects malformed or extra keys before Durable Object access",async()=>{
  const {env,calls}=fixture();
  for(const args of [
    {endpoint_id:"11111111-1111-4111-8111-111111111111",intent_key:"not-uuid7"},
    {endpoint_id:"11111111-1111-4111-8111-111111111111",intent_key:"11111111-1111-4111-8111-111111111111"},
    {endpoint_id:"11111111-1111-4111-8111-111111111111",intent_key:"019a2b3c-4d5e-7aaa-8bbb-1234567890ab",execute:true}
  ]){
    const response=await rpc(env,"tools/call",{name:"browser_operation_status",arguments:args});
    assert.equal((await response.json()).result.isError,true);
  }
  assert.equal(calls.length,0);
});

test("ordinary website cannot claim or resume extensions; extension credential never becomes MCP Bearer",async()=>{
  const {env,calls}=fixture();
  const site=await worker.fetch(new Request("https://browser.example/extension/claim",{method:"POST",
    headers:{"content-type":"application/json",origin:"https://evil.example"},
    body:JSON.stringify({code:"a".repeat(24),alias:"profile"})}),env);
  assert.equal(site.status,403);
  assert.equal(calls.length,0);
  const extension="chrome-extension://"+"a".repeat(32);
  const resp=await worker.fetch(new Request("https://browser.example/extension/claim",{method:"POST",
    headers:{"content-type":"application/json",origin:extension},
    body:JSON.stringify({code:"a".repeat(24),alias:"profile"})}),env);
  assert.equal(resp.status,404);
  assert.equal(calls.length,0);
  assert.ok(!JSON.stringify(calls).includes("private-browser-token"));
});

test("read operations require explicit Endpoint and safe numeric tab target",async()=>{
  const {env,calls}=fixture();
  for(const call of [
    {name:"browser_tabs",arguments:{}},
    {name:"browser_snapshot",arguments:{endpoint_id:"11111111-1111-4111-8111-111111111111"}},
    {name:"browser_snapshot",arguments:{endpoint_id:"11111111-1111-4111-8111-111111111111",tab_id:-1}},
    {name:"browser_snapshot",arguments:{endpoint_id:"11111111-1111-4111-8111-111111111111",tab_id:1,active:true}}
  ]){
    const result=await rpc(env,"tools/call",call);
    assert.equal((await result.json()).result.isError,true);
  }
  assert.equal(calls.length,0);
});

test("T3 mutation ingress requires stable intent, exact target and a bounded URL",async()=>{
  const {env,calls}=fixture();
  const endpoint_id="11111111-1111-4111-8111-111111111111";
  const intent_key="019a2b3c-4d5e-7aaa-8bbb-1234567890ab";
  const target={endpoint_id,intent_key,tab_id:41,document_id:"document-41"};
  const toolsList=await (await rpc(env,"tools/list",{})).json();
  for(const name of ["browser_tab_open","browser_tab_navigate","browser_tab_close"])
    assert.ok(toolsList.result.tools.some(t=>t.name===name),name);
  for(const call of [
    {name:"browser_tab_open",arguments:{endpoint_id,url:"https://example.com"}},
    {name:"browser_tab_open",arguments:{endpoint_id,intent_key,url:"file:///secret"}},
    {name:"browser_tab_open",arguments:{endpoint_id,intent_key,url:"https://example.com",force:true}},
    {name:"browser_tab_navigate",arguments:{endpoint_id,intent_key,tab_id:41,url:"https://example.com"}},
    {name:"browser_tab_close",arguments:{endpoint_id,intent_key,tab_id:41}},
    {name:"browser_tab_close",arguments:{...target,force:true}}
  ]){
    const answer=await rpc(env,"tools/call",call);
    assert.equal((await answer.json()).result.isError,true,call.name);
  }
  assert.equal(calls.length,0);
  const valid=[
    {name:"browser_tab_open",arguments:{endpoint_id,intent_key,url:"https://example.com"}},
    {name:"browser_tab_navigate",arguments:{...target,url:"https://example.com/new"}},
    {name:"browser_tab_close",arguments:target}
  ];
  for(const call of valid){
    const answer=await rpc(env,"tools/call",call);
    assert.equal((await answer.json()).result.isError,false);
    assert.equal(calls.at(-1).path,"/mutate");
  }
});
