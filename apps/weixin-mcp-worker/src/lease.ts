import type {Binding,Env,IlinkSession} from './types.ts';
import {decrypt,encrypt} from './crypto.ts';
import {fail} from './types.ts';

// All network-bound operations on a binding use this one D1 CAS lease.
// A 12s outbound write / 40s inbound poll must terminate well inside 120s.
const LEASE_SECONDS=120;
export type Lease={owner:string;generation:number;expiresAt:number};
export async function acquireLease(env:Env,generation:number,allowed:string[]):Promise<Lease>{
  if(allowed.length<1||!allowed.every(s=>['unbound','ready','bound_unverified','needs_interaction','reauth_required','temporarily_unavailable'].includes(s)))fail('invalid_state');
  const owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000),expiresAt=now+LEASE_SECONDS;
  const placeholders=allowed.map(()=>'?').join(',');
  const result=await env.DB.prepare(
    'UPDATE weixin_binding SET lease_holder=?,lease_until=? WHERE id=1 AND generation=? '+
    'AND state IN ('+placeholders+') AND (lease_holder IS NULL OR lease_until<?)'
  ).bind(owner,expiresAt,generation,...allowed,now).run();
  if(result.meta.changes!==1)fail('binding_busy_or_changed');
  return {owner,generation,expiresAt};
}
export async function releaseLease(env:Env,lease:Lease):Promise<void>{
  await env.DB.prepare(
    'UPDATE weixin_binding SET lease_holder=NULL,lease_until=NULL '+
    'WHERE id=1 AND generation=? AND lease_holder=?'
  ).bind(lease.generation,lease.owner).run();
}
export async function readUnderLease(env:Env,lease:Lease):Promise<Binding>{
  const row=await env.DB.prepare('SELECT * FROM weixin_binding WHERE id=1').first<Binding>();
  if(!row||row.generation!==lease.generation||row.lease_holder!==lease.owner||
    (row.lease_until??0)<=Math.floor(Date.now()/1000))fail('binding_changed');
  return row;
}
export async function unbindLocal(env:Env):Promise<number>{
  const now=Math.floor(Date.now()/1000);
  // Cannot invalidate a binding while an outbound request or inbound poll
  // is active. A crashed worker's lock expires only after safety margin.
  const result=await env.DB.prepare(
    'UPDATE weixin_binding SET generation=generation+1,state=?,session_ciphertext=NULL,'+
    'session_key_id=NULL,last_verified_context_at=NULL,last_sync_at=NULL,'+
    'lease_holder=NULL,lease_until=NULL,updated_at=? '+
    'WHERE id=1 AND (lease_holder IS NULL OR lease_until<?)'
  ).bind('unbound',now,now).run();
  if(result.meta.changes!==1)fail('binding_busy');
  const row=await env.DB.prepare('SELECT generation FROM weixin_binding WHERE id=1')
    .first<{generation:number}>();
  if(!row)fail('binding_changed');
  // Old send receipts deliberately survive unbind and prevent request-ID reuse.
  return row.generation;
}
export type Poller=(session:IlinkSession)=>Promise<{msgs:unknown[];get_updates_buf:string}>;
export async function syncCursorOnce(env:Env,poll:Poller):Promise<'updated'|'unchanged'>{
  const old=await env.DB.prepare('SELECT * FROM weixin_binding WHERE id=1').first<Binding>();
  if(!old||old.state!=='ready'||!old.session_ciphertext||!old.session_key_id)
    fail('binding_not_ready');
  const lease=await acquireLease(env,old.generation,['ready']);
  try{
    const current=await readUnderLease(env,lease);
    if(current.session_ciphertext!==old.session_ciphertext)fail('binding_changed');
    const context='weixin:owner:binding:'+lease.generation;
    const session=await decrypt<IlinkSession>(env,context,old.session_ciphertext,old.session_key_id);
    const result=await poll(session);
    if(!Array.isArray(result?.msgs)||result.msgs.length>100||
      typeof result.get_updates_buf!=='string'||result.get_updates_buf.length>4096)
      fail('invalid_response');
    // Only the sync cursor is persisted; never retain incoming messages.
    if(result.get_updates_buf===session.cursor){
      const now=Math.floor(Date.now()/1000);
      const checked=await env.DB.prepare(
        'UPDATE weixin_binding SET last_sync_at=?,updated_at=? '+
        'WHERE id=1 AND generation=? AND state=? AND lease_holder=? AND lease_until>? AND session_ciphertext=?'
      ).bind(now,now,lease.generation,'ready',lease.owner,now,old.session_ciphertext).run();
      if(checked.meta.changes!==1)fail('binding_changed');
      return 'unchanged';
    }
    const next=await encrypt(env,context,{...session,cursor:result.get_updates_buf});
    const saved=await env.DB.prepare(
      'UPDATE weixin_binding SET session_ciphertext=?,session_key_id=?,last_sync_at=?,updated_at=? '+
      'WHERE id=1 AND generation=? AND state=? AND lease_holder=? AND lease_until>? AND session_ciphertext=?'
    ).bind(next.ciphertext,next.keyId,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000),
      lease.generation,'ready',lease.owner,Math.floor(Date.now()/1000),old.session_ciphertext).run();
    if(saved.meta.changes!==1)fail('binding_changed');
    return 'updated';
  }finally{await releaseLease(env,lease);}
}
