// Spec #476: nonsecret PR staging only; no deployment, config/CA or D1 mutations.
import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfiguration, verifyDatabaseHyperdriveSource } from './manual-worker-release.mjs';
import { verifyGithubPrPreflight } from './prepare-database-hyperdrive-476.mjs';
const REPO='lirtual/mcp-workers',D1='cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const fail=reason=>{throw Object.assign(new Error('Hyperdrive unbinding blocked'),{reason});};
const gate=(ok,reason)=>{if(!ok)fail(reason);};
const sha=/^[a-f0-9]{40}$/;
export function removeHyperdriveBindingSource(text,manifest,binding,id){
  const source=readConfiguration('database-mcp-worker',text,manifest);
  verifyDatabaseHyperdriveSource(source,manifest);
  gate(source?.name==='database-mcp-worker'&&source.d1_databases?.length===1&&
    source.d1_databases[0].database_id===D1,'source_drift');
  gate(source.hyperdrive.filter(x=>x.binding===binding&&x.id===id).length===1&&
    manifest.filter(x=>x.binding===binding&&x.id===id).length===1,'binding_mismatch');
  const match=/("hyperdrive": \[)([\s\S]*?)(\n  \],)/.exec(text);
  gate(!!match,'format_unknown');
  const current=JSON.parse('['+match[2]+']');
  gate(current.length===source.hyperdrive.length,'source_drift');
  const keep=current.filter(x=>!(x.binding===binding&&x.id===id));
  const inner=keep.map(x=>'\n    { "binding": '+JSON.stringify(x.binding)+', "id": '+JSON.stringify(x.id)+' }').join(',');
  const changed=text.replace(match[0],match[1]+inner+match[3]);
  const next=manifest.filter(x=>!(x.binding===binding&&x.id===id));
  verifyDatabaseHyperdriveSource(JSON.parse(changed),next);
  return {'apps/database-mcp-worker/wrangler.jsonc':changed,
    'apps/database-mcp-worker/hyperdrive-bindings.json':JSON.stringify(next,null,2)+'\n'};
}
/** Check branch, full PR identity and exact blob bytes before trusting a
 * previously accepted Create-PR side effect. Read-only and fail-closed. */
async function verifyUnbindDraft({github,prNumber,branch,headSha,baseSha,files}){
  const pr=await github('/pulls/'+prNumber);
  gate(pr?.number===prNumber&&pr?.state==='open'&&pr?.draft===true&&
    pr?.head?.sha===headSha&&pr?.head?.ref===branch&&
    pr?.head?.repo?.full_name===REPO&&pr?.base?.ref==='main'&&
    pr?.base?.repo?.full_name===REPO&&pr?.base?.sha===baseSha&&
    pr?.commits===1&&pr?.changed_files===2,'pr_readback_mismatch');
  const commit=await github('/git/commits/'+headSha);
  gate(commit?.sha===headSha&&sha.test(commit?.tree?.sha??'')&&
    commit?.parents?.length===1&&commit.parents[0].sha===baseSha,'commit_readback_mismatch');
  const changed=await github('/pulls/'+prNumber+'/files?per_page=100');
  gate(Array.isArray(changed)&&changed.length===2&&
    Object.keys(files).every(path=>changed.filter(f=>f.filename===path&&f.status==='modified'&&
      sha.test(f.sha??'')).length===1),'pr_files_mismatch');
  for(const file of changed){
    const expected=Buffer.from(files[file.filename],'utf8');
    const expectedHash=createHash('sha1').update(Buffer.from('blob '+expected.length+'\0')).update(expected).digest('hex');
    gate(file.sha===expectedHash,'pr_blob_sha_mismatch');
    const read=await github('/git/blobs/'+file.sha);
    gate(read?.sha===file.sha&&read?.encoding==='base64'&&
      typeof read.content==='string'&&
      Buffer.from(read.content,'base64').equals(expected),'pr_blob_content_mismatch');
  }
}
export async function stageHyperdriveUnbind({env=process.env,request=fetch,sourceText,manifest}){
  gate(env.GITHUB_REPOSITORY===REPO&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&
    env.GITHUB_ACTOR==='lirtual'&&env.GITHUB_REF==='refs/heads/main'&&sha.test(env.GITHUB_SHA??'')&&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(env.DATABASE_RETIRE_ID??'')&&
    /^[1-9][0-9]{0,12}$/.test(env.DATABASE_RETIRE_REVISION??'')&&
    /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID??'')&&
    [env.CLOUDFLARE_API_TOKEN,env.DATABASE_GITHUB_ACTIONS_TOKEN,env.GITHUB_TOKEN].every(x=>typeof x==='string'&&x.length>0),
    'owner_and_credentials');
  const source=JSON.parse(sourceText);
  verifyDatabaseHyperdriveSource(source,manifest);
  gate(source?.name==='database-mcp-worker'&&source?.main==='src/index.ts'&&
    source.d1_databases?.length===1&&source.d1_databases[0].binding==='DB'&&
    source.d1_databases[0].database_id===D1,'source_identity');
  const cf='https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID,
    gh='https://api.github.com/repos/'+REPO;
  const ghHeaders={authorization:'Bearer '+env.GITHUB_TOKEN,accept:'application/vnd.github+json',
    'user-agent':'lirtual-database-hyperdrive-476','x-github-api-version':'2022-11-28'};
  async function req(url,headers,method='GET',body){
    let res;
    try{res=await request(url,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});}
    catch{fail('request_unknown');}
    gate(res.ok,'request_rejected');
    try{return await res.json();}catch{fail('response_unknown');}
  }
  const github=(path,method='GET',body)=>req(gh+path,ghHeaders,method,body);
  const sql=async(query,params)=>{
    const data=await req(cf+'/d1/database/'+D1+'/query',
      {authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,accept:'application/json'},'POST',{sql:query,params});
    gate(data?.success===true&&Array.isArray(data.result)&&data.result.length===1&&
      data.result[0]?.success===true,'d1_unavailable');return data.result[0];
  };
  const found=await sql('SELECT id,transport,status,revision,config_id,binding_name FROM database_connections WHERE id=?',
    [env.DATABASE_RETIRE_ID]);
  gate(found.results?.length===1,'row_missing');
  const row=found.results[0];
  gate(row.id===env.DATABASE_RETIRE_ID&&row.transport==='hyperdrive'&&
    row.status==='disabled'&&row.revision===Number(env.DATABASE_RETIRE_REVISION),'row_active_or_stale');
  const bound=(source.hyperdrive??[]).some(x=>x.binding===row.binding_name&&x.id===row.config_id)&&
    manifest.some(x=>x.binding===row.binding_name&&x.id===row.config_id);
  const files=bound?removeHyperdriveBindingSource(sourceText,manifest,row.binding_name,row.config_id):null;
  const pending=await sql("SELECT COUNT(*) AS n FROM hyperdrive_operations WHERE logical_id=? AND phase IN ('pending','running','awaiting_confirmation','unknown')",[row.id]);
  gate(pending.results?.length===1&&pending.results[0].n===0,'unresolved_operation');
  const shared=await sql('SELECT COUNT(*) AS n FROM database_connections WHERE id<>? AND (config_id=? OR binding_name=?)',
    [row.id,row.config_id,row.binding_name]);
  gate(shared.results?.length===1&&shared.results[0].n===0,'shared_reference');
  if(!files) {
    gate(!manifest.some(x=>x.binding===row.binding_name||x.id===row.config_id),'source_partial_binding');
    return {phase:'already_unbound'};
  }
  await verifyGithubPrPreflight({request,token:env.DATABASE_GITHUB_ACTIONS_TOKEN,sourceSha:env.GITHUB_SHA});
  const branch='db476-unbind-'+createHash('sha256').update('db476:unbind:'+row.id).digest('hex').slice(0,24);
  // A previously accepted request is not permission to create a second PR.
  let present;
  try{present=await request(gh+'/git/ref/heads/'+branch,
    {headers:ghHeaders,redirect:'manual',signal:AbortSignal.timeout(10000)});}
  catch{fail('branch_unknown');}
  if(present?.status===200){
    let ref;
    try{ref=await present.json();}catch{fail('branch_receipt_unknown');}
    gate(ref?.ref==='refs/heads/'+branch&&sha.test(ref?.object?.sha??''),'branch_receipt_unknown');
    // No create, update or PR re-dispatch on a pre-existing branch.
    const prs=await github('/pulls?state=all&head=lirtual%3A'+branch+'&per_page=100');
    gate(Array.isArray(prs)&&prs.length===1&&prs.length<100&&Number.isSafeInteger(prs[0]?.number)&&
      prs[0].number>0,'pr_reconciliation_required');
    await verifyUnbindDraft({github,prNumber:prs[0].number,branch,
      headSha:ref.object.sha,baseSha:env.GITHUB_SHA,files});
    return {phase:'awaiting_unbind_review',prNumber:prs[0].number};
  }
  gate(present?.status===404,'branch_existing_or_unknown');
  const base=await github('/git/commits/'+env.GITHUB_SHA);
  gate(sha.test(base?.tree?.sha??''),'base_invalid');
  const entries=[];
  for(const [path,content] of Object.entries(files)){
    const blob=await github('/git/blobs','POST',{content:Buffer.from(content).toString('base64'),encoding:'base64'});
    gate(sha.test(blob?.sha??''),'blob_unknown');
    entries.push({path,mode:'100644',type:'blob',sha:blob.sha});
  }
  const tree=await github('/git/trees','POST',{base_tree:base.tree.sha,tree:entries});
  gate(sha.test(tree?.sha??''),'tree_unknown');
  const commit=await github('/git/commits','POST',{message:'chore(database): stage reviewed Hyperdrive unbinding #476',
    tree:tree.sha,parents:[env.GITHUB_SHA]});
  gate(sha.test(commit?.sha??''),'commit_unknown');
  await github('/git/refs','POST',{ref:'refs/heads/'+branch,sha:commit.sha});
  const pr=await github('/pulls','POST',{title:'chore(database): review Hyperdrive unbinding '+row.id,
    head:branch,base:'main',draft:true,body:'Spec #476 · Disabled logical ID '+row.id+
      '. Two nonsecret source files only. Do not merge or release before separate proof that in-flight operations and rollback dependencies are clear.'});
  gate(Number.isSafeInteger(pr?.number)&&pr.number>0,'pr_unknown');
  await verifyUnbindDraft({github,prNumber:pr.number,branch,
    headSha:commit.sha,baseSha:env.GITHUB_SHA,files});
  return {phase:'awaiting_unbind_review',prNumber:pr.number};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  Promise.all([readFile(new URL('../apps/database-mcp-worker/wrangler.jsonc',import.meta.url),'utf8'),
    readFile(new URL('../apps/database-mcp-worker/hyperdrive-bindings.json',import.meta.url),'utf8')])
    .then(([sourceText,manifestText])=>stageHyperdriveUnbind({sourceText,manifest:JSON.parse(manifestText)}))
    .then(async ({phase,prNumber})=>{
      if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,
        'action='+(phase==='already_unbound'?'retire':'review')+'\n');
      process.stdout.write(phase==='already_unbound'?'HYPERDRIVE_ALREADY_UNBOUND\n':
        'HYPERDRIVE_UNBIND_REVIEW_PR='+prNumber+'\n');
    })
    .catch(()=>{process.stderr.write('HYPERDRIVE_UNBIND_BLOCKED_OR_UNKNOWN\n');process.exitCode=1;});
}
