// The ONLY executable capability in this disposable independent S3 Job is
// fixed, side-effect-free "echo". Its GitHub OIDC JWT never enters logs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const env=k=>{const v=process.env[k];assert.ok(v,'missing '+k);return v};
const name=env('S3_WORKER_NAME');
const attemptId=env('S3_ATTEMPT_ID');
const dispatchId=env('S3_DISPATCH_ID');
const capability=env('S3_CAPABILITY');
assert.match(name,/^workflow-s3-(?:oidc|plan)-[a-f0-9]{10}$/);
const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
assert.match(attemptId,uuid);
assert.match(dispatchId,uuid);
assert.equal(capability,'heavy.github.echo');
assert.equal(env('GITHUB_REPOSITORY'),'lirtual/mcp-workers');
assert.equal(env('GITHUB_EVENT_NAME'),'workflow_dispatch');
assert.equal(env('GITHUB_REF'),'refs/heads/wip/workflow-s3-github-executor');
assert.equal(env('GITHUB_WORKFLOW_REF'),
  'lirtual/mcp-workers/.github/workflows/ci.yml@refs/heads/wip/workflow-s3-github-executor');
assert.equal(env('GITHUB_RUN_ATTEMPT'),'1');
const oidcURL=new URL(env('ACTIONS_ID_TOKEN_REQUEST_URL'));
oidcURL.searchParams.set('audience','workflow-s3-claim:test');
const oidc=await fetch(oidcURL,{headers:{
  authorization:'Bearer '+env('ACTIONS_ID_TOKEN_REQUEST_TOKEN'),
},signal:AbortSignal.timeout(15000)});
assert.equal(oidc.status,200,'GitHub OIDC issuance');
const jwt=(await oidc.json()).value;
assert.ok(jwt?.length>150,'Missing signed GitHub identity');
const product=name.startsWith('workflow-s3-plan-');
const base='https://'+name+'.aiyaya.workers.dev';
const ingress=product?'/s3':'';
const post=async(path,body)=>{
  const response=await fetch(base+ingress+path,{method:'POST',
    headers:{authorization:'Bearer '+jwt,'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(14000)});
  return response.status;
};
// A separate GitHub Job can start before the coordinator has durably stored
// GitHub's REST dispatch confirmation. Wait, never self-authorize.
let claimed=false;
for(let i=0;i<65;i++){
  const code=await post('/claim',{attemptId});
  if(code===200){claimed=true;break;}
  if(code!==403)throw Error('S3 claim unexpected HTTP '+code);
  await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.ok(claimed,'Claim never authorized by confirmed dispatch');
if(!product)assert.equal(await post('/start',{attemptId}),202,'Native Workflow start');
const callbackId=randomUUID();
const fact={attemptId,callbackId,outcome:'succeeded',
  result:{echo:'ok',source:'separate-github-workflow-dispatch'}};
assert.equal(await post('/callback',fact),200,'Durable callback + notification');
console.log('S3_INDEPENDENT_GITHUB_JOB_CALLBACK_OK');
