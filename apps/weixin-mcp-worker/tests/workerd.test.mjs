import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Exercise Cloudflare's workerd/D1 implementation, not the node:sqlite adapter.
// Every token, account and receipt here is synthetic. No Tencent call is made.
const scriptPath=fileURLToPath(new URL('../.build/weixin/index.js',import.meta.url));
const migration=readFileSync(new URL('../migrations/0001_owner.sql',import.meta.url),'utf8');
const mcpHost='weixin-mcp.example.org';
const adminHost='weixin-owner.example.org';
const portal='test-only-portal-bearer';
const firstId='f43e7f17-c31d-42bf-8358-b454568c32b0';

function runtime(){
  return new Miniflare(convertV4MiniflareOptions({
    port:0,
    workers:[{
      name:'weixin-mcp-worker',
      modules:true,
      script:readFileSync(scriptPath,'utf8'),
      compatibilityDate:'2026-10-27',
      d1Databases:{DB:'weixin-local-test'},
      bindings:{
        MCP_HOST:mcpHost,
        ADMIN_HOST:adminHost,
        MCP_ACCESS_TOKEN:portal,
        WEIXIN_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),
        OWNER_EMAIL:'owner@example.org',
        ACCESS_TEAM_DOMAIN:'owner.cloudflareaccess.com',
        ACCESS_AUD:'owner-test-audience',
      },
    }],
  }));
}
async function call(mf,method,params={},token=portal){
  const res=await mf.dispatchFetch('https://'+mcpHost+'/mcp',{
    method:'POST',headers:{
      'content-type':'application/json',accept:'application/json, text/event-stream',
      ...(token?{authorization:'Bearer '+token}:{}),
    },body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
  });
  return {status:res.status,body:await res.text()};
}

test('actual workerd D1 migration, ingress authorization, CAS lease and receipt replay fencing',async()=>{
  const mf=runtime();
  try{
    const db=await mf.getD1Database('DB');
    await db.exec(migration);
    assert.equal((await db.prepare('SELECT state FROM weixin_binding WHERE id=1')
      .first()).state,'unbound');

    const denied=await call(mf,'tools/list',{},null);
    assert.equal(denied.status,401);
    assert.doesNotMatch(denied.body,/test-only-portal-bearer/);
    const list=await call(mf,'tools/list');
    assert.equal(list.status,200);
    assert.match(list.body,/weixin_status/);
    assert.match(list.body,/weixin_send_message/);
    assert.doesNotMatch(list.body,/weixin_unbind|weixin_start_pairing/);
    const status=await call(mf,'tools/call',{name:'weixin_status',arguments:{}});
    assert.equal(status.status,200);
    assert.match(status.body,/unbound/);
    assert.doesNotMatch(status.body,/test-only-portal-bearer/);
    const noBinding=await call(mf,'tools/call',{name:'weixin_send_message',
      arguments:{text:'synthetic only',request_id:firstId}});
    assert.equal(noBinding.status,200);
    assert.match(noBinding.body,/binding_not_ready/);

    // Workerd-backed SQL lease: two simultaneous contenders cannot both win.
    const t=Math.floor(Date.now()/1000);
    const admit=(holder)=>db.prepare(
      'UPDATE weixin_binding SET lease_holder=?,lease_until=? '+
      'WHERE id=1 AND generation=0 AND state=? '+
      'AND (lease_holder IS NULL OR lease_until<?)'
    ).bind(holder,t+120,'unbound',t).run();
    const wins=await Promise.all([admit('a'),admit('b')]);
    assert.equal(wins.reduce((n,v)=>n+v.meta.changes,0),1);
    // Unbind has to refuse while a lease is active, even when repeated.
    const blocked=await db.prepare(
      "UPDATE weixin_binding SET generation=generation+1,state='unbound',"+
      'lease_holder=NULL,lease_until=NULL WHERE id=1 '+
      'AND (lease_holder IS NULL OR lease_until<?)'
    ).bind(t).run();
    assert.equal(blocked.meta.changes,0);
    const cleared=await db.prepare('UPDATE weixin_binding SET lease_holder=NULL,lease_until=NULL '+
      'WHERE id=1 AND lease_holder IN (?,?)').bind('a','b').run();
    assert.equal(cleared.meta.changes,1);

    // An existing persisted unknown receipt is queryable without ever
    // decrypting a session or contacting the upstream service.
    await db.prepare(
      "UPDATE weixin_binding SET generation=1,state='ready',"+
      "session_ciphertext='synthetic-sealed-fixture',session_key_id='1' WHERE id=1"
    ).run();
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode('synthetic only'))),b=>b.toString(16).padStart(2,'0')).join('');
    await db.prepare(
      "INSERT INTO weixin_send_receipts (generation,request_id,text_digest,status,created_at,updated_at) "+
      "VALUES(1,?,?,'unknown',?,?)"
    ).bind(firstId,digest,t,t).run();
    const duplicate=await call(mf,'tools/call',{name:'weixin_send_message',
      arguments:{text:'synthetic only',request_id:firstId}});
    assert.equal(duplicate.status,200);
    assert.match(duplicate.body,/\\"unknown\\"/);
    assert.match(duplicate.body,/\\"duplicate\\":true/);
    const mismatch=await call(mf,'tools/call',{name:'weixin_send_message',
      arguments:{text:'different synthetic text',request_id:firstId}});
    assert.match(mismatch.body,/request_id_conflict/);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM weixin_send_receipts')
      .first()).n,1);
    await db.prepare('UPDATE weixin_binding SET generation=2 WHERE id=1').run();
    const oldId=await call(mf,'tools/call',{name:'weixin_send_message',
      arguments:{text:'synthetic only',request_id:firstId}});
    assert.match(oldId.body,/request_id_generation_conflict/);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM weixin_send_receipts')
      .first()).n,1);

    // Owner management stays inaccessible without an Access-signed JWT.
    const admin=await mf.dispatchFetch('https://'+adminHost+'/setup');
    assert.equal(admin.status,403);
    assert.doesNotMatch(await admin.text(),/synthetic-sealed-fixture|owner@example.org/);
  }finally{await mf.dispose();}
});
