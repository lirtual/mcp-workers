/** GitHub Action manual probe, never generates an executable GitHub dispatch. */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
const need=n=>{const v=process.env[n];assert.ok(v,'missing '+n);return v;};
const token=need('GITHUB_TOKEN');
const cf=need('CLOUDFLARE_API_TOKEN');
const account=need('CLOUDFLARE_ACCOUNT_ID');
assert.equal(need('GITHUB_REPOSITORY'),'lirtual/mcp-workers');
assert.equal(need('GITHUB_REF'),'refs/heads/wip/workflow-s3-github-executor');
const suffix=randomBytes(5).toString('hex');
const name='workflow-s3-auth-'+suffix;
const access=randomBytes(24).toString('hex');
const branch='s3-auth-probe-nonexistent-'+randomBytes(12).toString('hex');
const dir=new URL('..',import.meta.url).pathname;
const configName='wrangler.s3-auth-'+suffix+'.json';
const configUrl=new URL('../'+configName,import.meta.url);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const cfRoot='https://api.cloudflare.com/client/v4/accounts/'+account;
async function cfRequest(path,method='GET'){
  const response=await fetch(cfRoot+path,{method,
    headers:{authorization:'Bearer '+cf},signal:AbortSignal.timeout(18000)});
  const doc=await response.json().catch(()=>({}));
  return {status:response.status,success:doc.success,
    errors:(doc.errors||[]).map(e=>({code:e.code})),
    result:doc.result};
}
function wr(args,secret){
  const result=spawnSync('pnpm',['exec','wrangler',...args],{
    cwd:dir,encoding:'utf8',timeout:100000,input:secret,
    env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},
  });
  if(result.status!==0){
    const lines=String(result.stderr||result.stdout||'')
      .replaceAll(cf,'[redacted]').replaceAll(token,'[redacted]')
      .split('\n').filter(x=>/error|failed|10007|subdomain/i.test(x))
      .slice(-4).map(x=>x.slice(0,140));
    throw Error('wrangler_'+args[0]+'_failed_'+result.status+' '+lines.join(' / '));
  }
}
function summary(response){
  const accepted=response.headers.get('x-accepted-github-permissions')||'';
  return {status:response.status,
    githubResponse:!!response.headers.get('x-github-request-id'),
    acceptedActionsWrite:accepted.includes('actions=write'),
    contentIsJson:(response.headers.get('content-type')||'').includes('json'),
    rateLimited:response.headers.get('x-ratelimit-remaining')==='0'};
}
const common={
  'accept':'application/vnd.github+json',
  'authorization':'Bearer '+token,
  'content-type':'application/json',
  'x-github-api-version':'2026-03-10',
  'user-agent':'mcp-workers-s3-isolated-auth-test',
};
const githubUrl='https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/ci.yml';
let touched=false,failed=false;
try{
  const runGet=await fetch(githubUrl,{method:'GET',headers:common,redirect:'manual'});
  const runPost=await fetch(githubUrl+'/dispatches',{
    method:'POST',headers:common,redirect:'manual',
    body:JSON.stringify({ref:branch,return_run_details:true,
      inputs:{worker:'workflow-mcp-worker',s3_executor_worker:'true'}}),
  });
  console.log('S3_GITHUB_RUNNER_DIAGNOSTIC',JSON.stringify({
    read:summary(runGet),invalidDispatch:summary(runPost),
  }));
  const config={name,main:'tests/fixtures/s3-github-auth-probe-worker.ts',
    compatibility_date:'2026-09-10',workers_dev:true,preview_urls:false,
    keep_vars:false,
    vars:{EXPECTED_TOKEN_SHA256:createHash('sha256').update(token).digest('hex'),
      PROBE_ACCESS_TOKEN:access,PROBE_BRANCH:branch}};
  writeFileSync(configUrl,JSON.stringify(config));
  touched=true;
  try{wr(['deploy','--config',configName]);}
  catch(e){
    if(!String(e).includes('10007')||!String(e).includes('subdomain'))throw e;
    await pause(8500);wr(['deploy','--config',configName]);
  }
  wr(['secret','put','GITHUB_AUTH_TOKEN','--config',configName],token);
  let proof=null;
  for(let i=0;i<18;i++){
    try{
      const response=await fetch('https://'+name+'.aiyaya.workers.dev/proof',{
        headers:{authorization:'Bearer '+access},signal:AbortSignal.timeout(10000),
      });
      if(response.status===200){proof=await response.json();break;}
      if(response.status!==404&&response.status!==503)throw Error('proof_http_'+response.status);
    }catch(e){
      if(i===17)throw e;
    }
    await pause(2300);
  }
  assert.ok(proof,'disposable Worker auth probe unavailable');
  console.log('S3_GITHUB_WORKER_DIAGNOSTIC',JSON.stringify(proof));
  assert.equal(proof.tokenUnchanged,true,'GitHub credential was altered in Worker secret');
  console.log('S3_GITHUB_RUNNER_WORKER_DIAGNOSTIC_COMPLETE');
}catch(e){
  failed=true;
  console.error('S3_GITHUB_AUTH_COMPARE_FAILED',
    String(e instanceof Error?e.message:e).replaceAll(token,'[redacted]'));
}finally{
  if(touched){
    let clean=false;
    for(let i=0;i<2;i++){
      const deletion=await cfRequest('/workers/scripts/'+name+'?force=true','DELETE')
        .catch(()=>null);
      const items=await cfRequest('/workers/scripts').catch(()=>null);
      if(items?.success&&Array.isArray(items.result)&&
         !items.result.some(item=>item.id===name||item.name===name)){
        clean=true;break;
      }
      if(i===0)await pause(2500);
    }
    console.log('S3_GITHUB_AUTH_PROBE_CLEANUP',clean?'verified':'FAILED');
    if(!clean)failed=true;
  }
  try{unlinkSync(configUrl);}catch{}
}
process.exit(failed?1:0);
