import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {encrypt,decrypt} from '../src/crypto.ts';
import {acquireLease,releaseLease,unbindLocal} from '../src/lease.ts';
import {pairingView,pollPairing,startPairing,verifyPairing} from '../src/pairing.ts';
import type {PairClient} from '../src/pairing.ts';
import {bindingStatus,sendOnce} from '../src/state.ts';
import type {Env,IlinkSession} from '../src/types.ts';

const OWNER='access-sub-1';
const OTHER='access-sub-2';
const ID='f43e7f17-c31d-42bf-8358-b454568c32b0';
class D1{
  readonly sql=new DatabaseSync(':memory:');
  constructor(){this.sql.exec(readFileSync(new URL('../migrations/0001_owner.sql',import.meta.url),'utf8'));}
  prepare(query:string){
    const statement=this.sql.prepare(query);
    const wrapped=(args:unknown[])=>({
      run:async()=>({meta:{changes:Number(statement.run(...args as []).changes)}}),
      first:async<T>()=>(statement.get(...args as [])??null) as T|null,
    });
    return {...wrapped([]),bind:(...args:unknown[])=>wrapped(args)};
  }
}
async function fixture(ready=false){
  const db=new D1();
  const env={DB:db as unknown as D1Database,
    WEIXIN_ENCRYPTION_KEY:Buffer.alloc(32,4).toString('base64')} as Env;
  const existing:IlinkSession={botToken:'old-secret',ownerId:'old-owner',
    botId:'old-bot',contextToken:'old-context',cursor:'old-cursor'};
  if(ready){
    const sealed=await encrypt(env,'weixin:owner:binding:1',existing);
    db.sql.prepare('UPDATE weixin_binding SET state=?,generation=?,session_ciphertext=?,session_key_id=?')
      .run('ready',1,sealed.ciphertext,sealed.keyId);
  }
  let qrCount=0,scanCount=0,updateCount=0;
  let updates:unknown[]=[];
  let status='confirmed';
  const client:PairClient={
    getQr:async()=>{qrCount++;return {qrcode:'qr-not-public',
      qrcode_img_content:'https://liteapp.weixin.qq.com/example-qr?token=private'};},
    pollQr:async(_qrcode,code)=>{scanCount++;return {
      status:code==='0000'?'need_verifycode':status,
      bot_token:'new-secret-token',ilink_user_id:'verified-owner',
      ilink_bot_id:'verified-bot'
    };},
    getUpdates:async(_token,cursor)=>{updateCount++;return {
      msgs:updates,
      get_updates_buf:'opaque-cursor-'+updateCount+'-'+cursor.length
    };}
  };
  return {db,env,existing,client,
    add:(msg:unknown)=>{updates.push(msg);},
    clear:()=>{updates=[];},
    status:(value:string)=>{status=value;},
    counts:()=>({qrCount,scanCount,updateCount})};
}
async function stage(f:Awaited<ReturnType<typeof fixture>>){
  await startPairing(f.env,OWNER,f.client);
  assert.equal((await pairingView(f.env,OWNER)).phase,'qr_pending');
  if((await bindingStatus(f.env)).binding_state!=='ready')
    assert.equal((await bindingStatus(f.env)).binding_state,'qr_pending');
  assert.equal(await pollPairing(f.env,OWNER,f.client),'confirmed');
  const view=await pairingView(f.env,OWNER);
  assert.equal(view.phase,'bound_unverified');
  assert.match(view.proof??'',/^WX346-[A-F0-9]{24}$/);
  return view.proof!;
}
function proofMessage(proof:string,user='verified-owner'){
  return {from_user_id:user,to_user_id:'verified-bot',message_type:1,
    context_token:'verified-context',
    item_list:[{type:1,text_item:{text:proof}}]};
}
test('owner QR is encrypted, short-lived and tied to one Access identity',async()=>{
  const f=await fixture();
  await startPairing(f.env,OWNER,f.client);
  const row=f.db.sql.prepare('SELECT * FROM weixin_pairing').get()!;
  assert.equal(row.phase,'qr_pending');
  assert.equal(row.generation,0);
  assert.ok(Number(row.expires_at)-Math.floor(Date.now()/1000)<=600);
  assert.doesNotMatch(JSON.stringify(row),/liteapp|qr-not-public|secret|access-sub/);
  await assert.rejects(()=>pairingView(f.env,OTHER),/pairing_owner_changed/);
  await assert.rejects(()=>pollPairing(f.env,OTHER,f.client),/pairing_owner_changed/);
  f.db.sql.prepare('UPDATE weixin_pairing SET expires_at=1').run();
  await assert.rejects(()=>pollPairing(f.env,OWNER,f.client),/pairing_expired/);
  assert.equal(f.counts().scanCount,0);
});
test('scan confirmation never replaces active account without exact inbound proof',async()=>{
  const f=await fixture(true);
  const before=f.db.sql.prepare('SELECT session_ciphertext FROM weixin_binding').get()?.session_ciphertext;
  const proof=await stage(f);
  assert.equal(f.db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,1);
  f.add(proofMessage(proof,'attacker'));
  assert.equal(await verifyPairing(f.env,OWNER,f.client),'waiting_for_proof');
  assert.equal(f.db.sql.prepare('SELECT session_ciphertext FROM weixin_binding').get()?.session_ciphertext,before);
  f.clear();
  f.add(proofMessage(proof));
  // Poll throttle is short-lived and enforced in D1 even across invocations.
  await assert.rejects(()=>verifyPairing(f.env,OWNER,f.client),/pairing_poll_throttled/);
  f.db.sql.prepare('UPDATE weixin_pairing SET poll_after=0').run();
  assert.equal(await verifyPairing(f.env,OWNER,f.client),'ready');
  const active=f.db.sql.prepare('SELECT * FROM weixin_binding').get()!;
  assert.equal(active.generation,2);
  assert.equal(active.state,'ready');
  assert.notEqual(active.session_ciphertext,before);
  const session=await decrypt<IlinkSession>(f.env,'weixin:owner:binding:2',
    active.session_ciphertext as string,active.session_key_id as string);
  assert.deepEqual(session,{botToken:'new-secret-token',ownerId:'verified-owner',
    botId:'verified-bot',contextToken:'verified-context',
    cursor:'opaque-cursor-2-17'});
  assert.doesNotMatch(JSON.stringify(active),/verified-context|new-secret-token/);
  const pair=f.db.sql.prepare('SELECT * FROM weixin_pairing').get()!;
  assert.equal(pair.phase,'expired');
  assert.equal(pair.ciphertext,null);
  await assert.rejects(()=>verifyPairing(f.env,OWNER,f.client),/pairing_not_confirmed/);
});
test('QR issuance and verification share the same D1 lease as send and unbind',async()=>{
  const f=await fixture(true);
  const lease=await acquireLease(f.env,1,['ready']);
  await assert.rejects(()=>startPairing(f.env,OWNER,f.client),/binding_busy_or_changed/);
  assert.equal(f.counts().qrCount,0);
  await releaseLease(f.env,lease);
  const proof=await stage(f);
  f.add(proofMessage(proof));
  const during=await acquireLease(f.env,1,['ready']);
  await assert.rejects(()=>verifyPairing(f.env,OWNER,f.client),/binding_busy_or_changed/);
  await assert.rejects(()=>unbindLocal(f.env),/binding_busy/);
  await releaseLease(f.env,during);
  assert.equal(await verifyPairing(f.env,OWNER,f.client),'ready');
  assert.equal((await sendOnce(f.env,'safe text',ID,async()=> 'accepted')).status,'accepted');
});
test('stale confirmation after unbind cannot reactivate or overwrite account',async()=>{
  const f=await fixture();
  const proof=await stage(f);
  f.add(proofMessage(proof));
  assert.equal(await unbindLocal(f.env),1);
  await assert.rejects(()=>verifyPairing(f.env,OWNER,f.client),/pairing_expired/);
  assert.equal(f.db.sql.prepare('SELECT state FROM weixin_binding').get()?.state,'unbound');
  assert.equal(f.counts().updateCount,0);
});
test('QR attempts, verify codes and pending scans are bounded',async()=>{
  const f=await fixture();
  await startPairing(f.env,OWNER,f.client);
  f.status('need_verifycode');
  assert.equal(await pollPairing(f.env,OWNER,f.client),'need_verifycode');
  await assert.rejects(()=>pollPairing(f.env,OWNER,f.client),/pairing_poll_throttled/);
  for(let i=0;i<3;i++){
    f.db.sql.prepare('UPDATE weixin_pairing SET poll_after=0').run();
    assert.equal(await pollPairing(f.env,OWNER,f.client,'0000'),'need_verifycode');
  }
  f.db.sql.prepare('UPDATE weixin_pairing SET poll_after=0').run();
  await assert.rejects(()=>pollPairing(f.env,OWNER,f.client,'1234'),/verify_code_blocked/);
  for(let i=1;i<5;i++)await startPairing(f.env,OWNER,f.client);
  await assert.rejects(()=>startPairing(f.env,OWNER,f.client),/pairing_rate_limited/);
  assert.equal(f.counts().qrCount,5);
});
test('unsupported QR redirect states fail closed without a new credential',async()=>{
  const f=await fixture();
  await startPairing(f.env,OWNER,f.client);
  f.status('binded_redirect');
  assert.equal(await pollPairing(f.env,OWNER,f.client),'expired');
  assert.equal((await pairingView(f.env,OWNER)).phase,'none');
  assert.equal(f.db.sql.prepare('SELECT state FROM weixin_binding').get()?.state,'unbound');
});

test('expired QR poll lease does not commit a late scan confirmation',async()=>{
  const f=await fixture();
  await startPairing(f.env,OWNER,f.client);
  let start!:()=>void,complete!:(value:{status:string;bot_token:string;
    ilink_bot_id:string;ilink_user_id:string})=>void;
  const called=new Promise<void>(r=>{start=r;});
  const gate=new Promise<{status:string;bot_token:string;ilink_bot_id:string;
    ilink_user_id:string}>(r=>{complete=r;});
  const slow={...f.client,pollQr:async()=>{start();return gate;}};
  const request=pollPairing(f.env,OWNER,slow);
  await called;
  f.db.sql.prepare('UPDATE weixin_binding SET lease_until=1').run();
  complete({status:'confirmed',bot_token:'old-token',ilink_bot_id:'bot',ilink_user_id:'owner'});
  await assert.rejects(request,/pairing_changed/);
  assert.equal((await pairingView(f.env,OWNER)).phase,'qr_pending');
  assert.equal(f.db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,0);
  assert.equal(f.db.sql.prepare('SELECT phase FROM weixin_pairing').get()?.phase,'qr_pending');
});
test('expired proof-verification lease cannot activate a late inbound reply',async()=>{
  const f=await fixture();
  const proof=await stage(f);
  let start!:()=>void,complete!:(value:{msgs:unknown[];get_updates_buf:string})=>void;
  const called=new Promise<void>(r=>{start=r;});
  const gate=new Promise<{msgs:unknown[];get_updates_buf:string}>(r=>{complete=r;});
  const slow={...f.client,getUpdates:async()=>{start();return gate;}};
  const request=verifyPairing(f.env,OWNER,slow);
  await called;
  f.db.sql.prepare('UPDATE weixin_binding SET lease_until=1').run();
  complete({msgs:[proofMessage(proof)],get_updates_buf:'late-cursor'});
  await assert.rejects(request,/binding_changed/);
  assert.equal(f.db.sql.prepare('SELECT state FROM weixin_binding').get()?.state,'unbound');
  assert.equal((await pairingView(f.env,OWNER)).phase,'bound_unverified');
  assert.equal(f.db.sql.prepare('SELECT session_ciphertext FROM weixin_binding').get()?.session_ciphertext,null);
});

test('failed upstream verify-code requests consume durable budget before provider returns',async()=>{
  const f=await fixture();
  await startPairing(f.env,OWNER,f.client);
  let attempted=0;
  const bad={...f.client,pollQr:async()=>{attempted++;throw Error('upstream unavailable');}};
  for(let i=0;i<3;i++){
    f.db.sql.prepare('UPDATE weixin_pairing SET poll_after=0').run();
    await assert.rejects(()=>pollPairing(f.env,OWNER,bad,'1234'),/upstream unavailable/);
    assert.equal(f.db.sql.prepare('SELECT verify_count FROM weixin_pairing').get()?.verify_count,i+1);
  }
  f.db.sql.prepare('UPDATE weixin_pairing SET poll_after=0').run();
  await assert.rejects(()=>pollPairing(f.env,OWNER,bad,'1234'),/verify_code_blocked/);
  assert.equal(attempted,3);
});

test('superseded QR proof cannot activate after newer QR request takes same generation lease',async()=>{
  const f=await fixture(true);
  const oldProof=await stage(f);
  // All QR sessions before activation share the same active binding generation.
  assert.equal(f.db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,1);
  f.add(proofMessage(oldProof));
  await startPairing(f.env,OWNER,f.client);
  // The stale proof was valid for the old QR but not for this replacement.
  await assert.rejects(()=>verifyPairing(f.env,OWNER,f.client),/pairing_not_confirmed/);
  assert.equal(f.db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,1);
  assert.equal(f.db.sql.prepare('SELECT state FROM weixin_binding').get()?.state,'ready');
  assert.equal((await pairingView(f.env,OWNER)).phase,'qr_pending');
  assert.equal(await pollPairing(f.env,OWNER,f.client),'confirmed');
  f.clear();
  const newProof=(await pairingView(f.env,OWNER)).proof!;
  assert.notEqual(newProof,oldProof);
  f.add(proofMessage(newProof));
  assert.equal(await verifyPairing(f.env,OWNER,f.client),'ready');
  assert.equal(f.db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,2);
});
test('replaced QR between verification read and lease admission fails closed',async()=>{
  const f=await fixture();
  const proof=await stage(f);
  f.add(proofMessage(proof));
  // Prove the exact row check independently: after a new session exists, an
  // invocation using the old session cannot activate it or modify its cursor.
  const stale=f.db.sql.prepare('SELECT session_id FROM weixin_pairing').get()?.session_id;
  await startPairing(f.env,OWNER,f.client);
  assert.notEqual(f.db.sql.prepare('SELECT session_id FROM weixin_pairing').get()?.session_id,stale);
  await assert.rejects(()=>verifyPairing(f.env,OWNER,f.client),/pairing_not_confirmed/);
  assert.equal(f.db.sql.prepare('SELECT generation FROM weixin_binding').get()?.generation,0);
});
