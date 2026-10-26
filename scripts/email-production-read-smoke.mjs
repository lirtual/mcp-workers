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
    assert.equal(search.partial_failure,false,'email_smoke_imap_search_failed');
    assert.equal(search.accounts?.[0]?.status,'success','email_smoke_imap_search_status');
    assert.deepEqual(search.messages,[],'email_smoke_unexpected_search_hit');
  }
  // No mail_get, attachment_get, read-flag change, draft or send is performed.
  console.log('EMAIL_PRODUCTION_IMAP_READONLY_ACCEPTANCE_OK active_sample='+Math.min(active.length,3));
}
main().catch(error=>{
  const raw=String(error?.message??'');
  const safe=/^email_smoke_[a-z0-9_]+$/.test(raw);
  const diagnostic=safe?raw:('email_smoke_stage_'+stage+'_failed_'+
    (error instanceof SyntaxError?'syntax':error instanceof TypeError?'type':'other'));
  console.error(diagnostic);
  process.exitCode=1;
});
