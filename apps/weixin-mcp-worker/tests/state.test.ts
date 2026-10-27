import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { encrypt,decrypt } from '../src/crypto.ts';
import { bindingStatus,sendOnce } from '../src/state.ts';
import type { Env, IlinkSession } from '../src/types.ts';

const id='9c87e9bc-3678-4c0a-88cd-6714c5d63ef4';
const second='21d0b0af-15e4-4cb9-b6c9-58d9e9b35a36';
class FakeD1 {
  readonly sql=new DatabaseSync(':memory:');
  constructor(){this.sql.exec(readFileSync(new URL('../migrations/0001_owner.sql',import.meta.url),'utf8'));}
  prepare(query:string){
    const statement=this.sql.prepare(query);
    const wrapped=(args:unknown[])=>({
      run:async()=>({meta:{changes:Number(statement.run(...(args as [] )).changes)}}),
      first:async<T>()=>(statement.get(...(args as []))??null) as T|null,
    });
    return {...wrapped([]),bind:(...args:unknown[])=>wrapped(args)};
  }
}
function fixture(){
  const db=new FakeD1();
  const env={DB:db as unknown as D1Database,MCP_ACCESS_TOKEN:'test',MCP_HOST:'test.example',
    WEIXIN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')} as Env;
  const session:IlinkSession={botToken:'sensitive-bot-token',ownerId:'owner-id',
    botId:'bot-id',contextToken:'sensitive-context',cursor:'secret-cursor'};
  async function bindReady(generation=1){
    const sealed=await encrypt(env,'weixin:owner:binding:'+generation,session);
    db.sql.prepare('UPDATE weixin_binding SET generation=?,state=?,session_ciphertext=?,session_key_id=?,last_verified_context_at=?,last_sync_at=? WHERE id=1')
      .run(generation,'ready',sealed.ciphertext,sealed.keyId,123456789,123456790);
    return sealed;
  }
  return {db,env,session,bindReady};
}
test('D1 migration contains no plaintext message columns; unbound status blocks sends',async()=>{
  const {db,env}=fixture();
  assert.deepEqual(await bindingStatus(env),{binding_state:'unbound',
    last_verified_context_at:null,last_sync_at:null,next_action:'open_owner_pairing_page'});
  let sends=0;
  await assert.rejects(()=>sendOnce(env,'hello',id,async()=>{sends++;return 'accepted';}),/binding_not_ready/);
  assert.equal(sends,0);
  const columns=db.sql.prepare('pragma table_info(weixin_send_receipts)').all().map(c=>c.name);
  assert.deepEqual(columns,['generation','request_id','text_digest','status','created_at','updated_at']);
});
test('AES-GCM generation AAD, tamper detection and ciphertext at rest',async()=>{
  const {env,session,bindReady,db}=fixture();
  const sealed=await bindReady();
  assert.doesNotMatch(sealed.ciphertext,/sensitive|owner-id|cursor/);
  assert.deepEqual(await decrypt<IlinkSession>(env,'weixin:owner:binding:1',sealed.ciphertext,sealed.keyId),session);
  await assert.rejects(()=>decrypt(env,'weixin:owner:binding:2',sealed.ciphertext,sealed.keyId));
  await assert.rejects(()=>decrypt(env,'weixin:owner:binding:1',sealed.ciphertext.slice(0,-5)+'AAAAA',sealed.keyId));
  const row=db.sql.prepare('SELECT session_ciphertext FROM weixin_binding WHERE id=1').get();
  assert.doesNotMatch(JSON.stringify(row),/sensitive/);
});
test('durable reservation: duplicate ID never triggers a second send, conflicting text errors',async()=>{
  const {env,bindReady,db}=fixture();await bindReady();
  let attempts=0;
  const dispatch=async()=>{attempts++;return 'accepted' as const;};
  const first=await sendOnce(env,'hello',id,dispatch);
  assert.equal(first.status,'accepted');assert.equal(first.duplicate,false);
  const dup=await sendOnce(env,'hello',id,dispatch);
  assert.equal(dup.status,'accepted');assert.equal(dup.duplicate,true);
  await assert.rejects(()=>sendOnce(env,'different text',id,dispatch),/request_id_conflict/);
  assert.equal(attempts,1);
  const row=db.sql.prepare('SELECT * FROM weixin_send_receipts WHERE request_id=?').get(id);
  assert.ok(row);assert.equal(row.status,'accepted');assert.equal(row.generation,1);
  assert.doesNotMatch(JSON.stringify(row),/hello|sensitive/);
});
test('unknown outcome and process failure remain reserved and cannot replay',async()=>{
  const {env,bindReady,db}=fixture();await bindReady();
  let attempts=0;
  const dispatch=async()=>{attempts++;throw new Error('provider ack lost');};
  assert.equal((await sendOnce(env,'one text',id,dispatch)).status,'unknown');
  const same=await sendOnce(env,'one text',id,dispatch);
  assert.equal(same.status,'unknown');assert.equal(same.duplicate,true);
  assert.equal(attempts,1);
  // Crash immediately after reservation: no process receives an ack.
  db.sql.prepare('INSERT INTO weixin_send_receipts VALUES(?,?,?,?,?,?)')
    .run(1,second,'a'.repeat(64),'unknown',100,100);
  assert.equal(db.sql.prepare('SELECT status FROM weixin_send_receipts WHERE request_id=?').get(second)?.status,'unknown');
});
test('two concurrent requests for identical ID dispatch at most once',async()=>{
  const {env,bindReady}=fixture();await bindReady();
  let attempts=0;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const dispatcher=async()=>{attempts++;await gate;return 'accepted' as const;};
  const a=sendOnce(env,'concurrency text',id,dispatcher);
  const b=sendOnce(env,'concurrency text',id,dispatcher);
  release();
  const results=await Promise.all([a,b]);
  assert.equal(attempts,1);
  assert.ok(results.some(x=>x.duplicate));
});
test('input boundaries fail before any upstream write',async()=>{
  const {env,bindReady}=fixture();await bindReady();
  let attempts=0;
  const dispatch=async()=>{attempts++;return 'accepted' as const;};
  for(const [text,request] of [['',id],['   ',id],['x'.repeat(4097),id],['a\u0001b',id],['ok','bad']]){
    await assert.rejects(()=>sendOnce(env,text,request,dispatch));
  }
  assert.equal(attempts,0);
});

test('duplicate receipts never poll, new requests fail closed on unavailable sync',async()=>{
  const {env,bindReady,db}=fixture();await bindReady();
  let polls=0,dispatches=0;
  const sync=async()=>{polls++;};
  const send=async()=>{dispatches++;return 'unknown' as const;};
  assert.equal((await sendOnce(env,'hello',id,send,sync)).status,'unknown');
  assert.equal((await sendOnce(env,'hello',id,send,async()=>{throw new Error('unexpected poll');})).duplicate,true);
  assert.equal(polls,1);
  assert.equal(dispatches,1);
  await assert.rejects(()=>sendOnce(env,'new text',second,send,async()=>{polls++;throw new Error('poll unavailable');}),/poll unavailable/);
  assert.equal(dispatches,1);
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM weixin_send_receipts').get()?.n,1);
});
