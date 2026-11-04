import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyProviderRelease,verifyConsumerBinding,inspectProvider,stagePin,verifyStagedPin,
   verifySafeRecoveryProvider,verifyRecoveryConsumerVersion,inspectGateRecovery}
  from "./reviewed-actions-provider-pin.mjs";

const version="3d61997c-eb30-46e3-b96f-334343d061af";
const old="12970996-4220-4731-b76e-a0c8aa7a5017";
const deployments={deployments:[{versions:[{percentage:100,version_id:version}]}]};
const settings={bindings:[
  {name:"DB",type:"d1",id:"051c3b6d-e3bc-4d69-907f-37e8ab00618f"},
  {name:"ADMIN_HOST",type:"plain_text",text:"weixin.lirtual.dpdns.org"},
  {name:"WEIXIN_ENCRYPTION_KEY",type:"secret_text"},
  {name:"BARK_DEVICE_KEY",type:"secret_text"},
  {name:"BARK_ENCRYPTION_KEY",type:"secret_text"},
  {name:"CF_VERSION_METADATA",type:"version_metadata"}
]};
const secrets=[{name:"WEIXIN_ENCRYPTION_KEY"},{name:"BARK_DEVICE_KEY"},{name:"BARK_ENCRYPTION_KEY"}];
test("Bark-only Provider pin requires exact active version and Bark bindings, not historical Weixin Secrets",()=>{
  assert.equal(verifyProviderRelease(deployments,settings,secrets),version);
  for(const bad of [
    {deployments:[{versions:[{percentage:50,version_id:version}]}]},
    {deployments:[{versions:[{percentage:100,version_id:version},{percentage:0,version_id:old}]}]},
    {deployments:[{versions:[{percentage:100,version_id:"invalid"}]}]}
  ])assert.throws(()=>verifyProviderRelease(bad,settings,secrets),/blocked/);
  // Historic Owner bindings are optional and must not authorize old sends.
  const barkOnly={bindings:settings.bindings.filter(x=>
    !["DB","ADMIN_HOST","WEIXIN_ENCRYPTION_KEY"].includes(x.name))};
  const barkSecrets=secrets.filter(x=>x.name!=="WEIXIN_ENCRYPTION_KEY");
  assert.equal(verifyProviderRelease(deployments,barkOnly,barkSecrets),version);
  for(const altered of [
    {bindings:barkOnly.bindings.filter(x=>x.name!=="BARK_DEVICE_KEY")},
    {bindings:barkOnly.bindings.filter(x=>x.name!=="BARK_ENCRYPTION_KEY")},
    {bindings:barkOnly.bindings.filter(x=>x.name!=="CF_VERSION_METADATA")},
    {bindings:[...barkOnly.bindings,{name:"MCP_ACCESS_TOKEN",type:"secret_text"}]},
    {bindings:[...barkOnly.bindings,{name:"ACTIONS",type:"service"}]},
    {bindings:[...barkOnly.bindings,barkOnly.bindings[0]]},
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
test("reviewed version stays temporary; legacy Consumer pin is not execution authority",async()=>{
  const temp=await mkdtemp(join(tmpdir(),"actions-reviewed-"));
  const variablesFile=join(temp,"mcp-worker-variables.txt");
  const pinFile=join(temp,"actions-provider-version.txt");
  try{
    await writeFile(variablesFile,"MCP_PORTAL_CLIENT_ID:test-id\n");
    assert.equal(await stagePin({pin:version,variablesFile,pinFile,runnerTemp:temp}),version);
    assert.equal(await readFile(pinFile,"utf8"),version+"\n");
    assert.equal(await readFile(variablesFile,"utf8"),
      "MCP_PORTAL_CLIENT_ID:test-id\n");
    assert.equal(verifyStagedPin(await readFile(pinFile,"utf8"),version),version);
    assert.throws(()=>verifyStagedPin(version,old),/blocked/);
    await assert.rejects(()=>stagePin({pin:old,variablesFile,pinFile,runnerTemp:temp}),/EEXIST/);
    assert.equal(await readFile(pinFile,"utf8"),version+"\n");
    const service={name:'ACTIONS',type:'service',service:'cloudflare-actions',
      entrypoint:'ActionsEntrypoint'};
    assert.throws(()=>verifyConsumerBinding({bindings:[
      {name:'ACTIONS_DEPLOYMENT_ID',type:'plain_text',text:old}
    ]}),/blocked/);
    assert.equal(verifyConsumerBinding({bindings:[service]}),true);
    assert.equal(verifyConsumerBinding({bindings:[service,
      {name:'ACTIONS_DEPLOYMENT_ID',type:'plain_text',text:old}]}),true);
    assert.throws(()=>verifyConsumerBinding({bindings:[service,
      {name:'ACTIONS_DEPLOYMENT_ID',type:'plain_text',text:old}]},version),/blocked/);
    assert.equal(verifyConsumerBinding({bindings:[service]},version),true);
    assert.throws(()=>verifyConsumerBinding({bindings:[service,
      {name:'ACTIONS_DEPLOYMENT_ID',type:'plain_text',text:'latest'}]}),/blocked/);
  }finally{await rm(temp,{recursive:true,force:true});}
});
test("cannot write a pin outside approved Runner temporary directory",async()=>{
  const temp=await mkdtemp(join(tmpdir(),"actions-reviewed-"));
  try{
    await assert.rejects(()=>stagePin({pin:version,runnerTemp:temp,
      variablesFile:join(temp,"unrelated.txt"),
      pinFile:join(temp,"actions-provider-version.txt")}),/blocked/);
  }finally{await rm(temp,{recursive:true,force:true});}
});


test("gate-only recovery requires the exact live Secret-free Provider and 100% Consumer",async()=>{
  const cleanBindings=settings.bindings.filter(x=>
    !["DB","ADMIN_HOST","WEIXIN_ENCRYPTION_KEY"].includes(x.name));
  const cleanSecrets=secrets.filter(x=>x.name!=="WEIXIN_ENCRYPTION_KEY");
  const metadata={id:version,bindings:cleanBindings};
  const consumerVersion=old;
  const consumerLive={deployments:[{versions:[{version_id:consumerVersion,percentage:100}]}]};
  const consumerSettings={bindings:[
    {name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"ActionsEntrypoint"},
    {name:"ACTIONS_DEPLOYMENT_ID",type:"plain_text",text:version}
  ]};
  assert.equal(verifySafeRecoveryProvider(metadata,cleanSecrets,version),true);
  assert.equal(verifyRecoveryConsumerVersion(consumerLive,consumerVersion),true);
  for(const bad of [
    {...metadata,bindings:[...cleanBindings,{name:"WEIXIN_ENCRYPTION_KEY",type:"secret_text"}]},
    {...metadata,bindings:[...cleanBindings,{name:"DB",type:"d1"}]},
    {...metadata,id:old}
  ])assert.throws(()=>verifySafeRecoveryProvider(bad,cleanSecrets,version),/blocked/);
  assert.throws(()=>verifySafeRecoveryProvider(metadata,secrets,version),/blocked/);
  for(const bad of [
    {deployments:[{versions:[{version_id:consumerVersion,percentage:50}]}]},
    {deployments:[{versions:[{version_id:version,percentage:100}]}]},
    {deployments:[{versions:[{version_id:consumerVersion,percentage:100},{version_id:version,percentage:0}]}]}
  ])assert.throws(()=>verifyRecoveryConsumerVersion(bad,consumerVersion),/blocked/);
  function fetcher(opts){
    return async(url,options)=>{
      const path=new URL(url).pathname;
      opts.calls.push({path,method:options.method});
      let result=path.includes("/workers/workers/cloudflare-actions/versions/")?metadata:
        path.endsWith("/workers/scripts/workflow-mcp-worker/settings")?consumerSettings:
        path.endsWith("/workers/scripts/workflow-mcp-worker/deployments")?consumerLive:
        path.endsWith("/workers/scripts/cloudflare-actions/settings")?{bindings:cleanBindings}:
        path.endsWith("/workers/scripts/cloudflare-actions/secrets")?cleanSecrets:
        path.endsWith("/workers/scripts/cloudflare-actions/deployments")?deployments:null;
      if(opts.badBinding&&path.endsWith("/workflow-mcp-worker/settings"))
        result={bindings:[{name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"Bad"}]};
      if(opts.badSecret&&path.endsWith("/cloudflare-actions/secrets"))result=secrets;
      if(opts.badConsumer&&path.endsWith("/workflow-mcp-worker/deployments"))
        result={deployments:[{versions:[{version_id:version,percentage:100}]}]};
      if(result==null)throw Error("unexpected mocked URL "+path);
      return {ok:true,json:async()=>({success:true,result})};
    };
  }
  const ok={calls:[]};
  assert.equal(await inspectGateRecovery("a".repeat(32),"test-token",
    version,consumerVersion,fetcher(ok)),true);
  assert.equal(ok.calls.length,7);
  assert.ok(ok.calls.every(x=>x.method===undefined));
  for(const variation of [{badBinding:true},{badSecret:true},{badConsumer:true}]){
    const x={calls:[],...variation};
    await assert.rejects(()=>inspectGateRecovery("a".repeat(32),"test-token",
      version,consumerVersion,fetcher(x)),/blocked/);
    assert.ok(x.calls.every(c=>c.method===undefined));
  }
  await assert.rejects(()=>inspectGateRecovery("a".repeat(32),"test-token",
    "not-a-version",consumerVersion,fetcher({calls:[]})),/blocked/);
});
