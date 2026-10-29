import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyBarkProviderRelease,verifyBarkConsumerPin,inspectBarkProvider,
 stageBarkPin,verifyStagedBarkPin} from './reviewed-bark-provider-pin.mjs';
const version='3d61997c-eb30-46e3-b96f-334343d061af';
const other='12970996-4220-4731-b76e-a0c8aa7a5017';
const deployments={deployments:[{versions:[{percentage:100,version_id:version}]}]};
const settings={bindings:[
 {name:'BARK_DEVICE_KEY',type:'secret_text'},
 {name:'BARK_ENCRYPTION_KEY',type:'secret_text'},
 {name:'CF_VERSION_METADATA',type:'version_metadata'}]};
const secrets=[{name:'BARK_DEVICE_KEY'},{name:'BARK_ENCRYPTION_KEY'}];
test('only private Bark Provider with active version and both secrets can be pinned',()=>{
 assert.equal(verifyBarkProviderRelease(deployments,settings,secrets),version);
 assert.throws(()=>verifyBarkProviderRelease(deployments,{bindings:settings.bindings.slice(1)},secrets));
 assert.throws(()=>verifyBarkProviderRelease(deployments,settings,secrets.slice(1)));
 assert.throws(()=>verifyBarkProviderRelease({deployments:[{versions:[
  {percentage:50,version_id:version},{percentage:50,version_id:other}]}]},settings,secrets));
});
test('exact read-only Cloudflare fetch and no dynamic routing',async()=>{
 const seen=[];
 const result=await inspectBarkProvider('a'.repeat(32),'example',async(url,init)=>{
  seen.push({url,init});
  const value=url.endsWith('/settings')?settings:
   url.endsWith('/secrets')?secrets:deployments;
  return {ok:true,json:async()=>({success:true,result:value})};
 });
 assert.equal(result,version);
 assert.equal(seen.length,3);
 assert(seen.every(x=>x.init.redirect==='manual'&&x.url.includes('/workers/scripts/bark-provider/')));
});
test('staged one version and runtime pin must agree with active Provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reviewed-bark-'));
 try{
  const variablesFile=join(dir,'mcp-worker-variables.txt');
  const pinFile=join(dir,'bark-provider-version.txt');
  await writeFile(variablesFile,'MCP_PORTAL_CLIENT_ID:example\n');
  assert.equal(await stageBarkPin({pin:version,variablesFile,pinFile,runnerTemp:dir}),version);
  assert.equal(await readFile(pinFile,'utf8'),version+'\n');
  assert.equal(verifyStagedBarkPin(version,version),version);
  assert.throws(()=>verifyStagedBarkPin(version,other));
  assert.equal(verifyBarkConsumerPin({bindings:[
   {name:'BARK_ACTION_DEPLOYMENT_ID',type:'plain_text',text:version},
   {name:'BARK_ACTION_PROVIDER',type:'service',service:'bark-provider'},
  ]},version),true);
  assert.throws(()=>verifyBarkConsumerPin({bindings:[
   {name:'BARK_ACTION_DEPLOYMENT_ID',type:'plain_text',text:other},
   {name:'BARK_ACTION_PROVIDER',type:'service'},
  ]},version));
  await assert.rejects(()=>stageBarkPin({pin:version,variablesFile,pinFile,runnerTemp:dir}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
