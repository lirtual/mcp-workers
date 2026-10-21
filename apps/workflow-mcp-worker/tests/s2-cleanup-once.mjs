// One-time verification/cleanup for isolated run 39591397557 only.
const name='workflow-s2-ima-aab86c737a';
if(!/^workflow-s2-ima-[a-f0-9]{10}$/.test(name))throw Error('invalid cleanup target');
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(!/^[a-f0-9]{32}$/.test(account||'')||!token)throw Error('missing Cloudflare credentials');
const base='https://api.cloudflare.com/client/v4/accounts/'+account;
async function req(method,path) {
  const r=await fetch(base+path,{method,headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(30000)});
  const j=await r.json().catch(()=>null);
  if(r.status===404||j?.errors?.some(e=>e.code===10007))return {absent:true};
  if(!r.ok||!j?.success)throw Error('Cloudflare '+method+' '+path.split('/')[1]+' status='+r.status+' codes='+JSON.stringify(j?.errors?.map(e=>e.code)));
  return {data:j.result,absent:false};
}
const worker='/workers/scripts/'+name;
const before=await req('GET',worker+'/script-settings');
console.log('TEMP_WORKER_BEFORE',before.absent?'absent':'present');
if(!before.absent){await req('DELETE',worker+'?force=true');}
const after=await req('GET',worker+'/script-settings');
if(!after.absent)throw Error('TEMP_WORKER_STILL_PRESENT');
console.log('TEMP_WORKER_CLEANUP_OK');
const workflow='/workflows/'+name;
const wf=await req('GET',workflow);
if(!wf.absent)await req('DELETE',workflow);
if(!(await req('GET',workflow)).absent)throw Error('TEMP_WORKFLOW_STILL_PRESENT');
console.log('TEMP_WORKFLOW_CLEANUP_OK');
const d1=await req('GET','/d1/database?per_page=100');
if(!Array.isArray(d1.data))throw Error('Cannot verify D1 inventory');
const matches=d1.data.filter(x=>x.name===name);
for(const db of matches)await req('DELETE','/d1/database/'+db.uuid);
const verify=await req('GET','/d1/database?per_page=100');
if(!Array.isArray(verify.data)||verify.data.some(x=>x.name===name))throw Error('TEMP_D1_STILL_PRESENT');
console.log('TEMP_D1_CLEANUP_OK');
console.log('S2_ISOLATED_CLEANUP_CONFIRMED',name);
