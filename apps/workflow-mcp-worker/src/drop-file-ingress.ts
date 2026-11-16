/** Spec #87: one-shot admission for an approved selected file.
 * The GitHub transport seals a short-lived locator for the exact reviewed
 * Task Attempt. D1 receives ciphertext only, never the plaintext locator.
 */
import {WorkflowService,StateError,type Env} from './store.ts';
import {inspectAttachmentUrl,type ChatGptFile} from './litterbox-file-source.ts';
import {startLitterboxUpload} from './litterbox-executor.ts';
import {selectedFilePlan} from './selected-file-plan.ts';
import {cloudflareSelectedFilePlan} from './cloudflare-selected-file.ts';
import {startCloudflareSelectedFile} from './cloudflare-selected-file-ingress.ts';
import {isDropPlan,isSealedDropInputs,DROP_UUID,DROP_DIGEST,DROP_PART_SIZE,
 type SealedDropInputs} from './drop-file-contract.ts';
import type {Plan} from './plan.ts';
const FILENAME=/^[^\/\\\u0000-\u001f\u007f]{1,160}\.(?:html|zip)$/i;

const encode=(bytes:Uint8Array):string=>{
 let binary='';
 for(let i=0;i<bytes.length;i+=16384)
  binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
function parsePublicKey(pem:string):ArrayBuffer{
 const match=/^-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PUBLIC KEY-----\s*$/.exec(pem);
 if(!match)throw new StateError('drop_key_unavailable');
 try{
  const der=atob(match[1]!.replace(/\s/g,''));
  if(der.length<250||der.length>1200)throw Error();
  return Uint8Array.from(der,char=>char.charCodeAt(0)).buffer as ArrayBuffer;
 }catch{throw new StateError('drop_key_unavailable');}
}
export async function sealDropFile(
 file:ChatGptFile,attemptId:string,contractDigest:string,pem:string,
 now=Date.now(),
):Promise<SealedDropInputs>{
 const source=inspectAttachmentUrl(file);
 if(!source.url)throw new StateError('drop_file_source_'+source.reason);
 const url=source.url;
 const filename=file.file_name;
 if((filename!==undefined&&
    (typeof filename!=='string'||!FILENAME.test(filename)||filename.startsWith('.')||
     filename.trim()!==filename))||
    (file.mime_type!==undefined&&(typeof file.mime_type!=='string'||file.mime_type.length>255)))
  throw new StateError('drop_file_metadata_invalid');
 if(!DROP_UUID.test(attemptId)||!DROP_DIGEST.test(contractDigest)||!Number.isSafeInteger(now))
  throw new StateError('drop_file_contract_invalid');
 let expires=now+60*60*1000;
 if(url.hostname.endsWith('.blob.core.windows.net')){
  const sas=Date.parse(url.searchParams.get('se')??'');
  if(!Number.isFinite(sas)||sas<=now+60000)
   throw new StateError('drop_file_expiry_insufficient');
  expires=Math.min(expires,sas-30000);
 }
 const issued=now;
 let key:CryptoKey;
 try{
  key=await crypto.subtle.importKey('spki',parsePublicKey(pem),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 }catch{throw new StateError('drop_key_unavailable');}
 const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
 const raw=new Uint8Array(await crypto.subtle.exportKey('raw',aes));
 const wrapped=new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,raw));
 const nonce=crypto.getRandomValues(new Uint8Array(12));
 const aad=new TextEncoder().encode(
  'drop-v1\n'+attemptId.toLowerCase()+'\n'+contractDigest.toLowerCase());
 const plaintext=new TextEncoder().encode(JSON.stringify({
  attemptId:attemptId.toLowerCase(),contractDigest:contractDigest.toLowerCase(),
  issuedAt:issued,expiresAt:expires,file:{
   file_id:file.file_id,download_url:file.download_url,
   ...(filename===undefined?{}:{file_name:filename}),
   ...(file.mime_type===undefined?{}:{mime_type:file.mime_type}),
  },
 }));
 const cipher=new Uint8Array(await crypto.subtle.encrypt(
  {name:'AES-GCM',iv:nonce,additionalData:aad,tagLength:128},aes,plaintext));
 const envelope=encode(new TextEncoder().encode(JSON.stringify({
  v:1,contract_digest:contractDigest.toLowerCase(),
  wrapped_key:encode(wrapped),nonce:encode(nonce),ciphertext:encode(cipher),
 })));
 if(envelope.length>DROP_PART_SIZE*3)throw new StateError('drop_envelope_too_large');
 const result:SealedDropInputs={drop_attempt_id:attemptId.toLowerCase(),
  drop_part_0:envelope.slice(0,DROP_PART_SIZE),
  drop_part_1:envelope.slice(DROP_PART_SIZE,DROP_PART_SIZE*2),
  drop_part_2:envelope.slice(DROP_PART_SIZE*2)};
 if(!isSealedDropInputs(result))throw new StateError('drop_envelope_invalid');
 return result;
}

async function publishedPlan(env:Env,workflow_id:string,expected?:string){
 const row=await env.DB.prepare(`SELECT w.state,w.active_version_id,v.plan
  FROM workflows w JOIN workflow_versions v ON v.id=w.active_version_id
  WHERE w.id=? AND w.deleted_at IS NULL`).bind(workflow_id)
  .first<{state:string;active_version_id:string;plan:string}>();
 if(!row||row.state!=='active')throw new StateError('workflow_not_active');
 if(expected&&row.active_version_id!==expected)throw new StateError('published_version_changed');
 let plan:Plan;
 try{plan=JSON.parse(row.plan) as Plan;}catch{throw new StateError('published_plan_invalid');}
 return {plan,version:row.active_version_id};
}
export async function startSelectedFile(env:Env,args:{
 workflow_id:string;file:ChatGptFile;inputs:Record<string,unknown>;
 idempotency_key:string;expected_published_version_id?:string;
}){
 const {plan,version}=await publishedPlan(env,args.workflow_id,args.expected_published_version_id);
 const cloudflareCapability=cloudflareSelectedFilePlan(plan);
 if(cloudflareCapability)return startCloudflareSelectedFile(env,args,cloudflareCapability,version);
 const fileCapability=selectedFilePlan(plan);
 if(!fileCapability&&!isDropPlan(plan)){
  const supplied=args.inputs;
  if(Object.keys(supplied).some(k=>k!=='time')||
     (supplied.time!==undefined&&typeof supplied.time!=='string'))
   throw new StateError('file_inputs_invalid');
  return startLitterboxUpload(env,{workflow_id:args.workflow_id,file:args.file,
   ...(supplied.time===undefined?{}:{time:supplied.time as string}),
   idempotency_key:args.idempotency_key,expected_published_version_id:version});
 }
 // The owner-initiated manual Run authorizes this selected-file upload.
 // Cloudflare Terms and Privacy acceptance is a one-time prerequisite before
 // the first temporary account; it is not a repeated Workflow input.
 if(Object.keys(args.inputs).length!==0)
  throw new StateError('file_inputs_invalid');
 if(!env.WORKFLOW_GITHUB_DROP_PUBLIC_KEY)throw new StateError('drop_key_unavailable');
 const action=plan.steps[0]!.with.action as {contractDigest:string};
 const attemptId=crypto.randomUUID();
 const sealed=await sealDropFile(args.file,attemptId,fileCapability?.contract_digest??action.contractDigest,
  env.WORKFLOW_GITHUB_DROP_PUBLIC_KEY);
 const run=await new WorkflowService(env).start(args.workflow_id,sealed,args.idempotency_key,
  undefined,fileCapability?'github_selected_file':'drop',version);
 return {run_id:run.run_id,published_version_id:run.published_version_id,
  status:run.status,start_state:run.start_state};
}
