import {readFile,writeFile,appendFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";

const PROVIDER="cloudflare-actions";
const CONSUMER="workflow-mcp-worker";
const DB_ID="051c3b6d-e3bc-4d69-907f-37e8ab00618f";
const OWNER_HOST="weixin.lirtual.dpdns.org";
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
  if(find("DB","d1").length!==1||
     (find("DB","d1")[0]?.id||find("DB","d1")[0]?.database_id)!==DB_ID||
     find("ADMIN_HOST","plain_text").length!==1||
     find("ADMIN_HOST","plain_text")[0].text!==OWNER_HOST||
     ["WEIXIN_ENCRYPTION_KEY","BARK_DEVICE_KEY","BARK_ENCRYPTION_KEY"].some(name=>
       find(name,"secret_text").length!==1||secrets.filter(x=>x.name===name).length!==1)||
     !bindings.some(x=>x.name==="CF_VERSION_METADATA")||
     bindings.some(x=>x.name==="MCP_ACCESS_TOKEN"||x.name==="MCP_HOST")||
     secrets.some(x=>x.name==="MCP_ACCESS_TOKEN"))
    fail("Provider D1, owner, encryption key, version metadata or retired credential drift");
  return versions[0].version_id.toLowerCase();
}
export function verifyConsumerPin(settings,expected){
  if(!UUID.test(expected??""))fail("expected version missing");
  const pin=settings?.bindings?.filter(x=>x.name===PIN_NAME);
  if(!Array.isArray(pin)||pin.length!==1||pin[0].type!=="plain_text"||
     pin[0].text?.toLowerCase()!==expected.toLowerCase())
    fail("published Workflow binding differs from approved Provider version");
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
export async function stagePin({pin,variablesFile,pinFile,runnerTemp}){
  if(!UUID.test(pin??"")||
     resolve(variablesFile)!==join(resolve(runnerTemp),"mcp-worker-variables.txt")||
     resolve(pinFile)!==join(resolve(runnerTemp),"actions-provider-version.txt"))
    fail("staged output path or version invalid");
  const vars=await readFile(variablesFile,"utf8");
  if(vars.split("\n").some(line=>line.startsWith(PIN_NAME+":")))
    fail("manual Provider override is forbidden in guarded release");
  await writeFile(pinFile,pin+"\n",{flag:"wx",mode:0o600});
  await appendFile(variablesFile,PIN_NAME+":"+pin+"\n");
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
    verifyConsumerPin(settings,pin);
  }
  console.log("Exact Provider version "+pin+" verified at "+mode+"; no Provider write or message sent");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
