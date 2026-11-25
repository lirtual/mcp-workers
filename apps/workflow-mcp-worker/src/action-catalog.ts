import type {Env} from './store.ts';
import {jsonActionInputBudget} from './action-input-schema.ts';
import {canonical} from './cloudflare-action-contract.ts';
import {listAvailableGitHubActions} from './github-action-catalog.ts';
import {reviewedCloudflareFilePolicy} from './cloudflare-selected-file.ts';

const ACTION=/^[a-z][a-z0-9_-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/;
const DEPLOYMENT=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const AUDITED_EFFECTS:Record<string,string>={
 'bark.send_notification':'send_to_configured_owner_only',
 'dub.shorten_url':'create_public_short_link_at_dub',
 'envshare.share_text':'store_encrypted_text_at_envshare',
 'litterbox.upload_file':'upload_plaintext_file_to_public_litterbox',
};
const EFFECT=/^[a-z][a-z0-9_]{0,80}$/;
const RESERVED_EFFECTS=new Set(Object.values(AUDITED_EFFECTS));
/** A Provider manifest cannot grant itself additional execution privileges.
 * Auto-grants cover only the existing exact audited Action/effect pairs or
 * declared effect-free/read-only actions. All new write effects require an
 * independently approved exact grant through the existing privileged path.
 * Existing Provider manifests may contain auto_grant_reviewed metadata;
 * it cannot authorize a new write effect. */
export function needsExplicitCloudflareEffectGrant(manifest:Record<string,unknown>):boolean{
 const action=String(manifest.action??'');
 if(Object.hasOwn(AUDITED_EFFECTS,action)&&AUDITED_EFFECTS[action]===manifest.side_effect)
   return false;
 return manifest.side_effect!=='none'&&manifest.side_effect!=='read_only';
}

const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function reject():never{throw Error('cloudflare_action_catalog_untrusted');}
function validSchema(s:unknown){
 if(!record(s)||s.type!=='object'||s.additionalProperties!==false||
    !record(s.properties)||Object.keys(s.properties).length>32||
    !Array.isArray(s.required)||s.required.some(k=>typeof k!=='string'||!Object.hasOwn(s.properties as object,k)))reject();
 if(Object.keys(s).some(k=>!['type','additionalProperties','properties','required','description'].includes(k)))reject();
 for(const field of Object.values(s.properties)){
   if(!record(field)||Object.keys(field).some(k=>!['type','enum','minLength','maxLength','minimum','maximum','pattern','description'].includes(k)))reject();
   if(field.type!==undefined&&!['string','number','integer','boolean'].includes(String(field.type)))reject();
   if(field.enum!==undefined&&(!Array.isArray(field.enum)||!field.enum.length||field.enum.length>32))reject();
 }
}
function inspectedManifest(actionId:string,raw:unknown){
 if(!record(raw)||raw.executor!=='cloudflare'||raw.source_repository!=='lirtual/cloudflare-actions'||
    raw.service!=='cloudflare-actions'||raw.entrypoint!=='ActionsEntrypoint'||
    raw.action!==actionId||typeof raw.provider!=='string'||
    !ACTION.test(actionId)||!actionId.startsWith(raw.provider+'.')||
    !Number.isSafeInteger(raw.version)||Number(raw.version)<1||
    (raw.auto_grant_reviewed!==undefined&&typeof raw.auto_grant_reviewed!=='boolean')||
    typeof raw.side_effect!=='string'||!EFFECT.test(raw.side_effect)||
    (Object.hasOwn(AUDITED_EFFECTS,actionId)?AUDITED_EFFECTS[actionId]!==raw.side_effect:
     RESERVED_EFFECTS.has(raw.side_effect)))reject();
 try{jsonActionInputBudget(raw.max_input_bytes);}catch{reject();}
 if(raw.error_codes!==undefined&&(!Array.isArray(raw.error_codes)||raw.error_codes.length<1||
    raw.error_codes.length>32||new Set(raw.error_codes).size!==raw.error_codes.length||
    raw.error_codes.some(code=>typeof code!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code))))reject();
 validSchema(raw.input_schema);
 if(raw.output_schema!==undefined)validSchema(raw.output_schema);
 if(raw.selected_file!==undefined&&(!reviewedCloudflareFilePolicy(raw.selected_file)||
     raw.output_schema===undefined))reject();
 if(new TextEncoder().encode(JSON.stringify(raw)).byteLength>16*1024)reject();
 return raw;
}
const hash=async (value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
 new TextEncoder().encode(JSON.stringify(canonical(value))))),b=>b.toString(16).padStart(2,'0')).join('');

/** A private Service Binding is the sole source. Discovery never loads code. */
export async function discoverCloudflareActionCatalog(env:Pick<Env,'ACTIONS'>){
 if(!env.ACTIONS)throw Error('cloudflare_provider_not_configured');
 let found:Awaited<ReturnType<NonNullable<Env['ACTIONS']>['listActions']>>;
 try{found=await env.ACTIONS.listActions();}catch{throw Error('cloudflare_provider_unavailable');}
 if(!Array.isArray(found)||found.length>32)reject();
 const actions:Array<{action_id:string;executor:'cloudflare';provider:string;name:string;
  description:string;input_schema:unknown;output_schema?:unknown;max_input_bytes?:number;error_codes?:string[];
  selected_file?:unknown;contract_digest:string;
  deployment_id:string;availability:'supported_with_grant';manifest:Record<string,unknown>;}>=[];
 const seen=new Set<string>();let deployment:string|undefined;
 for(const item of found){
  if(!record(item)||typeof item.action_id!=='string'||!ACTION.test(item.action_id)||
    seen.has(item.action_id)||item.action_id.startsWith('weixin.'))reject();
  seen.add(item.action_id);
  let info:Awaited<ReturnType<NonNullable<Env['ACTIONS']>['getContract']>>;
  try{info=await env.ACTIONS.getContract(item.action_id);}catch{throw Error('cloudflare_provider_contract_unavailable');}
  if(!record(info)||typeof info.deployment_id!=='string'||!DEPLOYMENT.test(info.deployment_id)||
     typeof info.contract_digest!=='string'||!/^[a-f0-9]{64}$/.test(info.contract_digest))reject();
  const manifest=inspectedManifest(item.action_id,info.manifest);
  if(await hash(manifest)!==info.contract_digest)reject();
  if(deployment!==undefined&&deployment!==info.deployment_id)reject();
  deployment=info.deployment_id;
  actions.push({action_id:item.action_id,executor:'cloudflare',
    provider:String(manifest.provider),name:String(manifest.name??item.action_id),
    description:String(manifest.description??manifest.side_effect),
    input_schema:manifest.input_schema,
    ...(manifest.error_codes===undefined?{}:{error_codes:manifest.error_codes as string[]}),
    ...(manifest.max_input_bytes===undefined?{}:{max_input_bytes:Number(manifest.max_input_bytes)}),
    ...(manifest.output_schema===undefined?{}:{output_schema:manifest.output_schema}),
    ...(manifest.selected_file===undefined?{}:{selected_file:manifest.selected_file}),
    contract_digest:info.contract_digest,deployment_id:info.deployment_id,
    availability:'supported_with_grant',manifest});
 }
 return {actions};
}

/** Stable IDs from both executors, one current candidate each. */
export async function listUnifiedActions(env:Pick<Env,
 'ACTIONS'|'WORKFLOW_GITHUB_ACTION_IDENTITY'|'WORKFLOW_GITHUB_DISPATCH_TOKEN'>){
 const github=await listAvailableGitHubActions(env);
 const cloudflare=env.ACTIONS?await discoverCloudflareActionCatalog(env):{actions:[]};
 const actions=[...github.actions.map(action=>({
   ...action,action_id:'github.'+action.workflowPath.split('/').at(-1)!.replace(/\.ya?ml$/,''),
   executor:'github' as const,
 })),...cloudflare.actions.map(({manifest,...publicFields})=>publicFields)];
 if(new Set(actions.map(a=>a.action_id)).size!==actions.length)throw Error('action_id_collision');
 return {actions};
}
