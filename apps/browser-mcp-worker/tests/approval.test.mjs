import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,intent} from './helpers/t4-browser.mjs';
const origin='https://browser.example';
const config={BROWSER_APPROVAL_ORIGIN:origin,BROWSER_ACCESS_ISSUER:'https://fixture.cloudflareaccess.com',BROWSER_ACCESS_AUDIENCE:'a'.repeat(64),BROWSER_OWNER_EMAIL:'owner@example.com',BROWSER_APPROVAL_ISOLATION:'isolated-owner-profile-and-mailbox-v1'};
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'fixture-key',alg:'RS256',use:'sig'};
const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
async function jwt(patch={},header={}){
  const t=Math.floor(Date.now()/1000);
  const value=enc({alg:'RS256',kid:jwk.kid,...header})+'.'+enc({iss:config.BROWSER_ACCESS_ISSUER,aud:[config.BROWSER_ACCESS_AUDIENCE],sub:'owner-identity',type:'app',iat:t-1,exp:t+300,email:config.BROWSER_OWNER_EMAIL,...patch});
  return value+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(value))).toString('base64url');
}
const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=async url=>{assert.equal(url,config.BROWSER_ACCESS_ISSUER+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});};});
test.after(()=>{globalThis.fetch=originalFetch;});
const path=op=>'/owner/operations/'+op;
async function view(f,op,token){return f.http(path(op),{headers:{'cf-access-jwt-assertion':token??await jwt()}});}
async function proposal(f,op){
  const response=await view(f,op);assert.equal(response.status,200);
  const html=await response.text();return {html,nonce:/name="nonce" value="([a-f0-9]{64})"/.exec(html)?.[1],response};
}
async function decide(f,op,nonce,decision='approve',extra={}){
  const response=await f.http(path(op),{method:'POST',headers:{'cf-access-jwt-assertion':await jwt(),origin,'content-type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams({nonce,decision})});
  return {response,html:await response.text()};
}
async function pending(f){
  const effects=f.effects.length;
  const args=await f.command('click',e=>e.tag==='button');
  const {admitted,result}=await f.perform('click',args);
  assert.equal(result.state,'pending_approval',JSON.stringify(result));assert.equal(result.operation_id,admitted.operation_id);assert.equal(admitted.state,'pending_approval');
  assert.equal(result.approval_url,origin+path(result.operation_id));assert.equal(f.effects.length,effects);
  return {args,...result};
}
async function status(f,args){return f.rpc('browser_operation_status',{endpoint_id:args.endpoint_id,intent_key:args.intent_key});}

test('unavailable owner approval displays a safe inline error instead of a downloadable UUID',async()=>{
  for(const env of [{},config]){
    const f=await fixture(env);try{
      const response=await f.http(path('00000000-0000-0000-0000-000000000000'));
      assert.equal(response.status,Object.keys(env).length?401:403);
      assert.equal(response.headers.get('content-type'),'text/plain; charset=utf-8');
      assert.equal(response.headers.get('content-disposition'),null);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.match(await response.text(),/Owner/);
      assert.equal(f.effects.length,0);
    }finally{await f.close();}
  }
});

test('owner HTTP requires cryptographic Access identity, canonical host, aud, issuer, expiry and exact mailbox',async()=>{
  const f=await fixture(config);try{
    const op=await pending(f);
    for(const headers of [{},{authorization:'Bearer test-token'},{'cf-access-authenticated-user-email':config.BROWSER_OWNER_EMAIL},{'cf-access-jwt-assertion':'unsigned'}])
      assert.equal((await f.http(path(op.operation_id),{headers})).status,401);
    for(const patch of [{aud:['b'.repeat(64)]},{iss:'https://other.cloudflareaccess.com'},{exp:1},{email:'agent@example.com'},{nbf:Math.floor(Date.now()/1000)+100},{iat:Math.floor(Date.now()/1000)+100},{type:'service'}])
      assert.equal((await view(f,op.operation_id,await jwt(patch))).status,401);
    for(const header of [{alg:'none'},{kid:'unknown'},{crit:['fake']}])assert.equal((await view(f,op.operation_id,await jwt({},header))).status,401);
    const token=await jwt();const parts=token.split('.');parts[1]=enc({email:config.BROWSER_OWNER_EMAIL,iss:config.BROWSER_ACCESS_ISSUER,aud:[config.BROWSER_ACCESS_AUDIENCE],type:'app',sub:'owner',iat:0,exp:9999999999});
    assert.equal((await view(f,op.operation_id,parts.join('.'))).status,401);
    for(const host of ['https://alternate.example','https://preview.workers.dev','http://browser.example'])
      assert.equal((await f.http(host+path(op.operation_id),{headers:{'cf-access-jwt-assertion':token}})).status,403);
    const p=await proposal(f,op.operation_id);assert.ok(p.nonce);assert.match(p.html,/Submit payment/);assert.match(p.html,/example.com\/clean/);
    assert.equal(p.response.headers.get('cache-control'),'no-store');assert.equal(p.response.headers.get('x-frame-options'),'DENY');
    assert.match(p.response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotMatch(p.html,/<script|<iframe/);
    assert.equal((await f.http(path(op.operation_id)+'?decision=approve',{headers:{'cf-access-jwt-assertion':token}})).status,403);
    assert.equal((await decide(f,op.operation_id,p.nonce,'approve',{origin:'https://evil.example'})).response.status,403);
    assert.equal((await decide(f,op.operation_id,p.nonce,'approve',{'content-type':'application/json'})).response.status,403);
    assert.equal(f.effects.length,0);assert.equal((await status(f,op.args)).state,'pending_approval');
  }finally{await f.close();}
});

test('prepare never executes; independent owner can approve once, deny, and query the original operation',async()=>{
  const f=await fixture(config);try{
    const op=await pending(f);
    assert.equal((await f.popup('status')).activity.approvals[0].operation_id,op.operation_id);
    // Waiting releases the Endpoint: a separate snapshot may be requested.
    const snapshot=await f.snapshot();assert.equal(snapshot.document_id,'doc-1');
    // New snapshot invalidates the old element refs, so create a fresh proposal.
    assert.equal((await proposal(f,op.operation_id)).nonce,undefined);
    assert.equal((await status(f,op.args)).state,'expired');
    const fresh=await pending(f),p=await proposal(f,fresh.operation_id);
    assert.ok(p.nonce);assert.equal(f.effects.length,0,'GET must not grant execution');
    const bad=await decide(f,fresh.operation_id,'0'.repeat(64));assert.match(bad.html,/invalid_nonce/);
    await Promise.all([decide(f,fresh.operation_id,p.nonce),decide(f,fresh.operation_id,p.nonce)]);await f.flush();
    assert.equal(f.effects.length,1);assert.equal((await status(f,fresh.args)).state,'completed');
    await decide(f,fresh.operation_id,p.nonce);await f.rpc('browser_click',fresh.args);await f.flush();assert.equal(f.effects.length,1);
    const denied=await pending(f),d=await proposal(f,denied.operation_id);await decide(f,denied.operation_id,d.nonce,'deny');await f.flush();
    assert.equal((await status(f,denied.args)).state,'denied');assert.equal(f.effects.length,1);
  }finally{await f.close();}
});

test('pending metadata survives DO recreation; session-command loss expires without recovery/replay',async()=>{
  for(const loseCommand of [false,true]){
    const f=await fixture(config);try{
      const op=await pending(f);f.restart();
      assert.equal((await status(f,op.args)).state,'pending_approval');
      if(loseCommand)delete f.session['browser_prepare_'+op.operation_id];
      const p=await proposal(f,op.operation_id);
      if(loseCommand){assert.equal(p.nonce,undefined);assert.equal((await status(f,op.args)).state,'expired');}
      else {assert.ok(p.nonce);await decide(f,op.operation_id,p.nonce);await f.flush();assert.equal((await status(f,op.args)).state,'completed');}
      assert.equal(f.effects.length,loseCommand?0:1);
    }finally{await f.close();}
  }
});

test('navigation, DOM change, run change, TTL, Stop and Revoke invalidate owner authority',async()=>{
  for(const change of ['document','dom','run','ttl','stop','revoke','generation']){
    const f=await fixture(config);try{
      const op=await pending(f),p=await proposal(f,op.operation_id);assert.ok(p.nonce);
      if(change==='document')f.pageState.document_id='other-document';
      if(change==='dom')f.pageState.mutated=true;
      if(change==='run')f.session.browser_approval_run=crypto.randomUUID();
      if(change==='ttl')f.db.prepare('UPDATE browser_approvals SET expires_at=?').run(Date.now()-1);
      if(change==='stop')await f.rpc('browser_stop',{endpoint_id:op.args.endpoint_id});
      if(change==='revoke')await f.rpc('browser_revoke',{endpoint_id:op.args.endpoint_id});
      if(change==='generation')f.db.prepare('UPDATE endpoints SET generation=generation+1').run();
      await decide(f,op.operation_id,p.nonce);await f.flush();
      assert.equal(f.effects.length,0,change);assert.equal((await status(f,op.args)).state,'expired',change);
    }finally{await f.close();}
  }
});

test('execute with lost receipt becomes Unknown on recreation and never replays',async()=>{
  const f=await fixture(config);try{
    const op=await pending(f),p=await proposal(f,op.operation_id);f.drop();await decide(f,op.operation_id,p.nonce);await f.flush();
    assert.equal(f.effects.length,1);f.restart();assert.equal((await status(f,op.args)).state,'unknown');
    await decide(f,op.operation_id,p.nonce);await f.rpc('browser_click',op.args);await f.flush();assert.equal(f.effects.length,1);
  }finally{await f.close();}
});

test('isolation missing or incomplete remains Blocked and stores no page content or command in DO/local receipts',async()=>{
  for(const env of [{},{...config,BROWSER_APPROVAL_ISOLATION:''},{...config,BROWSER_APPROVAL_ORIGIN:'https://another.example'}]){
    const f=await fixture(env);try{
      const args=await f.command('click',e=>e.tag==='button');
      const op=await f.perform('click',args);assert.equal(op.result.state,'failed');assert.equal(op.result.error_code,'approval_blocked');assert.equal(f.effects.length,0);
    }finally{await f.close();}
  }
  const f=await fixture(config);try{
    f.pageState.url='https://example.com/clean?fixture=seed-not-persisted';
    const op=await pending(f);await proposal(f,op.operation_id);
    const rows=f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const data=JSON.stringify(rows.flatMap(r=>f.db.prepare('SELECT * FROM '+r.name).all()));
    for(const value of ['Submit payment','seed-not-persisted','example.com/clean','document_id','element_id','textContent'])assert.ok(!data.includes(value),value);
    assert.ok(!JSON.stringify(f.local).includes('seed-not-persisted'));
    assert.match(data,/[a-f0-9]{64}/);
  }finally{await f.close();}
});

test('commitment refuses changed exact args, target, display or operation identity; 10 pending limit is fail closed',async()=>{
  for(const mutate of [s=>{s.command.tab_id=2;},s=>{s.command.document_id='other';},s=>{s.command.element_id='e-'+crypto.randomUUID();},s=>{s.command.action='fill';s.command.text='seed-payload';},s=>{s.context.target_url='https://example.com/other';},s=>{s.context.description='Different intent';}]){
    const f=await fixture(config);try{
      const op=await pending(f);mutate(f.session['browser_prepare_'+op.operation_id]);
      assert.equal((await proposal(f,op.operation_id)).nonce,undefined);assert.equal((await status(f,op.args)).state,'expired');assert.equal(f.effects.length,0);
    }finally{await f.close();}
  }
  const f=await fixture(config);try{
    for(let i=0;i<10;i++)await pending(f);
    assert.equal((await f.popup('status')).activity.approvals.length,10);
    const args=await f.command('click',e=>e.tag==='button');const op=await f.perform('click',args);
    assert.equal(op.result.state,'failed');assert.equal(f.effects.length,0);
    const bad=await f.rpc('browser_fill',{...args,text:'x'.repeat(2001)});assert.equal(bad.error_code,'invalid_arguments');
    const last=f.db.prepare("SELECT operation_id,endpoint_id FROM browser_intents WHERE state='pending_approval' LIMIT 1").get();
    const receipt=await f.rpc('browser_operation_status',{endpoint_id:last.endpoint_id,operation_id:last.operation_id});assert.equal(receipt.operation_id,last.operation_id);assert.equal(receipt.state,'pending_approval');
    assert.equal((await f.rpc('browser_operation_status',{endpoint_id:crypto.randomUUID(),operation_id:last.operation_id})).error_code,'not_found');
  }finally{await f.close();}
});

test('approval cannot cross execute-time Stop or forbidden owner/SSO surfaces',async()=>{
  // The same exclusion predicate gates tabs, snapshots, screenshots and mutations.
  for(const url of [origin+'/owner/operations/'+crypto.randomUUID(),config.BROWSER_ACCESS_ISSUER+'/cdn-cgi/access/login','https://mail.google.com/']){
    const f=await fixture(config);try{
      const args=await f.command('click',e=>e.tag==='button');f.pageState.url=url;
      for(const tool of ['browser_snapshot','browser_screenshot'])assert.ok((await f.rpc(tool,{endpoint_id:args.endpoint_id,tab_id:1})).error_code);
      assert.equal((await f.perform('click',args)).result.state,'failed');assert.equal(f.effects.length,0);
    }finally{await f.close();}
  }
  const f=await fixture(config);try{
    const op=await pending(f),p=await proposal(f,op.operation_id);f.hold();await decide(f,op.operation_id,p.nonce);
    await f.rpc('browser_stop',{endpoint_id:op.args.endpoint_id});await f.release();await f.flush();assert.equal(f.effects.length,0);
    assert.equal((await status(f,op.args)).state,'unknown');
  }finally{await f.close();}
});

test('busy approval expires instead of queuing behind an active observation',async()=>{
  const f=await fixture(config);let gate,reading;
  try{
    const op=await pending(f),p=await proposal(f,op.operation_id);gate=f.pauseNextScript();reading=f.snapshot();await gate.entered;
    const decision=await decide(f,op.operation_id,p.nonce);assert.match(decision.html,/expired/);assert.equal(f.effects.length,0);
    gate.release();await reading;assert.equal((await status(f,op.args)).state,'expired');
  }finally{gate?.release();if(reading)await reading;await f.close();}
});

test('identified consequential URL is pending, meaningful destination is transient, and owner authorizes one original open',async()=>{
  const f=await fixture(config);try{
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/action?confirm=1&note=ephemeral-seed'};
    const result=await f.rpc('browser_tab_open',args);await f.flush();assert.equal(result.state,'pending_approval');assert.equal(f.effects.length,0);
    const p=await proposal(f,result.operation_id);assert.match(p.html,/confirm=1/);assert.match(p.html,/ephemeral-seed/);
    await decide(f,result.operation_id,p.nonce);await f.flush();assert.equal((await status(f,args)).state,'completed');
    assert.equal(f.effects.length,1);assert.deepEqual(f.effects[0],['tab_open',args.url,1]);
    const durable=JSON.stringify(f.db.prepare('SELECT * FROM browser_intents').all())+JSON.stringify(f.db.prepare('SELECT * FROM browser_approvals').all());
    assert.ok(!durable.includes('ephemeral-seed'));
  }finally{await f.close();}
});

test('minor Chrome/Worker clock skew leaves approval preparation usable without widening the five-minute limit',async()=>{
  for(const offset of [-20000,-10000,0,10000]){
    const f=await fixture(config,{extensionClockOffsetMs:offset});try{
      const started=Date.now();const op=await pending(f);
      assert.ok(op.expires_at>started+235000,'approval should remain usable, clock offset '+offset);
      assert.ok(op.expires_at<=Date.now()+270000,'approval must retain a bounded shorter deadline');
      assert.equal(f.effects.length,0);
    }finally{await f.close();}
  }
  const f=await fixture(config,{extensionClockOffsetMs:-45000});try{
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/delete/clock-offset-denied'};
    await f.rpc('browser_tab_open',args);await f.flush();
    const result=await status(f,args);
    assert.equal(result.state,'failed');assert.equal(result.error_code,'prepare_expired');
    assert.equal(f.effects.length,0,'larger skew must fail closed without a browser effect');
  }finally{await f.close();}
});

test('production-style consequential delete URL receives a denial-only owner proposal, without opening a tab',async()=>{
  const f=await fixture(config);try{
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/delete/spec418-owner-deny-check-20261029-v3'};
    const admitted=await f.rpc('browser_tab_open',args);await f.flush();
    const result=await status(f,args);
    assert.equal(result.state,'pending_approval',JSON.stringify({admitted,result}));
    assert.equal(f.effects.length,0);
    const page=await proposal(f,result.operation_id);
    assert.ok(page.nonce);
    assert.match(page.html,/spec418-owner-deny-check-20261029-v3/);
    await decide(f,result.operation_id,page.nonce,'deny');await f.flush();
    assert.equal((await status(f,args)).state,'denied');
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test('a stale extension without the owner approval handshake is blocked, never dispatched',async()=>{
  const f=await fixture(config,{legacyOwnerProtocol:true});try{
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/delete/legacy-client-check'};
    await f.rpc('browser_tab_open',args);await f.flush();
    const result=await status(f,args);
    assert.equal(result.state,'failed');
    assert.equal(result.error_code,'approval_blocked');
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test('preparation storage failure yields a stable safe receipt, never a website effect',async()=>{
  const f=await fixture(config);try{
    const storage=f.chrome.storage.session;
    const originalSet=storage.set;
    storage.set=async data=>{
      if(Object.keys(data).some(k=>k.startsWith('browser_prepare_')))throw Error('simulated confidential storage failure');
      return originalSet(data);
    };
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/delete/storage-check'};
    await f.rpc('browser_tab_open',args);await f.flush();
    const result=await status(f,args);
    assert.equal(result.state,'failed');
    assert.equal(result.error_code,'prepare_storage_unavailable');
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test('local authorization mismatch is a fixed no-content preparation failure, not a browser effect',async()=>{
  const f=await fixture(config);try{
    f.local.authorization='stopped';
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/delete/local-stop-test'};
    await f.rpc('browser_tab_open',args);await f.flush();
    const result=await status(f,args);
    assert.equal(result.state,'failed');
    assert.equal(result.error_code,'prepare_context_changed');
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test('malformed approval run proof produces a safe fixed failure code',async()=>{
  const f=await fixture(config);try{
    f.session.browser_approval_run='not-a-valid-uuid';
    const args={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/delete/invalid-proof'};
    await f.rpc('browser_tab_open',args);await f.flush();
    const result=await status(f,args);
    assert.equal(result.state,'failed');
    assert.equal(result.error_code,'approval_prepare_invalid');
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test('an embedded document is excluded from snapshot and indirect interaction',async()=>{
  const f=await fixture(config);try{
    const args=await f.command('click',e=>e.tag==='button');f.pageState.embedded=true;
    assert.equal((await f.snapshot()).error_code,'sensitive_surface');
    assert.equal((await f.perform('click',args)).result.state,'failed');assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test('independent owner Unknown review records reported outcome once, never turns it into observed success or replays',async()=>{
  const f=await fixture(config);try{
    const endpoint_id=f.local.endpoint_id,intent_key=intent();
    f.drop(); // one browser effect; its original execution receipt is lost
    const result=await f.rpc('browser_tab_open',{endpoint_id,intent_key,url:'https://example.com/clean'});
    await f.flush();f.restart();
    const before=await status(f,{endpoint_id,intent_key});
    assert.equal(before.state,'unknown',JSON.stringify(before));
    const effects=f.effects.length;
    const route='/owner/unknown/'+result.operation_id,token=await jwt();
    assert.equal(before.owner_review_url,origin+route);
    assert.equal((await f.http(route)).status,401);
    assert.equal((await f.http('https://alternate.example'+route,{headers:{'cf-access-jwt-assertion':token}})).status,403);
    const view=await f.http(route,{headers:{'cf-access-jwt-assertion':token}});
    assert.equal(view.status,200);
    assert.equal(view.headers.get('cache-control'),'no-store');
    const page=await view.text();
    assert.doesNotMatch(page,/https:\/\/example\.com\/clean/);
    const nonce=/name="nonce" value="([a-f0-9]{64})"/.exec(page)?.[1];
    assert.ok(nonce,'trusted owner receives one-time Unknown review nonce');
    const submit=async(n,originHeader=origin,outcome='effect_seen')=>f.http(route,{method:'POST',headers:{
      'cf-access-jwt-assertion':await jwt(),origin:originHeader,'content-type':'application/x-www-form-urlencoded'
    },body:new URLSearchParams({nonce:n,outcome})});
    assert.equal((await submit(nonce,'https://evil.example')).status,403);
    assert.equal((await submit('f'.repeat(64))).status,403);
    f.db.prepare('UPDATE browser_owner_resolutions SET nonce_expires_at=? WHERE operation_id=?').run(Date.now()-1,result.operation_id);
    assert.equal((await submit(nonce)).status,403,'expired review nonce must fail');
    const renewed=await f.http(route,{headers:{'cf-access-jwt-assertion':token}});
    const freshNonce=/name="nonce" value="([a-f0-9]{64})"/.exec(await renewed.text())?.[1];
    assert.ok(freshNonce && freshNonce!==nonce);
    const [first,second]=await Promise.all([submit(freshNonce),submit(freshNonce)]);
    assert.deepEqual([first.status,second.status].sort(),[200,403],'at most one concurrent owner report');
    const report=await status(f,{endpoint_id,intent_key});
    assert.equal(report.state,'owner_reported_resolution');
    assert.equal(report.owner_reported_resolution,'effect_seen');
    assert.equal(f.effects.length,effects);
    assert.notEqual(report.state,'completed');
    assert.notEqual((await submit(freshNonce)).status,200,'replaying owner review must fail');
    await f.rpc('browser_tab_open',{endpoint_id,intent_key,url:'https://example.com/clean'});await f.flush();
    assert.equal(f.effects.length,effects);
  }finally{await f.close();}
});


test('LAN/private consent allows observation and ordinary interaction but never replaces independent owner approval',async()=>{
  for(const mode of ['lan','private','both']){
    const f=await fixture(config);try{
      f.pageState.nativePrivate=true;
      if(mode!=='private'){await f.popup('sensitive-permission',{surface:'lan',enabled:true});f.pageState.url='http://192.168.1.7/app?private=QUERY_SEED';}
      if(mode!=='lan'){await f.popup('sensitive-permission',{surface:'private',enabled:true});f.pageState.incognito=true;}
      const ordinary=await f.command('click',e=>e.type==='checkbox');assert.equal((await f.perform('click',ordinary)).result.state,'completed');
      const op=await pending(f),p=await proposal(f,op.operation_id);assert.ok(p.nonce);
      await decide(f,op.operation_id,p.nonce);await f.flush();assert.equal((await status(f,op.args)).state,'completed');
      const revoked=await pending(f),surface=mode==='private'?'private':'lan';
      if(mode==='private')f.pageState.nativeFailure=true;
      else await f.popup('sensitive-permission',{surface,enabled:false});
      const denied=await proposal(f,revoked.operation_id);assert.equal(denied.nonce,undefined);
      assert.equal((await status(f,revoked.args)).state,'expired');
      const persisted=JSON.stringify({local:f.local,rows:f.db.prepare('SELECT * FROM browser_intents').all()});
      for(const seed of ['QUERY_SEED','192.168.1.7','Submit payment'])assert.ok(!persisted.includes(seed));
    }finally{await f.close();}
  }
});
