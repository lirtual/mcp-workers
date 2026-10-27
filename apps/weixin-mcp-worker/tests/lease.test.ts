import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {encrypt,decrypt} from '../src/crypto.ts';
import {sendOnce} from '../src/state.ts';
import {acquireLease,releaseLease,syncCursorOnce,unbindLocal} from '../src/lease.ts';
import type {Env,IlinkSession} from '../src/types.ts';
const ID='9c87e9bc-3678-4c0a-88cd-6714c5d63ef4';
const OTHER='21d0b0af-15e4-4cb9-b6c9-58d9e9b35a36';
class Db {
  sql=new DatabaseSync(':memory:');
  constructor(){this.sql.exec(readFileSync(new URL('../migrations/0001_owner.sql',import.meta.url),'utf8'));}
  prepare(query:string){
    const stmt=this.sql.prepare(query);
    const prepared=(args:unknown[])=>({
      run:async()=>({meta:{changes:Number(stmt.run(...args as []).changes)}}),
      first:async<T>()=>(stmt.get(...args as [])??null) as T|null,
    });
    return {...prepared([]),bind:(...args:unknown[])=>prepared(args)};
  }
}
async function setup() {
  const db=new Db();
  const env={DB:db as unknown as D1Database, MCP_HOST:'weixin-mcp.example.org',
    MCP_ACCESS_TOKEN:'test',WEIXIN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')} as Env;
  const session:IlinkSession={botToken:'super-secret-token',ownerId:'owner',botId:'bot',
    contextToken:'very-secret-context',cursor:'cursor-0'};
  async function ready(g=1){
    const sealed=await encrypt(env,'weixin:owner:binding:'+g,session);
    db.sql.prepare('UPDATE weixin_binding SET generation=?,state=?,session_ciphertext=?,session_key_id=? WHERE id=1')
      .run(g,'ready',sealed.ciphertext,sealed.keyId);
  }
  await ready();
  return {db,env,session,ready};
}
function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise=new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}
async function until(fn:()=>boolean){
  for(let n=0;n<200&&!fn();n++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.ok(fn(),'a controlled request should enter its transport');
}
test('owner unbind is rejected while send has an active D1 lease; no second request dispatches',async()=>{
  const {db,env,ready}=await setup();
  const gate=deferred<'accepted'>();
  let started=0,otherStarted=0;
  const first=sendOnce(env,'one',ID,async()=>{started++;return gate.promise;});
  await until(()=>started===1);
  await assert.rejects(()=>unbindLocal(env),/binding_busy/);
  await assert.rejects(()=>sendOnce(env,'another',OTHER,async()=>{otherStarted++;return 'accepted';}),
    /binding_busy_or_changed/);
  assert.equal(otherStarted,0);
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM weixin_send_receipts').get()?.n,1);
  gate.resolve('accepted');
  assert.equal((await first).status,'accepted');
  const generation=await unbindLocal(env);
  assert.equal(generation,2);
  const row=db.sql.prepare('SELECT * FROM weixin_binding').get()!;
  assert.equal(row.state,'unbound');assert.equal(row.session_ciphertext,null);
  await ready(2);
  await assert.rejects(()=>sendOnce(env,'one',ID,async()=>{otherStarted++;return 'accepted';}),
    /request_id_generation_conflict/);
  assert.equal(otherStarted,0);
});
test('single poller lease blocks send and unbind; cursor is encrypted, fenced and messages discarded',async()=>{
  const {db,env,session}=await setup();
  const gate=deferred<{msgs:unknown[];get_updates_buf:string}>();
  let polls=0,sends=0;
  const polling=syncCursorOnce(env,async received=>{
    polls++;assert.equal(received.cursor,session.cursor);return gate.promise;
  });
  await until(()=>polls===1);
  await assert.rejects(()=>unbindLocal(env),/binding_busy/);
  await assert.rejects(()=>sendOnce(env,'test',ID,async()=>{sends++;return 'accepted';}),
    /binding_busy_or_changed/);
  assert.equal(sends,0);
  gate.resolve({msgs:[{text:'very sensitive incoming message'}],get_updates_buf:'cursor-1'});
  assert.equal(await polling,'updated');
  const row=db.sql.prepare('SELECT * FROM weixin_binding').get()!;
  assert.equal(row.lease_holder,null);
  assert.equal(row.last_sync_at>0,true);
  assert.doesNotMatch(JSON.stringify(row),/sensitive incoming|cursor-1/);
  const saved=await decrypt<IlinkSession>(env,'weixin:owner:binding:1',
    row.session_ciphertext as string,row.session_key_id as string);
  assert.equal(saved.cursor,'cursor-1');
  assert.equal(polls,1);
});
test('late poll after expired lease and unbind cannot commit old cursor or reset new state',async()=>{
  const {db,env}=await setup();
  const gate=deferred<{msgs:unknown[];get_updates_buf:string}>();
  let started=0;
  const poll=syncCursorOnce(env,async()=>{started++;return gate.promise;});
  await until(()=>started===1);
  db.sql.prepare('UPDATE weixin_binding SET lease_until=?').run(1);
  assert.equal(await unbindLocal(env),2);
  gate.resolve({msgs:[],get_updates_buf:'stale-cursor'});
  await assert.rejects(poll,/binding_changed/);
  const row=db.sql.prepare('SELECT * FROM weixin_binding').get()!;
  assert.equal(row.generation,2);assert.equal(row.state,'unbound');
  assert.equal(row.session_ciphertext,null);assert.equal(row.lease_holder,null);
});
test('failed poll releases lease, malformed response cannot overwrite cursor',async()=>{
  const {db,env}=await setup();
  await assert.rejects(()=>syncCursorOnce(env,async()=>{throw new Error('network');}),/network/);
  await assert.rejects(()=>syncCursorOnce(env,async()=>({msgs:[],get_updates_buf:undefined as unknown as string})),/invalid_response/);
  const row=db.sql.prepare('SELECT * FROM weixin_binding').get()!;
  assert.equal(row.lease_holder,null);assert.equal(row.last_sync_at,null);
  assert.equal(await unbindLocal(env),2);
});
test('late lease release cannot clear another owner or new generation',async()=>{
  const {db,env}=await setup();
  const one=await acquireLease(env,1,['ready']);
  db.sql.prepare('UPDATE weixin_binding SET lease_until=?').run(1);
  const two=await acquireLease(env,1,['ready']);
  await releaseLease(env,one);
  assert.equal(db.sql.prepare('SELECT lease_holder FROM weixin_binding').get()?.lease_holder,two.owner);
  await releaseLease(env,two);
  assert.equal((await unbindLocal(env)),2);
});

test('expired lease without takeover cannot write a formerly successful receipt',async()=>{
  const {db,env}=await setup();
  const gate=deferred<'accepted'>();
  let dispatches=0;
  const action=sendOnce(env,'same message',ID,async()=>{dispatches++;return gate.promise;});
  await until(()=>dispatches===1);
  db.sql.prepare('UPDATE weixin_binding SET lease_until=?').run(1);
  gate.resolve('accepted');
  const outcome=await action;
  assert.equal(outcome.status,'unknown');
  assert.equal(outcome.duplicate,false);
  assert.equal(db.sql.prepare('SELECT status FROM weixin_send_receipts WHERE request_id=?').get(ID)?.status,'unknown');
  const repeat=await sendOnce(env,'same message',ID,async()=>{dispatches++;return 'accepted';});
  assert.equal(repeat.status,'unknown');assert.equal(repeat.duplicate,true);
  assert.equal(dispatches,1,'never replay unknown even after original lease expired');
});
test('expired poll lease without takeover cannot advance an opaque cursor',async()=>{
  const {db,env}=await setup();
  const gate=deferred<{msgs:unknown[];get_updates_buf:string}>();
  let polling=0;
  const task=syncCursorOnce(env,async()=>{polling++;return gate.promise;});
  await until(()=>polling===1);
  const original=db.sql.prepare('SELECT session_ciphertext FROM weixin_binding').get()?.session_ciphertext;
  db.sql.prepare('UPDATE weixin_binding SET lease_until=?').run(1);
  gate.resolve({msgs:[],get_updates_buf:'future-secret-cursor'});
  await assert.rejects(task,/binding_changed/);
  const row=db.sql.prepare('SELECT session_ciphertext,last_sync_at FROM weixin_binding').get()!;
  assert.equal(row.session_ciphertext,original);
  assert.equal(row.last_sync_at,null);
});
test('migration enforces request_id uniqueness across generations at SQL level',async()=>{
  const {db,env}=await setup();
  assert.equal((await sendOnce(env,'text',ID,async()=> 'accepted')).status,'accepted');
  await unbindLocal(env);
  assert.throws(()=>db.sql.prepare(
    'INSERT INTO weixin_send_receipts(generation,request_id,text_digest,status,created_at,updated_at) VALUES(2,?,?,?,?,?)'
  ).run(ID,'f'.repeat(64),'unknown',1,1),/UNIQUE constraint failed/);
});

test('successful empty poll updates last_sync_at without rewriting encrypted cursor',async()=>{
  const {db,env,session}=await setup();
  const before=db.sql.prepare('SELECT session_ciphertext FROM weixin_binding').get()?.session_ciphertext;
  assert.equal(await syncCursorOnce(env,async()=>({msgs:[],get_updates_buf:session.cursor})),'unchanged');
  const row=db.sql.prepare('SELECT session_ciphertext,last_sync_at,lease_holder FROM weixin_binding').get()!;
  assert.equal(row.session_ciphertext,before);
  assert.ok(Number(row.last_sync_at)>1000000000);
  assert.equal(row.lease_holder,null);
});
