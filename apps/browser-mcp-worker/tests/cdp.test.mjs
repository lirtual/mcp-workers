import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";

const endpoint_id="11111111-1111-4111-8111-111111111111";
const intent_key="019a2b3c-4d5e-7aaa-8bbb-1234567890ab";
function fixture(){
  const calls=[];
  const env={MCP_ACCESS_TOKEN:"private-browser-token",BROWSER_OWNER:{
    idFromName(){return "owner-v1";},
    get(){return {async fetch(url,init){
      calls.push({path:new URL(url).pathname,body:JSON.parse(String(init.body))});
      return Response.json({state:"admitted",operation_id:"11111111-1111-4111-8111-111111111111"});
    }};}
  }};
  async function rpc(name,args){
    const result=await worker.fetch(new Request("https://browser.example/mcp",{method:"POST",
      headers:{"content-type":"application/json",authorization:"Bearer private-browser-token"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}),env);
    return (await result.json()).result;
  }
  return {env,calls,rpc};
}
test("Spec 917 exposes two bounded CDP tools while preserving every existing tool",async()=>{
  const {env}=fixture();
  const response=await worker.fetch(new Request("https://browser.example/mcp",{method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer private-browser-token"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list",params:{}})}),env);
  const tools=(await response.json()).result.tools;
  const names=tools.map(t=>t.name);
  const original=["browser_click","browser_fill","browser_keypress","browser_scroll","browser_select",
    "browser_endpoints","browser_tabs","browser_snapshot","browser_screenshot","browser_tab_open",
    "browser_tab_navigate","browser_tab_close","browser_stop","browser_revoke","browser_operation_status"];
  for(const name of original)assert.ok(names.includes(name),name);
  assert.deepEqual(names.filter(n=>!original.includes(n)).sort(),["browser_cdp","browser_cdp_events"]);
  assert.equal(tools.find(t=>t.name==="browser_cdp").inputSchema.additionalProperties,false);
  assert.equal(tools.find(t=>t.name==="browser_cdp_events").inputSchema.additionalProperties,false);
});
test("CDP requires bounded explicit tab, UUIDv7 intent and commands before reaching Owner",async()=>{
  const {rpc,calls}=fixture();
  const base={endpoint_id,tab_id:73,intent_key,commands:[{method:"Runtime.evaluate",params:{expression:"1+1"}}]};
  for(const invalid of [
    {...base,tab_id:-1}, {...base,intent_key:"11111111-1111-4111-8111-111111111111"},
    {...base,commands:[]}, {...base,commands:Array.from({length:17},()=>({method:"Runtime.evaluate",params:{expression:"1"}}))},
    {...base,commands:[{method:"Runtime.evaluate",params:{expression:"1"},unexpected:true}]},
    {...base,session_id:"x".repeat(129),commands:base.commands},
    {...base,unknown:true}
  ])assert.equal((await rpc("browser_cdp",invalid)).isError,true);
  assert.equal(calls.length,0);
  const valid=await rpc("browser_cdp",base);
  assert.equal(valid.isError,false);
  assert.equal(calls.at(-1).path,"/mutate");
  assert.equal(calls.at(-1).body.action,"cdp");
});
test("CDP event operations reject extra keys and unsafe filters before dispatch",async()=>{
  const {rpc,calls}=fixture();
  const target={endpoint_id,tab_id:73};
  for(const invalid of [
    {...target,action:"read",limit:100000},
    {...target,action:"subscribe",events:["invalid event"]},
    {...target,action:"delete"},
    {...target,action:"read",secret:"bad"}
  ])assert.equal((await rpc("browser_cdp_events",invalid)).isError,true);
  assert.equal(calls.length,0);
  const valid=await rpc("browser_cdp_events",{...target,action:"subscribe",events:["Network.requestWillBeSent"]});
  assert.equal(valid.isError,false);
  assert.equal(calls.at(-1).path,"/read");
  assert.equal(calls.at(-1).body.tool,"cdp_events");
});
