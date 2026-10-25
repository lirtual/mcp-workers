import type {Plan,Step} from './plan.ts';
import {reviewedGitHubAction} from './github-action-review.ts';
import {validateGitHubActionInputs,containsDynamicForeachTaskInputs} from './github-action-inputs.ts';
import type {DiscoveredAction} from './github-action-contract.ts';

export function dynamicForeachTaskInputs(controller:Step):boolean{
  const template=controller.with.template as {uses?:unknown;with?:{action?:{inputs?:unknown}}}|undefined;
  const raw=template?.with?.action?.inputs;
  return template?.uses==='github.run'&&!!raw&&typeof raw==='object'&&
    !Array.isArray(raw)&&containsDynamicForeachTaskInputs(raw as Record<string,unknown>);
}

/** Pin the type contract to the published immutable reviewed Action identity. */
export async function reviewedForeachTaskContract(plan:Plan,controller:Step):Promise<DiscoveredAction>{
  const contract=plan.github_dynamic_input_contracts?.[controller.id];
  const raw=(controller.with.template as {with:{action:Record<string,unknown>}}).with.action;
  if(!contract||contract.type!=='task'||!raw||
     typeof raw.contractDigest!=='string')throw Error('github_action_input_contract_missing');
  const pinned=await reviewedGitHubAction({
    repository:raw.repository as string,repositoryId:raw.repositoryId as number,
    workflowId:raw.workflowId as number,workflowPath:raw.workflowPath as string,
    commitSha:raw.commitSha as string,contract,
  });
  if(pinned.contractDigest!==raw.contractDigest||
     !plan.github_action_approvals?.some(grant=>
       Object.entries(pinned).every(([key,value])=>
         (grant as unknown as Record<string,unknown>)[key]===value)))
    throw Error('github_action_input_contract_changed');
  return contract;
}

export async function frozenTaskInputDigest(inputs:Record<string,string>):Promise<string>{
  const normalized=JSON.stringify(Object.entries(inputs).sort(([a],[b])=>a<b?-1:a>b?1:0));
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalized));
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function checkedFrozenTaskInputs(contract:DiscoveredAction,input:unknown):Record<string,string>{
  if(!input||typeof input!=='object'||Array.isArray(input))
    throw Error('github_action_invalid_frozen_inputs');
  return validateGitHubActionInputs(contract,input as Record<string,unknown>);
}
