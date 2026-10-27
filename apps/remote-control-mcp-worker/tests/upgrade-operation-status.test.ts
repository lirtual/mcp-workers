import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/worker.ts";

const DEVICE="2a83dae6-600c-49cc-b643-ab0d5ec7e0c8";
async function invoke(statusExists:boolean){
  const visited:string[]=[];
  const bearer="owner-portal-test";
  const env={
    MCP_ACCESS_TOKEN:bearer,
    DEVICE_COORDINATOR:{
      idFromName:()=>"single-owner-v2",
      get:()=>({fetch:async (url:string)=>{
        visited.push(url);
        if(url.endsWith("/upgrade/status")){
          return statusExists
            ? Response.json({operation_id:"one-upgrade",device_id:DEVICE,
                status:"needs_attention",target_version:"v0.1.32-rc.1"})
            : Response.json({error:"not_found"},{status:404});
        }
        return Response.json({operation_id:"one-upgrade",status:"unknown"});
      }}),
    },
  } as unknown as Env;
  const res=await worker.fetch(new Request("https://rca.example.test/mcp",{
    method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"get_operation_status",arguments:{device_id:DEVICE,operation_id:"one-upgrade"}}}),
  }),env);
  assert.equal(res.status,200);
  const obj=await res.json() as {result?:{content?:Array<{text:string}>;isError?:boolean}};
  assert.equal(obj.result?.isError,false);
  return {result:JSON.parse(obj.result!.content![0]!.text) as Record<string,unknown>,visited};
}
test("existing get_operation_status returns upgrade owner-DO state even with Agent offline",async()=>{
  const {result,visited}=await invoke(true);
  assert.deepEqual(result,{operation_id:"one-upgrade",device_id:DEVICE,
    status:"needs_attention",target_version:"v0.1.32-rc.1"});
  assert.deepEqual(visited,["https://v2.internal/upgrade/status"],
    "a durable upgrade status read must not dispatch WSS");
});
test("ordinary operation receipts keep existing Agent-backed fallback",async()=>{
  const {result,visited}=await invoke(false);
  assert.equal(result.operation_id,"one-upgrade");
  assert.equal(result.status,"unknown");
  assert.deepEqual(visited,["https://v2.internal/upgrade/status",
    "https://v2.internal/operation"]);
});
