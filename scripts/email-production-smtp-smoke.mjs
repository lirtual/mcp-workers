// Owner-authorized single QQ self-send. Run only via manually confirmed main-only
// Email Acceptance. Never print mailbox addresses, IDs, messages or raw responses.
import assert from 'node:assert/strict';

let stage='preflight';
const runId=process.env.GITHUB_RUN_ID;
assert.equal(process.env.GITHUB_REPOSITORY,'lirtual/mcp-workers','smtp_smoke_wrong_repository');
assert.equal(process.env.GITHUB_REF,'refs/heads/main','smtp_smoke_untrusted_ref');
assert.equal(process.env.EMAIL_SEND_CONFIRM,'true','smtp_smoke_approval_missing');
assert.match(runId??'',/^[0-9]{6,20}$/,'smtp_smoke_run_id_invalid');
const token=process.env.MCP_ACCESS_TOKEN;
assert.ok(typeof token==='string'&&token.length>0&&!/[\r\n]/.test(token),
  'smtp_smoke_token_missing');
const endpoint='https://email-mcp.lirtual.dpdns.org/mcp';

// Fixed, non-sensitive payload. Re-runs of the same GitHub workflow run use
// the same request_id; never append run_attempt or generate another ID.
const requestId='email-selftest-'+runId;
const subject='MCP SMTP self-send acceptance';
const body='One-time owner-approved SMTP self-send test. No reply is needed.';

async function call(tool,args={}){
  stage=tool+'_request';
  const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}};
  let response;
  try{
    response=await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(30000),
      headers:{authorization:'Bearer '+token,'content-type':'application/json',
        accept:'application/json, text/event-stream'},body:JSON.stringify(request)});
  }catch{throw Error('smtp_smoke_transport_unknown');}
  assert.equal(response.status,200,'smtp_smoke_rpc_transport_denied');
  let raw;
  try{raw=await response.text();}catch{throw Error('smtp_smoke_rpc_body_unavailable');}
  assert.ok(raw.length<65536,'smtp_smoke_response_oversize');
  let envelope;
  try{envelope=JSON.parse(raw.match(/^data: (.+)$/m)?.[1]??raw);}
  catch{throw Error('smtp_smoke_invalid_rpc_json');}
  assert.equal(envelope.jsonrpc,'2.0','smtp_smoke_invalid_rpc');
  assert.ok(Array.isArray(envelope.result?.content)&&
    envelope.result.content.length===1,'smtp_smoke_invalid_content');
  let value;
  try{value=JSON.parse(envelope.result.content[0].text);}
  catch{throw Error('smtp_smoke_invalid_tool_json');}
  // Indeterminate is a *typed outcome*, intentionally surfaced as MCP isError.
  if(envelope.result.isError&&!(tool==='mail_send'&&value?.status==='indeterminate'))
    throw Error('smtp_smoke_'+tool+'_error');
  return value;
}

async function main(){
  const accounts=await call('account_list');
  stage='account_selection';
  assert.ok(Array.isArray(accounts),'smtp_smoke_account_list_invalid');
  const qq=accounts.filter(a=>a.provider==='imap_smtp'&&a.status==='active'&&
    typeof a.address==='string'&&/^[^\s@]+@qq\.com$/i.test(a.address)&&
    /^[0-9a-f-]{36}$/i.test(a.account_id??''));
  assert.equal(qq.length,1,'smtp_smoke_ambiguous_qq_account');
  const account=qq[0];
  const params={account_id:account.account_id,request_id:requestId,
    to:[account.address],subject,body};
  // Only one new message can be submitted. The second request is deliberately
  // identical, protected by the durable D1 fence and must report duplicate.
  const first=await call('mail_send',params);
  stage='initial_send_result';
  assert.equal(first.account_id,account.account_id,'smtp_smoke_account_mismatch');
  assert.equal(first.request_id,requestId,'smtp_smoke_request_mismatch');
  assert.ok(first.status==='accepted'||first.status==='indeterminate',
    'smtp_smoke_initial_send_not_accepted');
  if(first.duplicate===true){
    // A workflow rerun must not falsely claim that a new send was executed.
    console.log('SMTP_PRODUCTION_SELF_SEND_EXISTING_REQUEST');
    assert.fail('smtp_smoke_already_attempted');
  }
  assert.equal(first.duplicate,false,'smtp_smoke_initial_duplicate_state');
  console.log(first.status==='accepted'?'SMTP_PRODUCTION_SELF_SEND_ACCEPTED':
    'SMTP_PRODUCTION_SELF_SEND_INDETERMINATE');

  // Same request_id, account and full payload. Never retry with a fresh key.
  const again=await call('mail_send',params);
  stage='dedupe_result';
  assert.equal(again.account_id,account.account_id,'smtp_smoke_replay_account_mismatch');
  assert.equal(again.request_id,requestId,'smtp_smoke_replay_id_mismatch');
  assert.equal(again.duplicate,true,'smtp_smoke_duplicate_not_fenced');
  assert.equal(again.status,first.status,'smtp_smoke_duplicate_status_drift');
  if(first.status==='accepted'&&first.reference!=null)
    assert.equal(again.reference,first.reference,'smtp_smoke_reference_mismatch');
  console.log('SMTP_PRODUCTION_REPLAY_FENCED_OK');
  assert.equal(first.status,'accepted','smtp_smoke_outcome_indeterminate');
  console.log('SMTP_PRODUCTION_SELF_SEND_ACCEPTANCE_OK');
}
main().catch(error=>{
  const message=String(error?.message??'').split('\n',1)[0];
  const safe=/^smtp_smoke_[a-z0-9_]+$/.test(message);
  console.error(safe?message:'smtp_smoke_stage_'+stage+'_failed');
  process.exitCode=1;
});
