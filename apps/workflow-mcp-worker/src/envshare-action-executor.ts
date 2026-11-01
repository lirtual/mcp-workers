import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {cloudflareActionManifest,canonical} from './cloudflare-action-contract.ts';
import {evaluateArguments} from './plan.ts';

type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;
 output?:{status:'accepted';share_id:string}};
const failed=(error_code:string):Result=>({status:'failed',error_code});
const unknown=(error_code='envshare_outcome_unknown'):Result=>({status:'indeterminate',error_code});
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function size(s:unknown):number{
 if(typeof s!=='string'||!s||s.length>30000)return -1;
 let n=0n;for(const c of s){const d=B58.indexOf(c);if(d<0)return -1;n=n*58n+BigInt(d);}
 let bytes=0;while(n){bytes++;n>>=8n;}for(const c of s){if(c!=='1')break;bytes++;}
 return bytes;
}
export async function runEnvshareAction(env:Env,plan:Plan,action:Step,runId:string,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>}):Promise<Result>{
 const manifest=await cloudflareActionManifest('envshare');
 const db=env.DB,provider=env.ACTIONS,version=env.ACTIONS_DEPLOYMENT_ID;
 if(!plan.cloudflare_execution_approved||plan.triggers?.length||plan.steps.length!==1||
   action.uses!=='action.run'||action.with.executor!=='cloudflare'||
   action.with.provider!=='envshare'||action.with.action!==manifest.action||
   action.with.contract_digest!==manifest.contract_digest)return failed('envshare_manual_approval_required');
 const current=()=>db.prepare('SELECT invocation_id FROM cloudflare_action_invocations WHERE run_id=? AND step_id=?')
   .bind(runId,action.id).first<{invocation_id:string}>();
 try{
  if(await current())return unknown('envshare_receipt_unavailable');
  if(!provider||!version)return failed('cloudflare_provider_not_configured');
  if(!plan.cloudflare_action_approvals?.some(g=>g.executor==='cloudflare'&&g.provider==='envshare'&&
     g.action===manifest.action&&g.contract_digest===manifest.contract_digest&&g.deployment_id===version))
   return failed('cloudflare_action_approval_required');
  let sealed:{encrypted:string;iv:string;ttl:number;reads:number};
  try{
   if(!ctx||typeof ctx.inputs.key_digest!=='string')throw Error('missing_sealed_run');
   const src=action.with.input as Record<string,unknown>;
   if(!src||typeof src!=='object'||Array.isArray(src)||
      Object.keys(src).sort().join(',')!=='encrypted,iv,reads,ttl')throw Error('input_schema');
   for(const field of ['encrypted','iv','ttl','reads'])
    if(!src[field]||typeof src[field]!=='object'||Array.isArray(src[field])||
       Object.keys(src[field] as object).length!==1||
       (src[field] as {ref?:unknown}).ref!=='inputs.'+field)throw Error('unsafe_ref');
   const values=Object.fromEntries(Object.entries(src).map(([k,v])=>[k,evaluateArguments(v,ctx)]));
   if(size(values.encrypted)<17||size(values.encrypted)>16400||size(values.iv)!==16||
      !Number.isSafeInteger(values.ttl)||Number(values.ttl)<60||Number(values.ttl)>604800||
      !Number.isSafeInteger(values.reads)||Number(values.reads)<1||Number(values.reads)>10)
    throw Error('invalid_sealed_values');
   sealed=values as typeof sealed;
  }catch{return failed('invalid_envshare_sealed_input');}
  const raw=JSON.stringify(canonical(sealed));
  const input_digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),
    b=>b.toString(16).padStart(2,'0')).join('');
  let identity;
  try{identity=await provider.getContract(manifest.action,manifest.contract_digest);}
  catch{return failed('cloudflare_provider_identity_unconfirmed');}
  if(identity.contract_digest!==manifest.contract_digest||identity.deployment_id!==version)
   return failed('cloudflare_provider_identity_mismatch');
  const invocation_id=crypto.randomUUID();
  const reservation=await db.prepare(`INSERT OR IGNORE INTO cloudflare_action_invocations
   (run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,
    contract_digest,deployment_id,created_at)
   SELECT ?,?,?,?,?,0,?,?,? WHERE EXISTS (SELECT 1 FROM runs WHERE id=? AND outcome='running')
   AND EXISTS(SELECT 1 FROM cloudflare_action_gate WHERE id=1 AND state='open')
   AND NOT EXISTS(SELECT 1 FROM cloudflare_action_cancellations WHERE run_id=? AND step_id=?)`)
   .bind(runId,action.id,invocation_id,invocation_id,input_digest,
     manifest.contract_digest,version,Date.now(),runId,runId,action.id).run();
  if(reservation.meta.changes!==1)
   return await current()?unknown('envshare_receipt_unavailable'):failed('cloudflare_dispatch_not_admitted');
  try{
   const output=await provider.execute(manifest.action,{...sealed,invocation_id,
    deployment_id:version,contract_digest:manifest.contract_digest,input_digest}) as
    {status:string;input_digest:string;share_id?:string};
   if(output.input_digest!==input_digest)return unknown('envshare_digest_conflict');
   if(output.status==='accepted'&&size(output.share_id)===16)
    return {status:'succeeded',output:{status:'accepted',share_id:output.share_id!}};
   if(output.status==='rejected')return failed('envshare_rejected');
   return unknown();
  }catch{return unknown();}
 }catch{return unknown('cloudflare_dispatch_unconfirmed');}
}
