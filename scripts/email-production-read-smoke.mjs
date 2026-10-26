// Read-only production IMAP acceptance, run inside the selected Worker release.
// Never print mailbox address, credentials, headers, subjects or server output.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const url='https://email-mcp.lirtual.dpdns.org/mcp';
const token=process.env.MCP_ACCESS_TOKEN;
let stage='init';
assert.ok(typeof token==='string'&&token.length>0&&!/[\r\n]/.test(token),'email_smoke_token_missing');

async function call(name,args={}){
  stage=name+'_request';
  const request={jsonrpc:'2.0',id:1,method:'tools/call',
    params:{name,arguments:args}};
  let res;
  try {
    res=await fetch(url,{method:'POST',signal:AbortSignal.timeout(30000),
      headers:{authorization:'Bearer '+token,'content-type':'application/json',
        accept:'application/json, text/event-stream'},body:JSON.stringify(request)});
  } catch { throw Error('email_smoke_fetch_unavailable'); }
  assert.equal(res.status,200,'email_smoke_transport_denied');
  let raw;
  try { raw=await res.text(); }
  catch { throw Error('email_smoke_body_unavailable'); }
  assert.ok(raw.length<1024*1024,'email_smoke_response_too_large');
  let document;
  try { document=JSON.parse(raw.match(/^data: (.+)$/m)?.[1]??raw); }
  catch { throw Error('email_smoke_rpc_invalid_json'); }
  assert.equal(document.jsonrpc,'2.0','email_smoke_bad_rpc');
  stage=name+'_response';
  const result=document.result;
  assert.ok(result&&Array.isArray(result.content),'email_smoke_bad_result');
  if(result.isError){
    // The MCP returns only a stable error code; do not forward arbitrary content.
    let code='unknown';
    try{
      const parsed=JSON.parse(result.content[0]?.text||'{}');
      if(/^[a-z_]{1,48}$/.test(parsed.error??''))code=parsed.error;
    }catch{}
    throw Error('email_smoke_'+name+'_failed_'+code);
  }
  assert.equal(result.content.length,1,'email_smoke_unexpected_content');
  try { return JSON.parse(result.content[0].text); }
  catch { throw Error('email_smoke_tool_result_bad_json'); }
}

// Opt-in production acceptance. Never print any mailbox-derived values.
// Default release smoke remains metadata-only; this deeper check is manual.
async function deepReadAcceptance(account){
  const aid=account.account_id;
  const broad=await call('mail_search',{account_ids:[aid],query:'@'});
  stage='positive_discovery';
  assert.equal(broad.partial_failure,false,'email_smoke_positive_discovery_failed');
  assert.equal(broad.accounts?.[0]?.status,'success','email_smoke_positive_discovery_status');
  assert.ok(['envelope','full_text'].includes(broad.accounts?.[0]?.search_scope),
    'email_smoke_positive_search_scope');
  assert.ok(Array.isArray(broad.messages),'email_smoke_positive_result_shape');
  // No content from unrelated mail is printed, stored in artifacts, or forwarded.
  const sample=broad.messages.find(message=>
    typeof message.from==='string'&&/^[^\s@]+@[^\s@]+$/.test(message.from)) ??
    broad.messages.find(message=>
      typeof message.to==='string'&&/^[^\s@]+@[^\s@]+$/.test(message.to));
  if(!sample){
    console.log('EMAIL_PRODUCTION_POSITIVE_SEARCH_NO_SAMPLE');
    console.log('EMAIL_PRODUCTION_MAIL_GET_NOT_TESTED');
    console.log('EMAIL_PRODUCTION_ATTACHMENT_NOT_TESTED');
    if(process.env.EMAIL_REQUIRE_ATTACHMENT==='true')
      assert.fail('email_smoke_positive_sample_missing');
    return;
  }
  const searchTerm=/^[^\s@]+@[^\s@]+$/.test(sample.from??'') ? sample.from : sample.to;
  const result=await call('mail_search',{account_ids:[aid],query:searchTerm});
  stage='positive_relevance';
  assert.equal(result.partial_failure,false,'email_smoke_positive_search_failed');
  assert.equal(result.accounts?.[0]?.status,'success','email_smoke_positive_search_status');
  assert.ok(Array.isArray(result.messages)&&result.messages.some(message=>
    message.id===sample.id&&message.account_id===aid),
    'email_smoke_positive_missing_expected_message');
  console.log('EMAIL_PRODUCTION_POSITIVE_SEARCH_OK');
  // ImapFlow fetchOne({source:true}) uses BODY.PEEK[] and must not mark read.
  // IMAP INTERNALDATE can be missing; mail_search may then re-sort a page
  // lexicographically by encoded message id, so the first results are not
  // necessarily the newest. UID is monotonic within this INBOX UIDVALIDITY.
  // Only reorder the existing bounded first search page; never widen reads.
  function inboxUid(message){
    try{
      if(typeof message.id!=='string'||!/^[A-Za-z0-9_-]{1,750}$/.test(message.id))
        return 0;
      const ref=JSON.parse(Buffer.from(message.id,'base64url').toString('utf8'));
      return ref?.folder==='INBOX'&&Number.isSafeInteger(ref.uid)&&ref.uid>0
        ? ref.uid : 0;
    }catch{return 0;}
  }
  const candidates=[...broad.messages].sort((a,b)=>inboxUid(b)-inboxUid(a)).slice(0,5);
  console.log('EMAIL_ATTACHMENT_SAMPLE_COUNTS matched='+broad.messages.length+
    ' inspected='+candidates.length+
    ' valid_uid='+candidates.filter(hit=>inboxUid(hit)>0).length);
  let gotMessage=false;
  let foundAttachment=false;
  for(const hit of candidates){
    let item;
    try {item=await call('mail_get',{account_id:aid,message_id:hit.id});}
    catch(error){
      if(error?.message==='email_smoke_mail_get_failed_result_too_large')continue;
      throw error;
    }
    stage='message_shape';
    assert.equal(item.account_id,aid,'email_smoke_mail_get_account_mismatch');
    assert.equal(item.id,hit.id,'email_smoke_mail_get_id_mismatch');
    assert.ok(typeof item.subject==='string'&&typeof item.text==='string'&&
      Array.isArray(item.attachments),'email_smoke_mail_get_invalid_shape');
    gotMessage=true;
    const attachment=item.attachments.find(part=>
      typeof part.id==='string'&&typeof part.filename==='string'&&
      /\.txt$/i.test(part.filename)&&Number.isSafeInteger(part.size)&&
      part.size>0&&part.size<=128*1024);
    if(!attachment)continue;
    const file=await call('attachment_get',{
      account_id:aid,message_id:hit.id,attachment_id:attachment.id});
    stage='attachment_shape';
    assert.equal(file.account_id,aid,'email_smoke_attachment_account_mismatch');
    assert.equal(file.message_id,hit.id,'email_smoke_attachment_message_mismatch');
    assert.equal(file.attachment_id,attachment.id,'email_smoke_attachment_id_mismatch');
    assert.ok(typeof file.data_base64==='string'&&
      file.data_base64.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(file.data_base64),
      'email_smoke_attachment_invalid_base64');
    const decoded=Buffer.from(file.data_base64,'base64');
    assert.equal(decoded.length,file.size,'email_smoke_attachment_size_mismatch');
    assert.equal(decoded.length,attachment.size,'email_smoke_attachment_metadata_mismatch');
    foundAttachment=true;
    break;
  }
  console.log(gotMessage?'EMAIL_PRODUCTION_MAIL_GET_OK':
    'EMAIL_PRODUCTION_MAIL_GET_NO_SAFE_SAMPLE');
  console.log(foundAttachment?'EMAIL_PRODUCTION_ATTACHMENT_GET_OK':
    'EMAIL_PRODUCTION_ATTACHMENT_NO_RECENT_TXT_SAMPLE');
  if(process.env.EMAIL_REQUIRE_ATTACHMENT==='true')
    assert.ok(foundAttachment,'email_smoke_attachment_not_verified');
}

async function main(){
  const accounts=await call('account_list');
  stage='accounts_shape';
  assert.ok(Array.isArray(accounts)&&accounts.length<=32,'email_smoke_bad_accounts');
  const active=accounts.filter(x=>x.status==='active'&&x.provider==='imap_smtp');
  if(active.length===0){console.log('EMAIL_PRODUCTION_NO_ACTIVE_ACCOUNT_SKIP');return;}
  // Keep this production gate bounded even if many accounts are added later.
  for(const account of active.slice(0,3)){
    assert.match(account.account_id,/^[a-f0-9-]{36}$/i,'email_smoke_bad_account_id');
    const id=account.account_id;
    const caps=await call('capabilities_get',{account_id:id});
    stage='capabilities_shape';
    assert.equal(caps.account_id,id,'email_smoke_capability_identity');
    assert.equal(caps.search,true,'email_smoke_search_capability');
    assert.equal(caps.folders,true,'email_smoke_folder_capability');
    const folders=await call('folder_list',{account_id:id});
    stage='folders_shape';
    assert.equal(folders.account_id,id,'email_smoke_folder_identity');
    assert.ok(Array.isArray(folders.folders)&&folders.folders.length>0&&
      folders.folders.length<=100,'email_smoke_folder_list_empty');
    // Cryptographically random, impossible-to-guess probe; no real message is fetched.
    const query='mcp-readonly-health-'+randomBytes(20).toString('hex');
    const search=await call('mail_search',{account_ids:[id],query});
    stage='search_shape';
    if(search.partial_failure===true || search.accounts?.[0]?.status!=='success') {
      const item=search.accounts?.[0];
      const code=typeof item?.error==='string'&&/^[a-z_]{1,48}$/.test(item.error)
        ?item.error:'none';
      const status=['success','failed','unauthorized'].includes(item?.status)?item.status:'unexpected';
      console.log('EMAIL_IMAP_SEARCH_STATUS='+status+'_ERROR='+code);
    }
    assert.equal(search.partial_failure,false,'email_smoke_imap_search_failed');
    assert.equal(search.accounts?.[0]?.status,'success','email_smoke_imap_search_status');
    assert.deepEqual(search.messages,[],'email_smoke_unexpected_search_hit');
  }
  // This remains metadata-only on every ordinary production release.
  if(process.env.EMAIL_READONLY_ACCEPTANCE==='true'){
    const qq=active.find(x=>typeof x.address==='string'&&x.address.toLowerCase().endsWith('@qq.com'));
    await deepReadAcceptance(qq??active[0]);
  }
  // No write tools, draft creation, mail sending, or flag updates.
  console.log('EMAIL_PRODUCTION_IMAP_READONLY_ACCEPTANCE_OK active_sample='+Math.min(active.length,3));
}
main().catch(error=>{
  const raw=String(error?.message??'');
  const firstLine=raw.split('\n',1)[0];
  const safe=/^email_smoke_[a-z0-9_]+$/.test(firstLine);
  const diagnostic=safe?firstLine:('email_smoke_stage_'+stage+'_failed_'+
    (error instanceof SyntaxError?'syntax':error instanceof TypeError?'type':'other'));
  console.error(diagnostic);
  process.exitCode=1;
});
