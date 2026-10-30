// Spec #531 DO restart smoke. Tests SQLite durability of a pending activation
// and fail-closed Access state; not a substitute for a real browser/SSO/WSS E2E.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
const cwd=new URL('../',import.meta.url).pathname;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spec531-restart-'));
const port=18985,service='http://127.0.0.1:'+port;
const origin='chrome-extension://'+'a'.repeat(32);
let child=null;
async function start(){
  child=spawn(path.join(cwd,'node_modules/.bin/wrangler'),['dev','--local','--ip','127.0.0.1','--port',String(port),'--persist-to',dir],
    {cwd,detached:true,env:{...process.env,MCP_ACCESS_TOKEN:'local-restart-fixture'},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',v=>{stderr=(stderr+String(v)).slice(-1000);});
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw Error('workerd failed: '+stderr);
    try{if((await fetch(service+'/')).status===404)return;}catch{}
    await sleep(200);
  }
  throw Error('workerd did not start: '+stderr);
}
async function stop(){
  if(child?.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}
  if(child)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(2500)]);
  child=null;
}
async function extension(route,payload){
  const response=await fetch(service+'/extension/'+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(payload),redirect:'manual'});
  return {status:response.status,result:await response.json()};
}
try{
  await start();
  const proof='f'.repeat(64),attempt_id=crypto.randomUUID();
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(proof)));
  const proof_hash=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  const pending=await extension('activate-begin',{attempt_id,proof_hash,alias:'restart-fixture',mode:'temporary'});
  assert.equal(pending.status,200);assert.equal(pending.result.state,'pending');
  await stop();await sleep(350);
  await start();
  const unreconciled=await extension('activate-complete',{attempt_id,proof});
  assert.equal(unreconciled.status,409,'DO re-creation does not invent Access approval');
  assert.equal(unreconciled.result.state,'awaiting_owner');
  assert.equal((await extension('activate-cancel',{attempt_id,proof})).status,200);
  assert.equal((await extension('activate-complete',{attempt_id,proof})).status,403);
  console.log('Spec #531 workerd restart smoke: PASS (pending attempt durable, never grants without Access)');
}finally{
  await stop();fs.rmSync(dir,{recursive:true,force:true});
}
