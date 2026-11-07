import YAML from 'yaml';
import type {Env} from './store.ts';
import {discoverCloudflareActionCatalog} from './action-catalog.ts';
import {listAvailableGitHubActions} from './github-action-catalog.ts';
import {PlanError} from './plan.ts';

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export async function resolvePublicActionDefinition(definition:string,env:Pick<Env,
 'ACTIONS'|'WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES'|'WORKFLOW_GITHUB_DISPATCH_TOKEN'>){
 let parsed:unknown;
 try{const doc=YAML.parseDocument(definition,{uniqueKeys:true,strict:true});
   if(doc.errors.length)throw Error('invalid');parsed=doc.toJS({maxAliasCount:16});}
 catch{throw new PlanError('invalid_yaml_or_json');}
 if(!record(parsed)||!Array.isArray(parsed.steps))return {definition,manifests:{}};
 // Foreach keeps its existing GitHub Task-only compiler restrictions.
 // Resolve the same public action_id in its child before normal compilation;
 // do not introduce a generic Cloudflare/Session foreach executor.
 const generic:Array<{step:Record<string,unknown>;nested:boolean}>=[];
 const visit=(value:unknown,nested=false)=>{
   if(!record(value))return;
   if(value.uses==='action.run'&&record(value.with)&&
      typeof value.with.action_id==='string')generic.push({step:value,nested});
 };
 for(const raw of parsed.steps){
   if(!record(raw))continue;
   visit(raw);
   if(!record(raw.template))continue;
   visit(raw.template,true);
   if(Array.isArray(raw.template.steps))
     for(const child of raw.template.steps)visit(child,true);
 }
 if(!generic.length)return {definition,manifests:{}};
 if(generic.length>128)throw new PlanError('too_many_action_steps','/steps');
 const manifests:Record<string,Record<string,unknown>>={};
 let cloudflare:Awaited<ReturnType<typeof discoverCloudflareActionCatalog>>|undefined;
 let github:Awaited<ReturnType<typeof listAvailableGitHubActions>>|undefined;
 for(const {step,nested} of generic){
   const withData=step.with as Record<string,unknown>;
   const actionId=withData.action_id as string;
   if(Object.keys(withData).some(k=>!['action_id','input'].includes(k))||!record(withData.input))
     throw new PlanError('invalid_action_input','/steps');
   if(actionId.startsWith('github.')){
     github??=await listAvailableGitHubActions(env);
     const action=github.actions.find(a=>'github.'+a.workflowPath.split('/').at(-1)!.replace(/\.ya?ml$/,'')===actionId);
     if(!action)throw new PlanError('action_not_discovered','/steps');
     step.with={executor:'github',capability:'github.action',action:{
       repository:action.repository,repositoryId:action.repositoryId,
       workflowId:action.workflowId,workflowPath:action.workflowPath,
       commitSha:action.commitSha,type:action.type,contractDigest:action.contractDigest,
       ref:action.ref,inputs:withData.input,
     }};
   }else{
     if(nested)throw new PlanError('unsupported_foreach_action','/steps');
     cloudflare??=await discoverCloudflareActionCatalog(env);
     const action=cloudflare.actions.find(a=>a.action_id===actionId);
     if(!action)throw new PlanError('action_not_discovered','/steps');
     step.with={executor:'cloudflare',provider:action.provider,action:actionId,
       contract_digest:action.contract_digest,input:withData.input};
     manifests[String(step.id)]={...action.manifest,contract_digest:action.contract_digest};
   }
 }
 return {definition:JSON.stringify(parsed),manifests};
}
