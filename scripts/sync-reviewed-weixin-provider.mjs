import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/i;
const RUN=/^[1-9][0-9]{0,17}$/;
const PROVIDER='https://api.github.com/repos/lirtual/cloudflare-actions';
const CONSUMER='https://api.github.com/repos/lirtual/mcp-workers';
const CF_D1_ID='051c3b6d-e3bc-4d69-907f-37e8ab00618f';
const ENV_NAME='workflow-mcp-worker';
const VAR_NAME='WEIXIN_ACTION_DEPLOYMENT_ID';
const PROVIDER_WORKFLOW_ID=399111011;
export function reviewedPayload(event){
  if(event?.action!=='reviewed_weixin_provider_release')throw Error('Unreviewed handoff event');
  const p=event.client_payload;
  if(!RUN.test(String(p?.release_run_id??''))||!SHA.test(p?.release_sha??'')||
     !UUID.test(p?.provider_version_id??'')||
     Object.keys(p).sort().join(',')!=='provider_version_id,release_run_id,release_sha')
    throw Error('Invalid immutable handoff identity');
  return {release_run_id:Number(p.release_run_id),release_sha:p.release_sha.toLowerCase(),
    provider_version_id:p.provider_version_id.toLowerCase()};
}
export function verifyProviderProvenance(proof,run,list){
  if(!Array.isArray(list?.workflow_runs)|| Number(run?.id)!==proof.release_run_id ||
     run.workflow_id!==PROVIDER_WORKFLOW_ID || run.status!=='completed'||
     run.conclusion!=='success'||run.event!=='workflow_dispatch'||
     run.head_branch!=='main' || run.head_sha?.toLowerCase()!==proof.release_sha ||
     typeof run.path!=='string'||
     !run.path.endsWith('/.github/workflows/release.yml@refs/heads/main')||
     list.workflow_runs.filter(x=>x?.event==='workflow_dispatch')[0]?.id!==proof.release_run_id)
     throw Error('Source Provider release is not latest authenticated success');
  return true;
}
export function verifyCloudflareProvider(proof,deployments,settings){
  const versions=deployments?.deployments?.[0]?.versions;
  const bindings=settings?.bindings;
  if(!Array.isArray(versions)||versions.length!==1||versions[0].percentage!==100 ||
     versions[0].version_id?.toLowerCase()!==proof.provider_version_id ||
     !Array.isArray(bindings)|| !bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===CF_D1_ID)||
     !bindings.some(x=>x.type==='secret_text'&&x.name==='WEIXIN_ENCRYPTION_KEY')||
     bindings.some(x=>x.name==='MCP_ACCESS_TOKEN'||x.name==='MCP_HOST'))
     throw Error('Live Provider version or preserved security bindings mismatched');
  return true;
}
export async function syncReviewedVersion(proof, credentials, fetchImpl=fetch){
  const {providerReadToken,environmentWriteToken,cloudflareToken,accountId,workflowToken}=credentials;
  if(!providerReadToken||!environmentWriteToken||!cloudflareToken||!workflowToken||
     !/^[a-f0-9]{32}$/i.test(accountId??''))throw Error('Protected sync credentials incomplete');
  const request=async (url,token,method='GET',body)=>{
    const response=await fetchImpl(url,{method,redirect:'manual',
      headers:{Accept:'application/vnd.github+json',
       Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28',
       ...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(method==='PATCH'||method==='POST'){
      if(response.status!==204)throw Error('Protected write not acknowledged (HTTP '+response.status+')');
      return null;
    }
    if(!response.ok)throw Error('Read-only provenance check unavailable (HTTP '+response.status+')');
    return response.json();
  };
  const [run,list,deployments,settings,environment,variable,workflowSettings]=await Promise.all([
    request(PROVIDER+'/actions/runs/'+proof.release_run_id,providerReadToken),
    request(PROVIDER+'/actions/workflows/release.yml/runs?per_page=20',providerReadToken),
    request('https://api.cloudflare.com/client/v4/accounts/'+accountId+
      '/workers/scripts/weixin-mcp-worker/deployments',cloudflareToken),
    request('https://api.cloudflare.com/client/v4/accounts/'+accountId+
      '/workers/scripts/weixin-mcp-worker/settings',cloudflareToken),
    request(CONSUMER+'/environments/'+ENV_NAME,environmentWriteToken),
    request(CONSUMER+'/environments/'+ENV_NAME+'/variables/'+VAR_NAME,environmentWriteToken),
    request('https://api.cloudflare.com/client/v4/accounts/'+accountId+
      '/workers/scripts/workflow-mcp-worker/settings',cloudflareToken)
  ]);
  verifyProviderProvenance(proof,run,list);
  if(deployments?.success!==true||settings?.success!==true)
    throw Error('Cloudflare active Provider could not be verified');
  verifyCloudflareProvider(proof,deployments.result,settings.result);
  const livePin=workflowSettings?.result?.bindings?.filter(x=>
    x.name===VAR_NAME&&x.type==='plain_text');
  if(workflowSettings?.success!==true||livePin?.length!==1||!UUID.test(livePin[0].text??''))
    throw Error('Existing consumer runtime pin not independently verified');
  if(!Array.isArray(environment?.protection_rules)||
     !environment.protection_rules.some(x=>x.type==='required_reviewers')||
     variable?.name!==VAR_NAME||!UUID.test(variable?.value??''))
    throw Error('Workflow GitHub Environment approval or existing pin missing');
  if(variable.value.toLowerCase()!==proof.provider_version_id){
    await request(CONSUMER+'/environments/'+ENV_NAME+'/variables/'+VAR_NAME,
      environmentWriteToken,'PATCH',{name:VAR_NAME,value:proof.provider_version_id});
  }
  const readBack=await request(CONSUMER+'/environments/'+ENV_NAME+'/variables/'+VAR_NAME,
    environmentWriteToken);
  if(readBack?.value?.toLowerCase()!==proof.provider_version_id)
    throw Error('Updated Provider version pin not confirmed');
  // Idempotent: after an earlier successful release, never queue a needless redeploy.
  if(livePin[0].text.toLowerCase()===proof.provider_version_id)
    return {provider_version_id:proof.provider_version_id,dispatched:false};
  // Exactly the pre-existing main-only release, with all native/D1/session gates.
  await request(CONSUMER+'/actions/workflows/release.yml/dispatches',
    workflowToken,'POST',{ref:'main',
      inputs:{worker:ENV_NAME,deploy_to_production:'true'}});
  return {provider_version_id:proof.provider_version_id,dispatched:true};
}
async function main(){
  if(process.env.GITHUB_EVENT_NAME!=='repository_dispatch'||
     process.env.GITHUB_REF!=='refs/heads/main'||
     process.env.GITHUB_SHA!==execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())
    throw Error('Only reviewed consumer main may synchronize Provider pin');
  const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
  const proof=reviewedPayload(event);
  const r=await syncReviewedVersion(proof,{
    providerReadToken:process.env.WEIXIN_PROVIDER_PROOF_TOKEN,
    environmentWriteToken:process.env.WEIXIN_ENVIRONMENT_WRITE_TOKEN,
    cloudflareToken:process.env.CLOUDFLARE_API_TOKEN,
    accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    workflowToken:process.env.GITHUB_TOKEN
  });
  console.log('Reviewed pin '+r.provider_version_id+
    (r.dispatched?' queued through original Workflow release':' already live; no duplicate release')+
    '; no message delivery is claimed');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
