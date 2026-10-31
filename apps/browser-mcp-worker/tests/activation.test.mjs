import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BrowserOwner} from '../src/coordinator.ts';
import worker from '../src/worker.ts';
const OFFICIAL_EXTENSION_ID='jhifaghneomgcfollcdbncjkcloedfem';
const hash=async x=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x))),b=>b.toString(16).padStart(2,'0')).join('');
const proof='b'.repeat(64);
function fixture(){
  const db=new DatabaseSync(':memory:');
  const sql={exec(query,...args){const stmt=db.prepare(query);if(stmt.columns().length)return {toArray:()=>stmt.all(...args),rowsWritten:0};return {toArray:()=>[],rowsWritten:Number(stmt.run(...args).changes)};}};
  let nextAlarm=null;
  const storage={sql,getAlarm:async()=>nextAlarm,setAlarm:async deadline=>{nextAlarm=deadline;}};
  const owner=new BrowserOwner({storage,getWebSockets:()=>[]});
  const post=async(route,payload)=>{const r=await owner.fetch(new Request('https://owner.internal/'+route,{method:'POST',body:JSON.stringify(payload)}));return {status:r.status,...await r.json()};};
  return {db,sql,storage,post,alarm:()=>owner.alarm(),getAlarm:()=>nextAlarm};
}
async function begin(f,mode='permanent',prior={}){
  const attempt_id=crypto.randomUUID();const r=await f.post('activate-begin',{attempt_id,proof_hash:await hash(proof),mode,alias:'Chrome profile',...prior});assert.equal(r.status,200,JSON.stringify(r));return attempt_id;
}
test('Access proof and local proof are both required; replay or copied proof fails',async()=>{
  const f=fixture();try{const id=await begin(f);
    assert.equal((await f.post('activate-complete',{attempt_id:id,proof})).status,409);
    assert.equal((await f.post('activate-authorize',{attempt_id:id})).status,200);
    assert.equal((await f.post('activate-complete',{attempt_id:id,proof:'c'.repeat(64)})).status,403);
    const grant=await f.post('activate-complete',{attempt_id:id,proof});assert.equal(grant.status,200);
    assert.match(grant.credential,/^[a-f0-9]{64}$/);
    assert.equal((await f.post('activate-complete',{attempt_id:id,proof})).status,403);
    const stopped=await f.post('local-stop',{endpoint_id:grant.endpoint_id,credential:grant.credential});assert.equal(stopped.authorization,'stopped');
    assert.equal((await f.post('local-resume',{endpoint_id:grant.endpoint_id,credential:grant.credential})).status,410);
  }finally{f.db.close();}
});
test('Stop epoch defeats a late verified Access activation',async()=>{
  const f=fixture();try{const first=await begin(f);await f.post('activate-authorize',{attempt_id:first});
    const paired=await f.post('activate-complete',{attempt_id:first,proof});
    await f.post('local-stop',{endpoint_id:paired.endpoint_id,credential:paired.credential});
    const prior={endpoint_id:paired.endpoint_id,credential:paired.credential};
    const pending=await begin(f,'permanent',prior);await f.post('activate-authorize',{attempt_id:pending});
    await f.post('local-stop',prior);
    assert.equal((await f.post('activate-complete',{attempt_id:pending,proof,...prior})).status,409);
    assert.equal((await f.post('state',prior)).authorization,'stopped');
  }finally{f.db.close();}
});
test('temporary lease is bounded and no mode upgrade or expired renewal is allowed',async()=>{
  const f=fixture();try{const id=await begin(f,'temporary');await f.post('activate-authorize',{attempt_id:id});
    const paired=await f.post('activate-complete',{attempt_id:id,proof});
    assert.equal(paired.pairing_mode,'temporary');assert.ok(paired.lease_expires_at>Date.now());
    const prior={endpoint_id:paired.endpoint_id,credential:paired.credential};
    const attempt_id=crypto.randomUUID();
    assert.equal((await f.post('activate-begin',{attempt_id,proof_hash:await hash(proof),mode:'permanent',alias:'Profile',...prior})).status,403);
    f.sql.exec('UPDATE endpoints SET lease_expires_at=? WHERE id=?',Date.now()-1,paired.endpoint_id);
    assert.equal((await f.post('activate-begin',{attempt_id:crypto.randomUUID(),proof_hash:await hash(proof),mode:'temporary',alias:'Profile',...prior})).status,403);
  }finally{f.db.close();}
});
test('identity endpoint without Access assertion does not authorize or leak challenge',async()=>{
  let called=0;const env={BROWSER_ACTIVATION_ORIGIN:'https://browser.example',BROWSER_ACTIVATION_AUDIENCE:'a'.repeat(64),BROWSER_ACCESS_ISSUER:'https://team.cloudflareaccess.com',BROWSER_OWNER_EMAIL:'owner@example.com',BROWSER_OWNER:{idFromName:()=>1,get:()=>({fetch:async()=>{called++;return Response.json({state:'verified'});}})}};
  const r=await worker.fetch(new Request('https://browser.example/activate/verify/'+crypto.randomUUID()),env);
  assert.equal(r.status,404);assert.equal(called,0);
});
test('temporary network loss grants a bounded offline window; stale generations do not revoke newer grants',async()=>{
 const f=fixture();try{
  const id=await begin(f,'temporary');await f.post('activate-authorize',{attempt_id:id});
  const p=await f.post('activate-complete',{attempt_id:id,proof});
  f.sql.exec('UPDATE endpoints SET generation=3 WHERE id=?',p.endpoint_id);
  let generation=2;
  const socket={deserializeAttachment:()=>({authenticated:true,endpoint_id:p.endpoint_id,generation}),send:()=>{},close:()=>{}};
  const owner=new BrowserOwner({storage:f.storage,getWebSockets:()=>[socket]});
  await owner.webSocketClose(socket,1006,'network',false);
  assert.equal(f.sql.exec('SELECT offline_deadline FROM endpoints WHERE id=?',p.endpoint_id).toArray()[0].offline_deadline,null);
  generation=3;await owner.webSocketClose(socket,1006,'network',false);
  const offline=f.sql.exec('SELECT offline_deadline FROM endpoints WHERE id=?',p.endpoint_id).toArray()[0].offline_deadline;
  assert.ok(offline>Date.now()&&offline<=Date.now()+90000);
  assert.equal(f.getAlarm(),offline);
  assert.equal((await f.post('state',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'enabled');
  assert.equal((await f.post('read',{endpoint_id:p.endpoint_id,tool:'tabs'})).error_code,'offline');

  let attachment={authenticated:false,deadline:Date.now()+5000},authenticated=false;
  const reconnect={deserializeAttachment:()=>attachment,serializeAttachment:v=>{attachment=v;},send:frame=>{if(JSON.parse(frame).type==='authenticated')authenticated=true;},close:()=>{},readyState:1};
  const reconnector=new BrowserOwner({storage:f.storage,getWebSockets:()=>[reconnect]});
  await reconnector.webSocketMessage(reconnect,JSON.stringify({type:'authenticate',protocol:3,extension_version:'0.2.2',endpoint_id:p.endpoint_id,credential:p.credential}));
  assert.equal(authenticated,true);
  assert.equal(f.sql.exec('SELECT offline_deadline FROM endpoints WHERE id=?',p.endpoint_id).toArray()[0].offline_deadline,null);
  assert.equal((await f.post('state',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'enabled');
  await owner.webSocketClose(socket,1006,'stale',false);
  assert.equal(f.sql.exec('SELECT offline_deadline FROM endpoints WHERE id=?',p.endpoint_id).toArray()[0].offline_deadline,null);
  await reconnector.webSocketClose(reconnect,1006,'network',false);
  assert.ok(f.sql.exec('SELECT offline_deadline FROM endpoints WHERE id=?',p.endpoint_id).toArray()[0].offline_deadline>Date.now());
  f.sql.exec('UPDATE endpoints SET offline_deadline=? WHERE id=?',Date.now()-1,p.endpoint_id);
  await f.alarm();
  assert.equal((await f.post('state',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'revoked');
  assert.equal((await f.post('read',{endpoint_id:p.endpoint_id,tool:'tabs'})).status,403);
 }finally{f.db.close();}
});

test('expired temporary lease denies an existing authenticated socket read',async()=>{
 const f=fixture();try{
  const id=await begin(f,'temporary');await f.post('activate-authorize',{attempt_id:id});
  const p=await f.post('activate-complete',{attempt_id:id,proof});
  let sent=0;
  const sock={deserializeAttachment:()=>({authenticated:true,protocol:3,endpoint_id:p.endpoint_id,generation:1,last_seen:Date.now()}),readyState:1,send:()=>{sent++;},close:()=>{}};
  f.sql.exec('UPDATE endpoints SET generation=1,lease_expires_at=? WHERE id=?',Date.now()-1,p.endpoint_id);
  const owner=new BrowserOwner({storage:f.storage,getWebSockets:()=>[sock]});
  const read=await owner.fetch(new Request('https://owner.internal/read',{method:'POST',body:JSON.stringify({endpoint_id:p.endpoint_id,tool:'tabs'})}));
  assert.equal(read.status,403);
  assert.equal((await read.json()).error_code,'revoked');
  assert.equal(sent,1,'only a revoke signal, not a read request, may be sent');
  assert.equal((await f.post('state',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'revoked');
 }finally{f.db.close();}
});

test('temporary offline grace never overrules Stop/Revoke; alarm failure fails closed',async()=>{
 const f=fixture();try{
  const id=await begin(f,'temporary');await f.post('activate-authorize',{attempt_id:id});
  const p=await f.post('activate-complete',{attempt_id:id,proof});
  f.sql.exec('UPDATE endpoints SET generation=1 WHERE id=?',p.endpoint_id);
  const socket={deserializeAttachment:()=>({authenticated:true,endpoint_id:p.endpoint_id,generation:1}),send:()=>{},close:()=>{}};
  const owner=new BrowserOwner({storage:f.storage,getWebSockets:()=>[socket]});
  await owner.webSocketClose(socket,1006,'network',false);
  assert.ok(f.sql.exec('SELECT offline_deadline FROM endpoints WHERE id=?',p.endpoint_id).toArray()[0].offline_deadline>Date.now());
  assert.equal((await f.post('local-stop',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'stopped');
  await owner.webSocketClose(socket,1006,'late',false);
  f.sql.exec('UPDATE endpoints SET offline_deadline=? WHERE id=?',Date.now()-1,p.endpoint_id);
  await f.alarm();
  assert.equal((await f.post('state',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'stopped');
  assert.equal((await f.post('local-revoke',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'revoked');
  assert.equal((await f.post('read',{endpoint_id:p.endpoint_id,tool:'tabs'})).status,403);
 }finally{f.db.close();}
 const g=fixture();try{
  const id=await begin(g,'temporary');await g.post('activate-authorize',{attempt_id:id});
  const p=await g.post('activate-complete',{attempt_id:id,proof});
  g.sql.exec('UPDATE endpoints SET generation=1 WHERE id=?',p.endpoint_id);
  g.storage.setAlarm=async()=>{throw Error('alarm unavailable');};
  const socket={deserializeAttachment:()=>({authenticated:true,endpoint_id:p.endpoint_id,generation:1}),send:()=>{},close:()=>{}};
  await new BrowserOwner({storage:g.storage,getWebSockets:()=>[socket]}).webSocketClose(socket,1006,'network',false);
  assert.equal((await g.post('state',{endpoint_id:p.endpoint_id,credential:p.credential})).authorization,'revoked');
 }finally{g.db.close();}
});

test('signed Access GET is read-only, same-origin POST verifies once, wrong audience and CSRF fail closed',async()=>{
  const f=fixture(),id=await begin(f);
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const publicKey={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'activation-test',use:'sig',alg:'RS256'};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuer='https://activation-test.cloudflareaccess.com';
  const env={BROWSER_ACTIVATION_ORIGIN:'https://browser.example',BROWSER_ACTIVATION_AUDIENCE:'b'.repeat(64),BROWSER_ACCESS_ISSUER:issuer,BROWSER_OWNER_EMAIL:'owner@example.com',BROWSER_OWNER:{idFromName:()=>1,get:()=>({fetch:async(url,init)=>{const result=await f.post(new URL(url).pathname.slice(1),JSON.parse(init.body));return Response.json(result,{status:result.status});}})}};
  async function token(aud=env.BROWSER_ACTIVATION_AUDIENCE){const t=Math.floor(Date.now()/1000);
    const v=encode({alg:'RS256',kid:publicKey.kid})+'.'+encode({iss:issuer,aud:[aud],sub:'owner',type:'app',iat:t-1,exp:t+300,email:'owner@example.com'});
    return v+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(v))).toString('base64url');
  }
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({keys:[publicKey]});
  try{
    const path='/activate/verify/'+id+'?extension='+OFFICIAL_EXTENSION_ID;
    const request=(method,auth,headers={})=>new Request('https://browser.example'+path,{method,headers:{'cf-access-jwt-assertion':auth,...headers},...(method==='POST'?{body:JSON.stringify({presence:true})}:{})});
    const signed=await token();
    for(const method of ['GET','POST']){
      const invalid=new URL('https://browser.example'+path);
      invalid.searchParams.set('extension','a'.repeat(32));
      const rejected=await worker.fetch(new Request(invalid,{method,headers:{'cf-access-jwt-assertion':signed,
        ...(method==='POST'?{origin:'https://browser.example','content-type':'application/json'}:{})},
        ...(method==='POST'?{body:JSON.stringify({presence:true})}:{})}),env);
      assert.equal(rejected.status,404,'wrong extension ID cannot use signed Access verification');
    }
    assert.equal((await f.post('activate-complete',{attempt_id:id,proof})).state,'awaiting_owner');
    const get=await worker.fetch(request('GET',signed),env);
    assert.equal(get.status,200);const verificationPage=await get.text();
    assert.match(verificationPage,/activation-presence/);
    assert.match(verificationPage,/activation-verified/);
    assert.match(verificationPage,/Identity verified[.] Connecting Browser MCP/);
    assert.doesNotMatch(verificationPage,/window[.]close/);
    assert.equal((await f.post('activate-complete',{attempt_id:id,proof})).state,'awaiting_owner');
    assert.equal((await worker.fetch(request('GET',await token('c'.repeat(64))),env)).status,404);
    assert.equal((await worker.fetch(request('POST',signed,{'content-type':'application/json'}),env)).status,404);
    const confirmed=await worker.fetch(request('POST',signed,{origin:'https://browser.example','content-type':'application/json'}),env);
    assert.equal(confirmed.status,200);
    assert.equal((await worker.fetch(request('POST',signed,{origin:'https://browser.example','content-type':'application/json'}),env)).status,404);
    assert.equal((await f.post('activate-complete',{attempt_id:id,proof})).authorization,'enabled');
  }finally{globalThis.fetch=originalFetch;f.db.close();}
});
test('activation GET only renders a protected Profile callback; signed same-origin POST verifies identity',async()=>{
 const key=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await crypto.subtle.exportKey('jwk',key.publicKey),kid:'key-test',alg:'RS256',use:'sig'};
 const issuer='https://fixture.cloudflareaccess.com', audience='c'.repeat(64), owner='owner@example.com';
 let verified=0;
 const env={BROWSER_ACTIVATION_ORIGIN:'https://browser.example',BROWSER_ACTIVATION_AUDIENCE:audience,
  BROWSER_ACCESS_ISSUER:issuer,BROWSER_OWNER_EMAIL:owner,BROWSER_OWNER:{idFromName:()=>1,get:()=>({fetch:async()=>{verified++;return Response.json({state:'verified'});}})}};
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const token=async changes=>{const now=Math.floor(Date.now()/1000);const data=encode({alg:'RS256',kid:jwk.kid})+'.'+encode({iss:issuer,aud:[audience],email:owner,sub:'owner-test',type:'app',iat:now-1,exp:now+120,...changes});
  return data+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key.privateKey,new TextEncoder().encode(data))).toString('base64url');};
 const existing=globalThis.fetch;globalThis.fetch=async(url,options)=>{
  assert.equal(url,issuer+'/cdn-cgi/access/certs');assert.equal(options.redirect,'manual');return Response.json({keys:[jwk]});};
 try{
  const path='/activate/verify/'+crypto.randomUUID()+'?extension='+OFFICIAL_EXTENSION_ID;
  const run=async(jwt,suffix='',method='GET')=>worker.fetch(new Request('https://browser.example'+path+suffix,{method,headers:{'cf-access-jwt-assertion':jwt,...(method==='POST'?{'origin':'https://browser.example','content-type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify({presence:true})}:{})}),env);
  assert.equal((await run(await token({aud:['d'.repeat(64)]}))).status,404);
  assert.equal((await run(await token({email:'attacker@example.com'}))).status,404);
  assert.equal((await run(await token({}), '&approval=1')).status,404);
  assert.equal(verified,0);
  const identity=await token({});const good=await run(identity);assert.equal(good.status,200);assert.match(await good.text(),/activation-presence/);
  assert.equal(verified,0,'GET never commits an activation');
  const post=await run(identity,'','POST');assert.equal(post.status,200);assert.equal(verified,1);
 }finally{globalThis.fetch=existing;}
});

test('existing permanent Endpoint survives additive DO schema upgrade with credential, generation and Stop epoch intact',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE endpoints (id TEXT PRIMARY KEY, alias TEXT NOT NULL, credential_hash TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, stop_epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  const endpoint_id='11111111-1111-4111-8111-111111111111';
  db.prepare("INSERT INTO endpoints(id,alias,credential_hash,state,generation,revision,stop_epoch,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(endpoint_id,'legacy-chrome','a'.repeat(64),'stopped',9,11,7,1000);
  const sql={exec(query,...args){const stmt=db.prepare(query);if(stmt.columns().length)return {toArray:()=>stmt.all(...args),rowsWritten:0};return {toArray:()=>[],rowsWritten:Number(stmt.run(...args).changes)};}};
  try{
    new BrowserOwner({storage:{sql},getWebSockets:()=>[]});
    const row=db.prepare('SELECT * FROM endpoints WHERE id=?').get(endpoint_id);
    assert.equal(row.alias,'legacy-chrome');assert.equal(row.credential_hash,'a'.repeat(64));
    assert.equal(row.state,'stopped');assert.equal(row.generation,9);
    assert.equal(row.revision,11);assert.equal(row.stop_epoch,7);
    assert.equal(row.pairing_mode,'permanent');assert.equal(row.lease_expires_at,null);
  }finally{db.close();}
});

test('new browser protocol rejects old extension handshakes and persisted old execution frames',async()=>{
 const f=fixture();try{
  const attempt=await begin(f);await f.post('activate-authorize',{attempt_id:attempt});
  const paired=await f.post('activate-complete',{attempt_id:attempt,proof});
  const owner=new BrowserOwner({storage:f.storage,getWebSockets:()=>[]});
  for(const [protocol,extension_version] of [[2,'0.2.0'],[3,'0.2.0'],[3,'0.2.1']]){
    let reason=null,attachment={authenticated:false,deadline:Date.now()+5000};
    const socket={deserializeAttachment:()=>attachment,serializeAttachment:v=>{attachment=v;},send:()=>{throw Error('obsolete authentication accepted');},close:(_code,why)=>{reason=why;},readyState:1};
    await owner.webSocketMessage(socket,JSON.stringify({type:'authenticate',protocol,extension_version,endpoint_id:paired.endpoint_id,credential:paired.credential}));
    assert.equal(reason,'authentication_required');
    assert.equal(f.sql.exec('SELECT generation FROM endpoints WHERE id=?',paired.endpoint_id).toArray()[0].generation,0);
  }
  let reason=null;
  const obsolete={deserializeAttachment:()=>({authenticated:true,protocol:2,endpoint_id:paired.endpoint_id,generation:0,deadline:0}),send:()=>{throw Error('obsolete frame accepted');},close:(_code,why)=>{reason=why;},readyState:1};
  await owner.webSocketMessage(obsolete,JSON.stringify({type:'ping'}));
  assert.equal(reason,'obsolete_protocol');
 }finally{f.db.close();}
});
