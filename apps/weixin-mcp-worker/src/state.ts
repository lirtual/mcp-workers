import { decrypt, sha256 } from './crypto.ts';
import { fail } from './types.ts';
import type { Env, Binding, IlinkSession } from './types.ts';

export type SendStatus = 'accepted'|'rejected'|'unknown';
export type SendReply = {
  request_id: string; status: SendStatus; duplicate: boolean;
  next_action: 'check_handset'|'check_handset_before_new_request'|'review_error';
};
export type Dispatcher = (session:IlinkSession,text:string,requestId:string)=>Promise<SendStatus>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
function reply(request_id:string,status:SendStatus,duplicate:boolean):SendReply {
  return {request_id,status,duplicate,next_action:status==='accepted'?'check_handset':
    status==='rejected'?'review_error':'check_handset_before_new_request'};
}
export async function bindingStatus(env:Env) {
  const row=await env.DB.prepare(
    'SELECT state,last_verified_context_at,last_sync_at FROM weixin_binding WHERE id=1'
  ).first<Pick<Binding,'state'|'last_verified_context_at'|'last_sync_at'>>();
  return {binding_state:row?.state??'unbound',last_verified_context_at:row?.last_verified_context_at??null,
    last_sync_at:row?.last_sync_at??null, next_action:row?.state==='ready'?null:'open_owner_pairing_page'};
}
export async function sendOnce(env:Env,text:string,requestId:string,dispatch:Dispatcher):Promise<SendReply>{
  if(!uuid.test(requestId??''))fail('invalid_request_id');
  if(typeof text!=='string'||!text.trim()||encoder.encode(text).byteLength>4096||
    /[\u0000-\u0008\u000B-\u001F\u007F]/.test(text))fail('invalid_text');
  const digest=await sha256(text);
  const binding=await env.DB.prepare('SELECT * FROM weixin_binding WHERE id=1').first<Binding>();
  if(!binding||binding.state!=='ready'||!binding.session_ciphertext||!binding.session_key_id)
    fail('binding_not_ready');
  const now=Math.floor(Date.now()/1000);
  // Read existing receipt first: a repeated request must remain queryable
  // even after new sends hit their daily rate limit.
  const existing=await env.DB.prepare(
    'SELECT text_digest,status FROM weixin_send_receipts WHERE generation=? AND request_id=?'
  ).bind(binding.generation,requestId).first<{text_digest:string;status:SendStatus}>();
  if(existing){
    if(existing.text_digest!==digest)fail('request_id_conflict');
    return reply(requestId,existing.status,true);
  }
  // Rate guard is advisory when two distinct IDs race. Durable uniqueness
  // is enforced by the PRIMARY KEY for every individual request ID.
  const recent=await env.DB.prepare(
    'SELECT count(*) AS n FROM weixin_send_receipts WHERE generation=? AND created_at>=?'
  ).bind(binding.generation,now-86400).first<{n:number}>();
  if((recent?.n??0)>=25)fail('rate_limited');
  // Durable, atomic claim BEFORE sending. This insert reads the current
  // binding generation in the same SQL statement (never a SELECT+INSERT pair).
  const claim=await env.DB.prepare(
    'INSERT OR IGNORE INTO weixin_send_receipts(generation,request_id,text_digest,status,created_at,updated_at) '+
    "SELECT generation,?,?, 'unknown',?,? FROM weixin_binding "+
    "WHERE id=1 AND generation=? AND state='ready' AND session_ciphertext IS NOT NULL"
  ).bind(requestId,digest,now,now,binding.generation).run();
  if(claim.meta.changes!==1){
    const previous=await env.DB.prepare(
      'SELECT text_digest,status FROM weixin_send_receipts WHERE generation=? AND request_id=?'
    ).bind(binding.generation,requestId).first<{text_digest:string;status:SendStatus}>();
    if(!previous)fail('binding_changed');
    if(previous.text_digest!==digest)fail('request_id_conflict');
    return reply(requestId,previous.status,true);
  }
  // Never decrypt credentials until the durable send reservation exists.
  // Recheck generation immediately before transport; management rebind MUST
  // also implement a cross-request fence before this becomes production-ready.
  try{
    const current=await env.DB.prepare(
      'SELECT * FROM weixin_binding WHERE id=1'
    ).first<Binding>();
    if(!current||current.generation!==binding.generation||current.state!=='ready'||
      current.session_ciphertext!==binding.session_ciphertext) return reply(requestId,'unknown',false);
    const session=await decrypt<IlinkSession>(env,'weixin:owner:binding:'+current.generation,
      current.session_ciphertext!,current.session_key_id!);
    if(!session.botToken||!session.ownerId||!session.contextToken||!session.botId)
      return reply(requestId,'unknown',false);
    const result=await dispatch(session,text,requestId);
    // A lost DB response or crash leaves the pre-claimed receipt unknown.
    if(result!=='unknown'){
      await env.DB.prepare(
        'UPDATE weixin_send_receipts SET status=?,updated_at=? '+
        "WHERE generation=? AND request_id=? AND status='unknown'"
      ).bind(result,Math.floor(Date.now()/1000),binding.generation,requestId).run();
    }
    return reply(requestId,result,false);
  }catch{
    // Once reserved, all unexpected errors are uncertain, never retry.
    return reply(requestId,'unknown',false);
  }
}
