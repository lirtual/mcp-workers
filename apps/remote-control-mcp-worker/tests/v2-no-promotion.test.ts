import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import worker, {V2OwnerCoordinator} from "../src/worker.ts";

test("retired temporary-to-permanent web route stays absent with Portal and Access credentials",async()=>{
  const deviceId=randomUUID();
  let dispatched=0;
  const env={
    MCP_ACCESS_TOKEN:"valid-test-portal-token",
    DEVICE_COORDINATOR:{idFromName:()=>({}),get:()=>({
      fetch:async()=>{dispatched++;return Response.json({status:"promoted"});},
    })},
  } as unknown as Env;
  for (const method of ["GET","POST"]) {
    const response=await worker.fetch(new Request(
      "https://rca.example/browser-approve/grant/"+deviceId,{
        method,headers:{
          authorization:"Bearer valid-test-portal-token",
          "cf-access-jwt-assertion":"not-an-owner-jwt",
        },
      }),env);
    assert.equal(response.status,404,method);
  }
  assert.equal(dispatched,0,"no reintroduced upgrade capability may reach owner DO");
});

test("owner DO cannot change an existing temporary grant into permanent in place",async()=>{
  const deviceId=randomUUID();
  const grant={
    device_id:deviceId,name:"test temporary",grant_type:"temporary",
    expires_at:Date.now()+86_400_000,revoked:false,
    public_key:"test-key",fingerprint:"f".repeat(24),approved_at:Date.now(),
  };
  const rows=new Map<string,unknown>([["device:"+deviceId,structuredClone(grant)]]);
  const owner=new V2OwnerCoordinator({storage:{
    get:async<T>(key:string)=>rows.get(key) as T|undefined,
  }} as unknown as DurableObjectState);
  const response=await owner.fetch(new Request("https://v2.internal/grant/permanent",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({
      device_id:deviceId,expected_fingerprint:grant.fingerprint,
      expected_expires_at:grant.expires_at,confirmation:"make_permanent",
    }),
  }));
  assert.equal(response.status,404);
  assert.deepEqual(rows.get("device:"+deviceId),grant,"expiry and identity remain immutable");
});
