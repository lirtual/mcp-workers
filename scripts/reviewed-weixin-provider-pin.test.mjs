import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyProviderRelease,verifyConsumerPin,inspectProvider,stagePin,verifyStagedPin}
  from "./reviewed-weixin-provider-pin.mjs";

const version="3d61997c-eb30-46e3-b96f-334343d061af";
const old="12970996-4220-4731-b76e-a0c8aa7a5017";
const deployments={deployments:[{versions:[{percentage:100,version_id:version}]}]};
const settings={bindings:[
  {name:"DB",type:"d1",id:"051c3b6d-e3bc-4d69-907f-37e8ab00618f"},
  {name:"ADMIN_HOST",type:"plain_text",text:"weixin.lirtual.dpdns.org"},
  {name:"WEIXIN_ENCRYPTION_KEY",type:"secret_text"},
  {name:"CF_VERSION_METADATA",type:"version_metadata"}
]};
const secrets=[{name:"WEIXIN_ENCRYPTION_KEY"}];
test("only one 100% deployed reviewed Provider with original D1 and encryption key is eligible",()=>{
  assert.equal(verifyProviderRelease(deployments,settings,secrets),version);
  for(const bad of [
    {deployments:[{versions:[{percentage:50,version_id:version}]}]},
    {deployments:[{versions:[{percentage:100,version_id:version},{percentage:0,version_id:old}]}]},
    {deployments:[{versions:[{percentage:100,version_id:"invalid"}]}]}
  ])assert.throws(()=>verifyProviderRelease(bad,settings,secrets),/blocked/);
  for(const altered of [
    {bindings:settings.bindings.filter(x=>x.name!=="DB")},
    {bindings:settings.bindings.filter(x=>x.name!=="WEIXIN_ENCRYPTION_KEY")},
    {bindings:settings.bindings.filter(x=>x.name!=="CF_VERSION_METADATA")},
    {bindings:[...settings.bindings,{name:"MCP_ACCESS_TOKEN",type:"secret_text"}]},
    {bindings:settings.bindings.map(x=>x.name==="ADMIN_HOST"?{...x,text:"other.example"}:x)},
  ])assert.throws(()=>verifyProviderRelease(deployments,altered,secrets),/blocked/);
  assert.throws(()=>verifyProviderRelease(deployments,settings,
    [...secrets,{name:"MCP_ACCESS_TOKEN"}]),/blocked/);
});
test("Provider inspection performs exactly three read-only Cloudflare requests",async()=>{
  const calls=[];
  const result=await inspectProvider("a".repeat(32),"test-token",async(url,opts)=>{
    calls.push({url,opts});
    const value=url.endsWith("/settings")?settings:
      url.endsWith("/secrets")?secrets:deployments;
    return {ok:true,json:async()=>({success:true,result:value})};
  });
  assert.equal(result,version);
  assert.equal(calls.length,3);
  assert.ok(calls.every(x=>x.opts.redirect==="manual"&&x.opts.headers.Accept==="application/json"&&!x.opts.method));
  assert.ok(calls.every(x=>!x.url.includes("test-token")));
  await assert.rejects(()=>inspectProvider("a".repeat(32),"test-token",
    async()=>({ok:false,status:503})),/blocked/);
});
test("staged exact pin is single immutable value, stale override blocked and drift fails",async()=>{
  const temp=await mkdtemp(join(tmpdir(),"weixin-reviewed-"));
  const variablesFile=join(temp,"mcp-worker-variables.txt");
  const pinFile=join(temp,"weixin-provider-version.txt");
  try{
    await writeFile(variablesFile,"MCP_PORTAL_CLIENT_ID:test-id\n");
    assert.equal(await stagePin({pin:version,variablesFile,pinFile,runnerTemp:temp}),version);
    assert.equal(await readFile(pinFile,"utf8"),version+"\n");
    assert.equal(await readFile(variablesFile,"utf8"),
      "MCP_PORTAL_CLIENT_ID:test-id\nWEIXIN_ACTION_DEPLOYMENT_ID:"+version+"\n");
    assert.equal(verifyStagedPin(await readFile(pinFile,"utf8"),version),version);
    assert.throws(()=>verifyStagedPin(version,old),/blocked/);
    await assert.rejects(()=>stagePin({pin:old,variablesFile,pinFile,runnerTemp:temp}),/blocked/);
    assert.equal(await readFile(pinFile,"utf8"),version+"\n");
    assert.throws(()=>verifyConsumerPin({bindings:[
      {name:"WEIXIN_ACTION_DEPLOYMENT_ID",type:"plain_text",text:old}
    ]},version),/blocked/);
    assert.equal(verifyConsumerPin({bindings:[
      {name:"WEIXIN_ACTION_DEPLOYMENT_ID",type:"plain_text",text:version}
    ]},version),true);
  }finally{await rm(temp,{recursive:true,force:true});}
});
test("cannot write a pin outside approved Runner temporary directory",async()=>{
  const temp=await mkdtemp(join(tmpdir(),"weixin-reviewed-"));
  try{
    await assert.rejects(()=>stagePin({pin:version,runnerTemp:temp,
      variablesFile:join(temp,"unrelated.txt"),
      pinFile:join(temp,"weixin-provider-version.txt")}),/blocked/);
  }finally{await rm(temp,{recursive:true,force:true});}
});
