import {readFile,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";

const PROVIDER="cloudflare-actions";
const CONSUMER="workflow-mcp-worker";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PIN_NAME="ACTIONS_DEPLOYMENT_ID";
const fail=message=>{throw Error("Reviewed Actions pin blocked: "+message);};

export function verifyProviderRelease(deployments,settings,secrets){
  const versions=deployments?.deployments?.[0]?.versions;
  if(!Array.isArray(versions)||versions.length!==1||
     versions[0]?.percentage!==100||!UUID.test(versions[0]?.version_id??""))
    fail("active Provider must have exactly one 100% deployed Version ID");
  const bindings=settings?.bindings;
  if(!Array.isArray(bindings)||!Array.isArray(secrets))fail("Provider bindings and Secret inventory unavailable");
  const find=(name,type)=>bindings.filter(x=>x.name===name&&x.type===type);
  // The Provider is now Bark-only. Inherited historic Owner D1/Secret
  // bindings may remain until separately authorized T7 physical revocation;
  // they are neither necessary nor proof of new execution authority.
  if(["BARK_DEVICE_KEY","BARK_ENCRYPTION_KEY"].some(name=>
       find(name,"secret_text").length!==1||
       secrets.filter(x=>x.name===name).length!==1)||
     find("CF_VERSION_METADATA","version_metadata").length!==1||
     bindings.some(x=>x.name==="MCP_ACCESS_TOKEN"||x.name==="MCP_HOST"||x.type==="service")||
     secrets.some(x=>x.name==="MCP_ACCESS_TOKEN"))
    fail("Provider Bark key, version metadata or retired credential drift");
  return versions[0].version_id.toLowerCase();
}
export function verifyConsumerBinding(settings,expectedProvider,requireCompatible=false){
  const b=settings?.bindings;
  if(!Array.isArray(b)||b.filter(x=>x.type==='service').length!==1||
     b.filter(x=>x.name==='ACTIONS'&&x.type==='service'&&
       x.service===PROVIDER&&x.entrypoint==='ActionsEntrypoint').length!==1)
    fail('trusted Workflow ACTIONS Service Binding missing or changed');
  // Legacy plaintext version metadata is optional and never execution authority.
  const legacy=b.filter(x=>x.name===PIN_NAME);
  if(legacy.length>1||legacy.some(x=>x.type!=='plain_text'||!UUID.test(x.text??'')))
    fail('invalid legacy Provider version metadata');
  if(requireCompatible&&legacy.length)fail('compatible Consumer still retains legacy deployment pin');
  // Gate reopening must not resume an old exact-pin Consumer against a newer
  // Provider. The compatible Consumer release omits this obsolete variable.
  if(expectedProvider&&(!UUID.test(expectedProvider)||legacy.some(x=>
    x.text.toLowerCase()!==expectedProvider.toLowerCase())))
    fail('legacy Consumer cannot safely reopen against a different Provider');
  return true;
}
export async function inspectProvider(account,token,fetchImpl=fetch){
  if(!/^[a-f0-9]{32}$/i.test(account??"")||!token)fail("existing Cloudflare read credential unavailable");
  const prefix="https://api.cloudflare.com/client/v4/accounts/"+account+
    "/workers/scripts/"+PROVIDER;
  const get=async path=>{
    const result=await fetchImpl(prefix+path,{redirect:"manual",
      headers:{Authorization:"Bearer "+token,Accept:"application/json"},
      signal:AbortSignal.timeout(15000)});
    if(!result.ok)fail("read-only Provider inspection HTTP "+result.status);
    const data=await result.json();
    if(data?.success!==true||data.result==null)fail("read-only Provider result unavailable");
    return data.result;
  };
  const [deployments,settings,secrets]=await Promise.all([
    get("/deployments?per_page=1"),get("/settings"),get("/secrets")]);
  return verifyProviderRelease(deployments,settings,secrets);
}
export async function inspectConsumer(account,token,fetchImpl=fetch){
  if(!/^[a-f0-9]{32}$/i.test(account??"")||!token)fail("existing Cloudflare read credential unavailable");
  const response=await fetchImpl(
    "https://api.cloudflare.com/client/v4/accounts/"+account+
    "/workers/scripts/"+CONSUMER+"/settings",
    {redirect:"manual",headers:{Authorization:"Bearer "+token,Accept:"application/json"},
     signal:AbortSignal.timeout(15000)});
  if(!response.ok)fail("read-only Workflow binding HTTP "+response.status);
  const payload=await response.json();
  if(payload?.success!==true||!payload.result)fail("Workflow binding unavailable");
  return payload.result;
}
export function verifySafeRecoveryProvider(version,secrets,expected){
  const bindings=version?.bindings;
  if(!UUID.test(expected??"")||version?.id?.toLowerCase()!==expected.toLowerCase()||
     !Array.isArray(bindings)||!Array.isArray(secrets)||
     ["BARK_DEVICE_KEY","BARK_ENCRYPTION_KEY"].some(name=>
       bindings.filter(x=>x.name===name&&x.type==="secret_text").length!==1||
       secrets.filter(x=>x.name===name).length!==1)||
     bindings.some(x=>["WEIXIN_ENCRYPTION_KEY","MCP_ACCESS_TOKEN","DB"].includes(x.name)||
       x.type==="service")||
     secrets.some(x=>x.name==="WEIXIN_ENCRYPTION_KEY"))
    fail("reviewed immutable Secret-free Provider or live Secret inventory changed");
  return true;
}

export function verifyRecoveryConsumerVersion(result,expected){
  const deployments=result?.deployments;
  const versions=deployments?.[0]?.versions;
  if(!UUID.test(expected??"")||!Array.isArray(deployments)||
     deployments.length!==1||!Array.isArray(versions)||
     versions.length!==1||versions[0].percentage!==100||
     versions[0].version_id?.toLowerCase()!==expected.toLowerCase())
    fail("reviewed Consumer deployment identity or 100% traffic drift");
  return true;
}

export async function inspectGateRecovery(account,token,provider,consumer,fetchImpl=fetch){
  if(!UUID.test(provider??"")||!UUID.test(consumer??"")||
     !/^[a-f0-9]{32}$/i.test(account??"")||!token)
    fail("exact reviewed recovery versions and read credential required");
  const active=await inspectProvider(account,token,fetchImpl);
  if(active!==provider.toLowerCase())fail("active Provider version drift");
  verifyConsumerBinding(await inspectConsumer(account,token,fetchImpl),provider);
  const base="https://api.cloudflare.com/client/v4/accounts/"+account;
  const read=async path=>{
    const response=await fetchImpl(base+path,{redirect:"manual",headers:{
      Authorization:"Bearer "+token,Accept:"application/json"},
      signal:AbortSignal.timeout(15000)});
    if(!response.ok)fail("read-only recovery Cloudflare HTTP unavailable");
    const body=await response.json();
    if(body?.success!==true||body.result==null)fail("read-only recovery response invalid");
    return body.result;
  };
  const [metadata,secrets,activeConsumer]=await Promise.all([
    read("/workers/workers/cloudflare-actions/versions/"+provider),
    read("/workers/scripts/cloudflare-actions/secrets"),
    read("/workers/scripts/workflow-mcp-worker/deployments?per_page=1")
  ]);
  verifySafeRecoveryProvider(metadata,secrets,provider);
  verifyRecoveryConsumerVersion(activeConsumer,consumer);
  return true;
}

export async function stagePin({pin,variablesFile,pinFile,runnerTemp}){
  if(!UUID.test(pin??"")||
     resolve(variablesFile)!==join(resolve(runnerTemp),"mcp-worker-variables.txt")||
     resolve(pinFile)!==join(resolve(runnerTemp),"actions-provider-version.txt"))
    fail("staged output path or version invalid");
  const vars=await readFile(variablesFile,"utf8");
  if(vars.split("\n").some(line=>line.startsWith(PIN_NAME+":")))
    fail("manual Provider override is forbidden in guarded release");
  // The reviewed version is a short-lived release consistency check only.
  // Never stage it as a persistent Consumer environment variable.
  await writeFile(pinFile,pin+"\n",{flag:"wx",mode:0o600});
  return pin;
}
export function verifyStagedPin(staged,active){
  const value=String(staged).trim();
  if(!UUID.test(value)||value!==active)fail("Provider changed during protected Workflow release");
  return value;
}
async function main(){
  const [mode]=process.argv.slice(2);
  if(!["stage","recheck","postflight"].includes(mode)||
     process.env.SELECTED_WORKER!==CONSUMER)
    fail("only selected protected Workflow release may inspect Provider");
  const temp=process.env.RUNNER_TEMP,account=process.env.CLOUDFLARE_ACCOUNT_ID,
    token=process.env.CLOUDFLARE_API_TOKEN;
  if(!temp||!account||!token)fail("release environment not configured");
  const pinFile=join(temp,"actions-provider-version.txt");
  const active=await inspectProvider(account,token);
  if(mode==="stage"){
    await stagePin({pin:active,variablesFile:join(temp,"mcp-worker-variables.txt"),
      pinFile,runnerTemp:temp});
    console.log("Reviewed active Actions version staged for existing Workflow release: "+active);
    return;
  }
  const pin=verifyStagedPin(await readFile(pinFile,"utf8"),active);
  if(mode==="postflight"){
    const settings=await inspectConsumer(account,token);
    verifyConsumerBinding(settings,undefined,true);
  }
  console.log("Reviewed Provider version "+pin+" and Consumer binding verified at "+mode+"; no Provider write or message sent");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
