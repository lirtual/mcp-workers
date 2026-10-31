// Spec #531 workerd public-ingress smoke: no fake Access grant, no website effects.
// Real Access OTP/SSO and installed Chrome/Edge WSS remain separate acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
const cwd=new URL('../',import.meta.url).pathname;
const persistence=fs.mkdtempSync(path.join(os.tmpdir(),'browser531-workerd-'));
const port=18984,origin='http://127.0.0.1:'+port;
const extensionOrigin='chrome-extension://jhifaghneomgcfollcdbncjkcloedfem';
const bearer='test-only-portal-credential';
const child=spawn(path.join(cwd,'node_modules/.bin/wrangler'),['dev','--local','--port',String(port),'--ip','127.0.0.1','--persist-to',persistence],{
  cwd,detached:true,env:{...process.env,MCP_ACCESS_TOKEN:bearer},stdio:['ignore','pipe','pipe']});
let output='';
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+String(chunk)).slice(-4000);});
const cleanup=()=>{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}};
process.on('exit',cleanup);
const response=async(path,init={})=>fetch(origin+path,{redirect:'manual',...init});
const extension=async(route,data,headers={})=>{
  const r=await response('/extension/'+route,{method:'POST',headers:{origin:extensionOrigin,'content-type':'application/json',...headers},body:JSON.stringify(data)});
  return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():null};
};
const rpc=async(method,name,body={})=>{
  const r=await response('/mcp',{method:'POST',headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:method==='tools/call'?{name,arguments:body}:{}})});
  return {status:r.status,data:await r.json()};
};
try{
  let ready=false;
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw Error('workerd_start_failed: '+output);
    try{const r=await response('/');if(r.status===200){ready=true;break;}}catch{}
    await sleep(250);
  }
  assert.ok(ready,'workerd did not start: '+output);
  const page=await response('/');
  const html=await page.text();
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-type'),/text\/html/);
  assert.match(page.headers.get('cache-control'),/no-cache/);
  assert.match(html,/Chrome &amp; Edge/);
  const version=html.match(/Version <strong>([0-9.]+)<\/strong>/)?.[1];
  const sha=html.match(/SHA-256: <code>([a-f0-9]{64})<\/code>/)?.[1];
  const selected=await response('/download');
  assert.equal(selected.status,302);
  assert.equal(selected.headers.get('cache-control'),'no-store');
  assert.equal(selected.headers.get('location'),`/downloads/browser-mcp-extension-v${version}-${sha}.zip`);
  const zip=await response(selected.headers.get('location'));
  assert.equal(zip.status,200);
  assert.match(zip.headers.get('content-type'),/application\/zip/);
  assert.match(zip.headers.get('cache-control'),/immutable/);
  const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await zip.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  assert.equal(actual,sha,'actual static asset must match published full hash');
  assert.equal((await response('/',{method:'HEAD'})).status,200);
  assert.equal((await response('/download',{method:'HEAD'})).status,302);
  assert.equal((await response('/download',{method:'POST'})).status,405);
  assert.equal((await response('/downloads/old.zip')).status,404);
  assert.equal((await response('/index.html')).status,404,'no implicit static asset paths');
  assert.equal((await response('/unexpected')).status,404,'no SPA fallback');
  assert.equal((await response('/owner/unknown/'+crypto.randomUUID())).status,403);
  assert.equal((await response('/extension/socket')).status,403);
  assert.equal((await response('/mcp',{method:'POST'})).status,401);
  const inventory=await rpc('tools/list');assert.equal(inventory.status,200);
  const names=inventory.data.result.tools.map(t=>t.name);
  assert.equal(names.length,15);assert.ok(!names.includes('browser_pair'));
  const oldClaim=await extension('claim',{code:'a'.repeat(24),alias:'Legacy'});assert.equal(oldClaim.status,404);
  assert.equal((await extension('resume',{endpoint_id:crypto.randomUUID(),credential:'b'.repeat(64)})).status,404);
  const attempt_id=crypto.randomUUID(),proof='c'.repeat(64);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(proof));
  const proof_hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const begin=await extension('activate-begin',{attempt_id,proof_hash,alias:'isolated-workerd-profile',mode:'permanent'});
  assert.equal(begin.status,200,JSON.stringify(begin));assert.equal(begin.data.state,'pending');
  const unverified=await extension('activate-complete',{attempt_id,proof});
  assert.equal(unverified.status,409);assert.equal(unverified.data.state,'awaiting_owner');
  const protectedPage=await response('/activate/verify/'+attempt_id+'?extension='+'a'.repeat(32));
  assert.equal(protectedPage.status,404,'without Access configuration no verification is possible');
  const otherOrigin=await extension('activate-begin',{attempt_id:crypto.randomUUID(),proof_hash,alias:'spoof',mode:'temporary'}, {origin:'https://other.example'});
  assert.equal(otherOrigin.status,403);
  assert.equal((await extension('activate-cancel',{attempt_id,proof})).status,200);
  assert.equal((await extension('activate-complete',{attempt_id,proof})).status,403);
  assert.deepEqual((await rpc('tools/call','browser_endpoints')).data.result.content[0].text.includes('"endpoints":[]'),true);
  console.log('Spec #609 workerd distribution and protected ingress: PASS');
}finally{
  cleanup();await sleep(300);
  fs.rmSync(persistence,{recursive:true,force:true});
}
