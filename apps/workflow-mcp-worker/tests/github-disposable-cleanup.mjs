// Only cleans exact disposable GitHub Plan test resources. No wildcards, no
// other Worker prefixes, and NEVER production resources.
import assert from 'node:assert/strict';
const name=process.argv[2];
assert.match(name,/^workflow-github-plan-[a-f0-9]{10}$/);
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
assert.ok(token && account,'Missing Cloudflare cleanup credentials');
const prefix='https://api.cloudflare.com/client/v4/accounts/'+account;
async function call(path,method='GET'){
  const response=await fetch(prefix+path,{
    method,headers:{authorization:'Bearer '+token},
    signal:AbortSignal.timeout(25000),
  });
  const doc=await response.json().catch(()=>({}));
  return {status:response.status,success:doc.success,result:doc.result,
    errors:(doc.errors||[]).map(e=>({code:e.code}))};
}
const absent=result=>result.status===404||result.errors.some(e=>
  [10007,10015,10017].includes(e.code));
async function remove(kind,path){
  const response=await call(path,'DELETE');
  if(!response.success&&!absent(response))
    throw Error(kind+'_delete_http_'+response.status+
      '_code_'+String(response.errors[0]?.code??'none'));
  console.log('GITHUB_DISPOSABLE_'+kind+'_DELETE_CHECKED',name,
    'status',response.status);
}
async function databaseIds(){
  const items=[];
  for(let page=1;page<=5;page++){
    const response=await call('/d1/database?page='+page+'&per_page=100');
    if(!response.success||!Array.isArray(response.result))
      throw Error('d1_list_failed_http_'+response.status);
    items.push(...response.result.filter(x=>x.name===name).map(x=>x.uuid));
    if(response.result.length<100)break;
  }
  return items;
}
let failure=false;
try{
  // A non-created resource normally returns 404/10007. Do not infer
  // existence from script-settings, whose response differs by API version.
  await remove('WORKER','/workers/scripts/'+name+'?force=true');
  await remove('WORKFLOW','/workflows/'+name);
  for(const uuid of await databaseIds()){
    assert.match(uuid,/^[a-f0-9-]{36}$/i);
    await remove('D1','/d1/database/'+uuid);
  }
  assert.equal((await databaseIds()).length,0,'Disposable D1 still exists');
  const workers=await call('/workers/scripts');
  if(!workers.success||!Array.isArray(workers.result))
    throw Error('workers_list_failed_http_'+workers.status);
  assert.ok(!workers.result.some(x=>x.id===name||x.name===name),
    'Disposable Worker still exists');
  console.log('GITHUB_DISPOSABLE_CLEANUP_VERIFIED',name);
}catch(e){failure=true;console.error('GITHUB_DISPOSABLE_CLEANUP_FAILED',
  String(e.message).replaceAll(token,'[redacted]'));}
process.exit(failure?1:0);
