import {decrypt,encrypt,nonce,sha256} from './crypto.ts';
import {acquireLease,readUnderLease,releaseLease} from './lease.ts';
import {fail} from './types.ts';
import type {Binding,Env,IlinkSession} from './types.ts';
// @ts-ignore: isolated reviewed JavaScript protocol seam is also exercised by the PoC tests.
import {bindVerifiedContext,createIlinkClient,createOwnershipProof} from '../poc/protocol.mjs';

const TTL=600;
const MAX_ATTEMPTS=5;
type Phase='issuing'|'qr_pending'|'bound_unverified'|'expired';
type PairRow={
  id:number;generation:number;owner_digest:string;phase:Phase;session_id:string;
  ciphertext:string|null;key_id:string|null;expires_at:number;poll_after:number;
  verify_count:number;window_start:number;attempt_count:number;
};
type PairSecret={
  qrcode?:string;qrUrl?:string;proof?:string;
  botToken?:string;botId?:string;ownerId?:string;cursor?:string;
};
export type PairClient={
  getQr:()=>Promise<{qrcode:string;qrcode_img_content:string}>;
  pollQr:(qrcode:string,verifyCode?:string)=>Promise<{
    status:string;bot_token?:string;ilink_bot_id?:string;ilink_user_id?:string;
  }>;
  getUpdates:(botToken:string,cursor:string)=>Promise<{msgs:unknown[];get_updates_buf:string}>;
};
export const livePairClient=():PairClient=>createIlinkClient() as PairClient;
const now=()=>Math.floor(Date.now()/1000);
const aad=(row:Pick<PairRow,'generation'|'session_id'>)=>
  'weixin:owner:pairing:'+row.generation+':'+row.session_id;
async function ownerDigest(sub:string):Promise<string>{
  if(!sub||sub.length>1024)fail('unauthorized');
  return sha256('weixin:owner:'+sub);
}
async function rowForOwner(env:Env,sub:string):Promise<PairRow|null>{
  const row=await env.DB.prepare('SELECT * FROM weixin_pairing WHERE id=1').first<PairRow>();
  if(row && row.owner_digest!==await ownerDigest(sub))fail('pairing_owner_changed');
  return row;
}
async function secret(env:Env,row:PairRow):Promise<PairSecret>{
  if(!row.ciphertext||!row.key_id)fail('pairing_invalid');
  return decrypt<PairSecret>(env,aad(row),row.ciphertext,row.key_id);
}
async function current(env:Env,row:PairRow):Promise<void>{
  const binding=await env.DB.prepare('SELECT generation FROM weixin_binding WHERE id=1')
    .first<Pick<Binding,'generation'>>();
  if(!binding||binding.generation!==row.generation||row.expires_at<=now())
    fail('pairing_expired');
}
export async function pairingView(env:Env,sub:string):Promise<
  {phase:'none'|'qr_pending'|'bound_unverified'|'expired';qrUrl?:string;proof?:string}
>{
  const row=await rowForOwner(env,sub);
  if(!row||row.phase==='expired'||row.phase==='issuing')return {phase:'none'};
  try{await current(env,row);}catch{return {phase:'expired'};}
  const value=await secret(env,row);
  if(row.phase==='qr_pending')return {phase:'qr_pending',qrUrl:value.qrUrl};
  return {phase:'bound_unverified',proof:value.proof};
}
export async function startPairing(env:Env,sub:string,client:PairClient):Promise<void>{
  const binding=await env.DB.prepare('SELECT * FROM weixin_binding WHERE id=1').first<Binding>();
  if(!binding)fail('binding_missing');
  const lease=await acquireLease(env,binding.generation,[binding.state]);
  try{
    await readUnderLease(env,lease);
    const before=await rowForOwner(env,sub);
    const t=now();
    const count=before&&t-before.window_start<3600?before.attempt_count:0;
    if(count>=MAX_ATTEMPTS)fail('pairing_rate_limited');
    const sessionId=nonce(),digest=await ownerDigest(sub);
    // Reserve and invalidate any older QR BEFORE an upstream call. All binding
    // operations, including starting a QR, share the send/sync/unbind lease.
    await env.DB.prepare(
      "INSERT INTO weixin_pairing(id,generation,owner_digest,phase,session_id,ciphertext,key_id,"+
      "expires_at,poll_after,verify_count,window_start,attempt_count) "+
      "VALUES(1,?,?,'issuing',?,NULL,NULL,?,0,0,?,?) "+
      "ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,"+
      "owner_digest=excluded.owner_digest,phase=excluded.phase,session_id=excluded.session_id,"+
      "ciphertext=NULL,key_id=NULL,expires_at=excluded.expires_at,poll_after=0,verify_count=0,"+
      "window_start=excluded.window_start,attempt_count=excluded.attempt_count"
    ).bind(binding.generation,digest,sessionId,t+TTL,
      count===0?t:before!.window_start,count+1).run();
    const qr=await client.getQr();
    // The protocol seam enforces the exact approved Tencent QR destination.
    const saved=await encrypt(env,'weixin:owner:pairing:'+binding.generation+':'+sessionId,
      {qrcode:qr.qrcode,qrUrl:qr.qrcode_img_content});
    const written=await env.DB.prepare(
      "UPDATE weixin_pairing SET phase='qr_pending',ciphertext=?,key_id=? "+
      "WHERE id=1 AND phase='issuing' AND generation=? AND session_id=? AND expires_at>?"
    ).bind(saved.ciphertext,saved.keyId,binding.generation,sessionId,now()).run();
    if(written.meta.changes!==1)fail('pairing_expired');
    await readUnderLease(env,lease);
  }finally{await releaseLease(env,lease);}
}
export async function pollPairing(
  env:Env,sub:string,client:PairClient,verifyCode?:string
):Promise<'wait'|'scaned'|'need_verifycode'|'confirmed'|'expired'>{
  const row=await rowForOwner(env,sub);
  if(!row||row.phase!=='qr_pending')fail('pairing_not_pending');
  await current(env,row);
  if(row.poll_after>now())fail('pairing_poll_throttled');
  if(verifyCode!==undefined && !/^[0-9]{4,8}$/.test(verifyCode))fail('invalid_verify_code');
  if(verifyCode!==undefined&&row.verify_count>=3)fail('verify_code_blocked');
  const lease=await acquireLease(env,row.generation,
    ['unbound','ready','bound_unverified','needs_interaction','reauth_required','temporarily_unavailable']);
  try{
    await readUnderLease(env,lease);
    const value=await secret(env,row);
    if(!value.qrcode)fail('pairing_invalid');
    const scan=await client.pollQr(value.qrcode,verifyCode);
    await current(env,row);
    const t=now();
    if(['expired','verify_code_blocked','binded_redirect'].includes(scan.status)){
      await env.DB.prepare(
        "UPDATE weixin_pairing SET phase='expired',ciphertext=NULL,key_id=NULL "+
        "WHERE id=1 AND generation=? AND session_id=? AND phase='qr_pending'"
      ).bind(row.generation,row.session_id).run();
      return 'expired';
    }
    if(scan.status==='confirmed'){
      if(!scan.bot_token||!scan.ilink_bot_id||!scan.ilink_user_id)fail('pairing_invalid');
      const sealed=await encrypt(env,aad(row),{
        botToken:scan.bot_token,botId:scan.ilink_bot_id,ownerId:scan.ilink_user_id,
        cursor:'',proof:createOwnershipProof()
      } satisfies PairSecret);
      const changed=await env.DB.prepare(
        "UPDATE weixin_pairing SET phase='bound_unverified',ciphertext=?,key_id=?,poll_after=? "+
        "WHERE id=1 AND generation=? AND session_id=? AND phase='qr_pending' AND expires_at>?"
      ).bind(sealed.ciphertext,sealed.keyId,0,row.generation,row.session_id,t).run();
      if(changed.meta.changes!==1)fail('pairing_changed');
      return 'confirmed';
    }
    if(!['wait','scaned','need_verifycode'].includes(scan.status))fail('pairing_unsupported');
    const changed=await env.DB.prepare(
      "UPDATE weixin_pairing SET poll_after=?,verify_count=verify_count+? "+
      "WHERE id=1 AND generation=? AND session_id=? AND phase='qr_pending' AND expires_at>?"
    ).bind(t+4,verifyCode===undefined?0:1,row.generation,row.session_id,t).run();
    if(changed.meta.changes!==1)fail('pairing_changed');
    return scan.status as 'wait'|'scaned'|'need_verifycode';
  }finally{await releaseLease(env,lease);}
}
export async function verifyPairing(
  env:Env,sub:string,client:PairClient
):Promise<'waiting_for_proof'|'ready'>{
  const row=await rowForOwner(env,sub);
  if(!row||row.phase!=='bound_unverified')fail('pairing_not_confirmed');
  await current(env,row);
  if(row.poll_after>now())fail('pairing_poll_throttled');
  const lease=await acquireLease(env,row.generation,
    ['unbound','ready','bound_unverified','needs_interaction','reauth_required','temporarily_unavailable']);
  try{
    const binding=await readUnderLease(env,lease);
    const value=await secret(env,row);
    if(!value.botToken||!value.botId||!value.ownerId||!value.proof||
       typeof value.cursor!=='string')fail('pairing_invalid');
    const updates=await client.getUpdates(value.botToken,value.cursor);
    if(!Array.isArray(updates.msgs)||updates.msgs.length>100||
       typeof updates.get_updates_buf!=='string'||updates.get_updates_buf.length>4096)
      fail('pairing_invalid');
    await current(env,row);
    let verified:{recipientId:string;contextToken:string}|null=null;
    try{
      verified=bindVerifiedContext(
        {status:'confirmed',ilink_user_id:value.ownerId},updates,value.botId,value.proof
      ) as {recipientId:string;contextToken:string};
    }catch(err){
      if((err as {code?:string})?.code!=='IDENTITY_UNVERIFIED')throw err;
    }
    if(!verified){
      // Consume the returned cursor even when no proof was present, so subsequent
      // polls progress monotonically; never retain unrelated inbound bodies.
      const encrypted=await encrypt(env,aad(row),{...value,cursor:updates.get_updates_buf});
      const saved=await env.DB.prepare(
        "UPDATE weixin_pairing SET ciphertext=?,key_id=?,poll_after=? "+
        "WHERE id=1 AND generation=? AND session_id=? AND phase='bound_unverified' AND expires_at>?"
      ).bind(encrypted.ciphertext,encrypted.keyId,now()+3,row.generation,row.session_id,now()).run();
      if(saved.meta.changes!==1)fail('pairing_changed');
      return 'waiting_for_proof';
    }
    const next=row.generation+1;
    const session:IlinkSession={botToken:value.botToken,botId:value.botId,
      ownerId:verified.recipientId,contextToken:verified.contextToken,
      cursor:updates.get_updates_buf};
    const encrypted=await encrypt(env,'weixin:owner:binding:'+next,session);
    const saved=await env.DB.prepare(
      "UPDATE weixin_binding SET generation=?,state='ready',session_ciphertext=?,"+
      "session_key_id=?,last_verified_context_at=?,last_sync_at=?,updated_at=?,"+
      "lease_holder=NULL,lease_until=NULL "+
      "WHERE id=1 AND generation=? AND state=? AND lease_holder=? AND lease_until>? "+
      "AND (session_ciphertext IS ? OR session_ciphertext=?)"
    ).bind(next,encrypted.ciphertext,encrypted.keyId,now(),now(),now(),
      row.generation,binding.state,lease.owner,now(),binding.session_ciphertext,
      binding.session_ciphertext).run();
    if(saved.meta.changes!==1)fail('binding_changed');
    // If this cleanup fails, the generation fence still makes the old QR inert.
    await env.DB.prepare("UPDATE weixin_pairing SET phase='expired',ciphertext=NULL,key_id=NULL "+
      "WHERE id=1 AND generation=? AND session_id=?"
    ).bind(row.generation,row.session_id).run().catch(()=>{});
    return 'ready';
  }finally{await releaseLease(env,lease);}
}
