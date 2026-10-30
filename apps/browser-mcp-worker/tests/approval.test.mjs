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
let forceCertRedirect=false;
test.before(()=>{globalThis.fetch=async (url,init)=>{
  assert.equal(url,config.BROWSER_ACCESS_ISSUER+'/cdn-cgi/access/certs');
  // Production Workers rejects redirect:'error' before any outbound request.
  if(init?.redirect==='error')throw new TypeError('Unsupported redirect mode');
  assert.equal(init?.redirect,'manual');
  if(forceCertRedirect)return new Response(null,{status:302,headers:{location:'https://untrusted.example/certs'}});
  return Response.json({keys:[jwk]});
};});
test.after(()=>{globalThis.fetch=originalFetch;});

const legacy=op=>'/owner/operations/'+op;
const unknown=op=>'/owner/unknown/'+op;
const opStatus=(f,args)=>f.rpc('browser_operation_status',{endpoint_id:args.endpoint_id,intent_key:args.intent_key});

test('retired owner approval URL and POST never authorize, even with valid signed Owner Access',async()=>{
  const f=await fixture(config);try{
    const signed=await jwt(),id='00000000-0000-0000-0000-000000000000';
    for(const path of [legacy(id),'/owner/operations/'+id+'?utm_source=chatgpt.com']){
      const response=await f.http(path,{headers:{'cf-access-jwt-assertion':signed}});
      assert.equal(response.status,404);
      assert.doesNotMatch(await response.text(),/Approve this exact operation|decision=approve/);
    }
    const post=await f.http(legacy(id),{method:'POST',headers:{
      'cf-access-jwt-assertion':signed,origin,'content-type':'application/x-www-form-urlencoded'
    },body:new URLSearchParams({nonce:'a'.repeat(64),decision:'approve'})});
    assert.equal(post.status,404);
    assert.equal(f.effects.length,0);
  }finally{await f.close();}
});

test('consequential button is rejected without approval URL or effects, regardless of Owner configuration',async()=>{
  for(const env of [{},config]){
    const f=await fixture(env);try{
      const args=await f.command('click',e=>e.tag==='button');
      const before=f.effects.length;
      const {admitted,result}=await f.perform('click',args);
      assert.equal(admitted.state,'admitted');
      assert.equal(result.state,'failed');
      assert.equal(result.error_code,'forbidden');
      assert.equal(result.safe_next_action,'blocked_forbidden_target');
      assert.equal(result.approval_url,undefined);
      assert.equal(f.effects.length,before);
      assert.equal((await opStatus(f,args)).operation_id,admitted.operation_id);
      assert.equal((await opStatus(f,args)).state,'failed');
    }finally{await f.close();}
  }
});

test('consequential navigation is denied at original endpoint while ordinary tab open works',async()=>{
  const f=await fixture(config);try{
    const start=f.effects.length;
    const bad={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://example.com/delete'};
    const submitted=await f.rpc('browser_tab_open',bad);await f.flush();
    const receipt=await opStatus(f,bad);
    assert.equal(receipt.state,'failed');assert.equal(receipt.error_code,'forbidden');
    assert.equal(receipt.approval_url,undefined);assert.equal(f.effects.length,start);
    const safe={...bad,intent_key:intent(),url:'https://example.org/public'};
    await f.rpc('browser_tab_open',safe);await f.flush();
    assert.equal((await opStatus(f,safe)).state,'completed');
    assert.ok(f.effects.some(e=>e[0]==='tab_open'&&e[1]===safe.url));
  }finally{await f.close();}
});

test('existing pending_approval state is expired on DO recreation, without dispatch or repeat effect',async()=>{
  const f=await fixture(config);try{
    const args=await f.command('click',e=>e.tag==='input'&&e.type==='checkbox');
    const {admitted,result}=await f.perform('click',args);
    assert.equal(result.state,'completed');
    const before=f.effects.length;
    f.db.prepare("UPDATE browser_intents SET state='pending_approval',execute_token_hash=NULL WHERE operation_id=?").run(admitted.operation_id);
    f.restart();
    const retired=await opStatus(f,args);
    assert.equal(retired.state,'expired');
    assert.equal(retired.error_code,'approval_retired');
    const repeated=await f.rpc('browser_click',args);await f.flush();
    assert.equal(repeated.state,'expired');
    assert.equal(f.effects.length,before);
    assert.equal(retired.operation_id,admitted.operation_id);
  }finally{await f.close();}
});

test('independent Unknown owner review retains signed Access, one-time nonce and no execute authority',async()=>{
  const f=await fixture(config);try{
    const args=await f.command('click',e=>e.tag==='input'&&e.type==='checkbox');
    f.drop();const {admitted}=await f.perform('click',args);
    const before=f.effects.length;
    f.restart();
    const receipt=await opStatus(f,args);
    assert.equal(receipt.state,'unknown');
    assert.equal(receipt.operation_id,admitted.operation_id);
    assert.equal(receipt.owner_review_url,origin+unknown(receipt.operation_id));
    const raw=await f.http(unknown(receipt.operation_id));
    assert.equal(raw.status,401);
    const signed=await jwt();
    const response=await f.http(unknown(receipt.operation_id),{headers:{'cf-access-jwt-assertion':signed}});
    assert.equal(response.status,200);
    const html=await response.text(),nonce=/name="nonce" value="([a-f0-9]{64})"/.exec(html)?.[1];
    assert.ok(nonce);
    assert.doesNotMatch(html,/Approve this exact operation/);
    const report=async()=>f.http(unknown(receipt.operation_id),{method:'POST',headers:{
      'cf-access-jwt-assertion':signed,origin,'content-type':'application/x-www-form-urlencoded'
    },body:new URLSearchParams({nonce,outcome:'effect_seen'})});
    assert.equal((await report()).status,200);
    assert.notEqual((await report()).status,200);
    const recorded=await opStatus(f,args);
    assert.equal(recorded.state,'owner_reported_resolution');
    assert.equal(recorded.owner_reported_resolution,'effect_seen');
    assert.equal(f.effects.length,before);
  }finally{await f.close();}
});

test('Unknown review refuses invalid audience, wrong origin, and redirected JWKS',async()=>{
  const f=await fixture(config);try{
    const id='00000000-0000-0000-0000-000000000000';
    assert.equal((await f.http(unknown(id),{headers:{'cf-access-jwt-assertion':await jwt({aud:['b'.repeat(64)]})}})).status,401);
    assert.equal((await f.http('https://evil.example'+unknown(id),{headers:{'cf-access-jwt-assertion':await jwt()}})).status,403);
    forceCertRedirect=true;
    assert.equal((await f.http(unknown(id),{headers:{'cf-access-jwt-assertion':await jwt()}})).status,401);
  }finally{forceCertRedirect=false;await f.close();}
});

test('legacy owner-approved execute frame never consumes or executes a current prepared operation',async()=>{
  const f=await fixture(config);try{
    const args=await f.command('fill',e=>e.tag==='input'&&e.type==='text',{text:'ordinary'});
    f.hold();const {admitted}=await f.perform('fill',args);
    assert.equal((await opStatus(f,args)).state,'dispatching');
    const before=f.effects.length;
    await f.release({owner_approved:true,run_id:crypto.randomUUID(),expires_at:Date.now()+100000});
    await f.flush();
    assert.equal(f.effects.length,before,'obsolete approval frame must not reach the page');
    f.restart();
    assert.equal((await opStatus(f,args)).state,'unknown','a dispatched-but-unconfirmed operation is not replayed');
    assert.equal((await f.rpc('browser_fill',args)).state,'unknown');
    assert.equal(f.effects.length,before);
    assert.ok(admitted.operation_id);
  }finally{await f.close();}
});

test('legacy prepared approval session never bypasses the new deny policy',async()=>{
  const f=await fixture(config);try{
    const args=await f.command('fill',e=>e.tag==='input'&&e.type==='text',{text:'ordinary'});
    f.hold();const {admitted}=await f.perform('fill',args);
    const key='browser_prepare_'+admitted.operation_id;
    assert.ok(f.session[key]);
    f.session[key].approval_required=true;
    const before=f.effects.length;
    await f.release();await f.flush();
    assert.equal(f.effects.length,before,'old session proposal must not execute');
    f.restart();
    assert.equal((await opStatus(f,args)).state,'unknown');
    assert.equal(f.effects.length,before);
  }finally{await f.close();}
});
