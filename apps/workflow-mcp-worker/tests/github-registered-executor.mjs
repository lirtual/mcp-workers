// Only the fixed GitHub repository check is allowed; job inputs are opaque IDs.
// Claim before running the check. Callback uses the exact GitHub OIDC identity.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const required=name=>{const v=process.env[name];assert.ok(v,'missing '+name);return v;};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mode=process.argv[2];
assert.ok(mode==='claim'||mode==='callback','unrecognized executor phase');
const attemptId=required('WORKFLOW_ATTEMPT_ID');
const dispatchId=required('WORKFLOW_DISPATCH_ID');
assert.match(attemptId,uuid);
assert.match(dispatchId,uuid);
assert.equal(required('WORKFLOW_CAPABILITY'),'github.workflow.check');
assert.equal(required('GITHUB_REPOSITORY'),'lirtual/mcp-workers');
assert.equal(required('GITHUB_EVENT_NAME'),'workflow_dispatch');
assert.equal(required('GITHUB_RUN_ATTEMPT'),'1','GitHub reruns are not approved');
const ref=required('GITHUB_REF');
assert.equal(required('GITHUB_WORKFLOW_REF'),
  'lirtual/mcp-workers/.github/workflows/workflow-github-executor.yml@'+ref);
const origin=required('WORKFLOW_CALLBACK_ORIGIN');
const dedicatedDraftFixture=
  ref==='refs/heads/wip/workflow-github-executor' &&
  /^https:\/\/workflow-github-plan-[a-f0-9]{10}\.aiyaya\.workers\.dev$/.test(origin) &&
  process.env.WORKFLOW_EXECUTOR_AUDIENCE==='workflow-github-claim:test';
assert.ok([
  'https://workflow.lirtual.dpdns.org',
  'https://workflow-github-test.aiyaya.workers.dev',
].includes(origin)||dedicatedDraftFixture,'unregistered callback origin');
const audience=required('WORKFLOW_EXECUTOR_AUDIENCE');
assert.match(audience,/^workflow-github-[a-z0-9:-]{4,120}$/);
const oidcURL=new URL(required('ACTIONS_ID_TOKEN_REQUEST_URL'));
oidcURL.searchParams.set('audience',audience);
const signed=await fetch(oidcURL,{
  headers:{authorization:'Bearer '+required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')},
  signal:AbortSignal.timeout(15000),
});
assert.equal(signed.status,200,'GitHub OIDC issuance rejected');
const jwt=(await signed.json()).value;
assert.ok(typeof jwt==='string'&&jwt.length>150);
const post=async(path,body)=>{
  const response=await fetch(origin+'/github/'+path,{
    method:'POST',redirect:'manual',
    headers:{authorization:'Bearer '+jwt,'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(15000),
  });
  return response.status;
};
// Never claim if Cloudflare hasn't first durably stored the confirmed
// GitHub physical run_id returned by workflow_dispatch.
if(mode==='claim'){
let claimed=false;
for(let attempt=0;attempt<75;attempt++){
  const status=await post('claim',{attemptId});
  if(status===200){claimed=true;break;}
  if(status!==403)throw Error('claim_http_'+status);
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.ok(claimed,'confirmed_dispatch_not_observed');
console.log('GITHUB_REGISTERED_CLAIM_OK');
}else{
// The real CI check ran as a separate fixed GitHub Actions step. No caller
// may substitute a repository, ref, script or arbitrary result value.
const checkOutcome=required('WORKFLOW_CHECK_OUTCOME');
assert.ok(['success','failure','skipped','cancelled'].includes(checkOutcome));
const callbackId=randomUUID();
const fact={
  attemptId,callbackId,outcome:checkOutcome==='success'?'succeeded':'failed',
  result:{task:'github.workflow.check',status:checkOutcome==='success'?'passed':'failed',
    repository:'lirtual/mcp-workers',ref},
};
let accepted=false;
for(let attempt=0;attempt<4;attempt++){
  const status=await post('callback',fact);
  if(status===200){accepted=true;break;}
  if(status!==202)throw Error('callback_http_'+status);
  await new Promise(resolve=>setTimeout(resolve,1200));
}
assert.ok(accepted,'callback_notification_not_confirmed');
console.log('GITHUB_REGISTERED_CHECK_REPORTED');
}
