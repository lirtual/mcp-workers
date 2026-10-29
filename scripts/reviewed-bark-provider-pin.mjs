import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const PROVIDER='bark-provider',CONSUMER='workflow-mcp-worker';
const PIN_NAME='BARK_ACTION_DEPLOYMENT_ID';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail=m=>{throw Error('Reviewed Bark pin blocked: '+m);};

export function verifyBarkProviderRelease(deployments,settings,secrets){
 const versions=deployments?.deployments?.[0]?.versions;
 if(!Array.isArray(versions)||versions.length!==1||versions[0]?.percentage!==100||
   !UUID.test(versions[0]?.version_id??''))fail('must have one active 100% version');
 const bindings=settings?.bindings;
 if(!Array.isArray(bindings)||!Array.isArray(secrets))fail('binding inventory unavailable');
 const required=['BARK_DEVICE_KEY','BARK_ENCRYPTION_KEY'];
 for(const name of required){
  if(bindings.filter(x=>x.name===name&&x.type==='secret_text').length!==1||
   secrets.filter(x=>x.name===name).length!==1)fail('missing private Bark credentials');
 }
 if(bindings.filter(x=>x.name==='CF_VERSION_METADATA'&&x.type==='version_metadata').length!==1)
  fail('missing version metadata');
 if(bindings.some(x=>x.name==='MCP_ACCESS_TOKEN'||x.name==='MCP_HOST'||
   x.name==='BARK_ENDPOINT'||x.name==='BARK_DEVICE_KEYS'))
  fail('unexpected routing or public credential');
 return versions[0].version_id.toLowerCase();
}
export function verifyBarkConsumerPin(settings,version){
 if(!UUID.test(version??''))fail('missing exact version');
 const pins=settings?.bindings?.filter(x=>x.name===PIN_NAME);
 if(!Array.isArray(pins)||pins.length!==1||pins[0].type!=='plain_text'||
   pins[0].text?.toLowerCase()!==version.toLowerCase())
  fail('Workflow runtime pin differs from reviewed Bark version');
 const service=settings?.bindings?.filter(x=>x.name==='BARK_ACTION_PROVIDER');
 if(!Array.isArray(service)||service.length!==1||service[0]?.type!=='service')
  fail('Workflow Bark Service Binding missing');
 return true;
}
async function get(account,token,url,fetchImpl=fetch){
 const response=await fetchImpl(url,{redirect:'manual',
  headers:{Authorization:'Bearer '+token,Accept:'application/json'},
  signal:AbortSignal.timeout(15000)});
 if(!response.ok)fail('Cloudflare read-only HTTP '+response.status);
 const payload=await response.json();
 if(payload?.success!==true||payload.result==null)fail('Cloudflare read-only result unavailable');
 return payload.result;
}
const prefix=(account,worker)=>'https://api.cloudflare.com/client/v4/accounts/'+account+
 '/workers/scripts/'+worker;
export async function inspectBarkProvider(account,token,fetchImpl=fetch){
 if(!/^[a-f0-9]{32}$/i.test(account??'')||!token)fail('read credential unavailable');
 const base=prefix(account,PROVIDER);
 const [deployments,settings,secrets]=await Promise.all([
  get(account,token,base+'/deployments?per_page=1',fetchImpl),
  get(account,token,base+'/settings',fetchImpl),
  get(account,token,base+'/secrets',fetchImpl)]);
 return verifyBarkProviderRelease(deployments,settings,secrets);
}
export async function inspectBarkConsumer(account,token,fetchImpl=fetch){
 if(!/^[a-f0-9]{32}$/i.test(account??'')||!token)fail('read credential unavailable');
 return get(account,token,prefix(account,CONSUMER)+'/settings',fetchImpl);
}
export async function stageBarkPin({pin,variablesFile,pinFile,runnerTemp}){
 if(!UUID.test(pin??'')||
  resolve(variablesFile)!==join(resolve(runnerTemp),'mcp-worker-variables.txt')||
  resolve(pinFile)!==join(resolve(runnerTemp),'bark-provider-version.txt'))
  fail('untrusted staged output path or version');
 const variables=await readFile(variablesFile,'utf8');
 if(variables.split('\n').some(line=>line.startsWith(PIN_NAME+':')))
  fail('manual Bark Provider pin override forbidden');
 await writeFile(pinFile,pin+'\n',{flag:'wx',mode:0o600});
 await appendFile(variablesFile,PIN_NAME+':'+pin+'\n');
 return pin;
}
export function verifyStagedBarkPin(staged,active){
 const value=String(staged).trim();
 if(!UUID.test(value)||value!==active)fail('active Provider version changed during release');
 return value;
}
async function main(){
 const [mode]=process.argv.slice(2);
 if(!['stage','recheck','postflight'].includes(mode)||process.env.SELECTED_WORKER!==CONSUMER)
  fail('requires selected protected Workflow release');
 const temp=process.env.RUNNER_TEMP,account=process.env.CLOUDFLARE_ACCOUNT_ID,
 token=process.env.CLOUDFLARE_API_TOKEN;
 if(!temp||!account||!token)fail('release environment incomplete');
 const pinFile=join(temp,'bark-provider-version.txt');
 const active=await inspectBarkProvider(account,token);
 if(mode==='stage'){
  await stageBarkPin({pin:active,variablesFile:join(temp,'mcp-worker-variables.txt'),
   pinFile,runnerTemp:temp});
  console.log('Reviewed Bark Provider Version staged: '+active);return;
 }
 const pin=verifyStagedBarkPin(await readFile(pinFile,'utf8'),active);
 if(mode==='postflight')verifyBarkConsumerPin(await inspectBarkConsumer(account,token),pin);
 console.log('Bark version '+pin+' verified at '+mode+'; no message sent');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
 main().catch(e=>{console.error(e.message);process.exitCode=1;});
