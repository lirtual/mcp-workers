import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,intent} from './helpers/t4-browser.mjs';
const origin='https://browser.example';
const config={BROWSER_APPROVAL_ORIGIN:origin,
  BROWSER_ACCESS_ISSUER:'https://fixture.cloudflareaccess.com',
  BROWSER_ACCESS_AUDIENCE:'a'.repeat(64),
  BROWSER_OWNER_EMAIL:'owner@example.com',
  BROWSER_APPROVAL_ISOLATION:'isolated-owner-profile-and-mailbox-v1'};

const legacy=op=>'/owner/operations/'+op;
const unknown=op=>'/owner/unknown/'+op;
const opStatus=(f,args)=>f.rpc('browser_operation_status',{endpoint_id:args.endpoint_id,intent_key:args.intent_key});

test('retired owner approval URL and POST never authorize, even with valid signed Owner Access',async()=>{
  const f=await fixture(config);try{
    const signed="synthetic-jwt",id='00000000-0000-0000-0000-000000000000';
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

test('business-labeled buttons execute without an Owner approval route but retain stable receipts',async()=>{
  for(const env of [{},config]){
    const f=await fixture(env);try{
      const args=await f.command('click',e=>e.tag==='button');
      const before=f.effects.length;
      const {admitted,result}=await f.perform('click',args);
      assert.equal(admitted.state,'admitted');
      assert.equal(result.state,'completed');
      assert.equal(result.approval_url,undefined);
      assert.equal(f.effects.length,before+1);
      assert.equal((await opStatus(f,args)).operation_id,admitted.operation_id);
      assert.equal((await opStatus(f,args)).state,'completed');
    }finally{await f.close();}
  }
});

test('ordinary business navigation is allowed while Owner verification origin is protected',async()=>{
  const f=await fixture(config);try{
    const start=f.effects.length;
    const bad={endpoint_id:f.local.endpoint_id,intent_key:intent(),url:'https://browser.example/owner/unknown/123'};
    const submitted=await f.rpc('browser_tab_open',bad);await f.flush();
    const receipt=await opStatus(f,bad);
    assert.equal(receipt.state,'failed');assert.equal(receipt.error_code,'forbidden');
    assert.equal(receipt.approval_url,undefined);assert.equal(f.effects.length,start);
    const safe={...bad,intent_key:intent(),url:'https://example.org/post/save#editor'};
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

test('retired Unknown Review GET/POST never mutate an Unknown even with historical Owner config',async()=>{
  const f=await fixture(config);try{
    const args=await f.command('click',e=>e.tag==='input'&&e.type==='checkbox');
    f.drop();const {admitted}=await f.perform('click',args);
    const before=f.effects.length;
    f.restart();
    const receipt=await opStatus(f,args);
    assert.equal(receipt.state,'unknown');
    assert.equal(receipt.operation_id,admitted.operation_id);
    assert.equal(receipt.owner_review_url,undefined);
    assert.match(receipt.safe_next_action,/never_retry/);
    for(const path of [unknown(receipt.operation_id),
      unknown(receipt.operation_id)+'?utm_source=chatgpt.com',
      '/owner/operations/'+receipt.operation_id]){
      assert.equal((await f.http(path,{headers:{'cf-access-jwt-assertion':'synthetic-jwt'}})).status,404);
    }
    const submitted=await f.http(unknown(receipt.operation_id),{method:'POST',headers:{
      'cf-access-jwt-assertion':'synthetic-jwt',origin,
      'content-type':'application/x-www-form-urlencoded'
    },body:new URLSearchParams({nonce:'a'.repeat(64),outcome:'effect_seen'})});
    assert.equal(submitted.status,404);
    assert.equal((await opStatus(f,args)).state,'unknown');
    assert.equal((await f.rpc('browser_click',args)).state,'unknown');
    assert.equal(f.effects.length,before,'no historical Unknown was re-dispatched');
  }finally{await f.close();}
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
