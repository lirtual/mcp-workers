/** Published, reviewed selected-file capability. A Plan name never grants access. */
import type {Plan} from './plan.ts';
import type {GitHubSelectedFileContract} from './selected-file-contract.ts';
import {isPublishedGitHubActionApproved,type ReviewedGitHubAction} from './github-action-review.ts';
import {isDynamicMainAction} from './github-action-main.ts';

export type ReviewedSelectedFile={
 delivery:'github_encrypted_locator_v1';
 step_id:string;
 file:GitHubSelectedFileContract;
 contract_digest:string;
};
const same=(a:readonly string[],b:readonly string[])=>
 a.length===b.length&&a.every((key,i)=>key===b[i]);

/** Source metadata is frozen in github_dynamic_input_contracts by Publish,
 * after source SHA and reviewed digest have been rechecked. Neither Plan.inputs
 * nor caller-supplied files can create this permission.
 */
export function selectedFilePlan(plan:Plan):ReviewedSelectedFile|null{
 if(!plan||!Array.isArray(plan.steps)||plan.steps.length!==1||
    plan.triggers?.length||plan.saga||plan.github_execution_approved!==true||
    (plan.inputs&&Object.keys(plan.inputs).length!==0))return null;
 const step=plan.steps[0]!;
 if(step.uses!=='github.run'||step.with.capability!=='github.action'||
    step.needs?.length!==0||step.if!==undefined||
    step.needs_policy!==undefined||step.approval!==undefined)return null;
 const raw=step.with.action as Record<string,unknown>|undefined;
 if(!raw||raw.type!=='task'||raw.ref!=='refs/heads/main'||
    !isDynamicMainAction(raw as ReviewedGitHubAction,raw.ref))return null;
 const source=plan.github_dynamic_input_contracts?.[step.id];
 const policy=source?.selectedFile;
 if(!source||source.type!=='task'||!policy||
    policy.delivery!=='github_encrypted_locator_v1'||policy.receipt!=='owner_claim_v1'||
    policy.consent!=='cloudflare_terms_v1'||policy.max_bytes!==10485760||
    !Array.isArray(policy.extensions)||
    !same(policy.extensions,['.html','.zip'])||
    !same(policy.input_slots,['drop_part_0','drop_part_1','drop_part_2']))return null;
 const identity:ReviewedGitHubAction={
  repository:raw.repository as string,repositoryId:raw.repositoryId as number,
  workflowId:raw.workflowId as number,workflowPath:raw.workflowPath as string,
  commitSha:raw.commitSha as string,type:'task',contractDigest:raw.contractDigest as string,
 };
 if(!isPublishedGitHubActionApproved(plan.github_action_approvals,identity))return null;
 const given=raw.inputs;
 if(!given||typeof given!=='object'||Array.isArray(given))return null;
 const input=given as Record<string,unknown>;
 if(!same(Object.keys(input).sort(),[...policy.input_slots].sort())||
    policy.input_slots.some(slot=>input[slot]!==''))return null;
 return {delivery:'github_encrypted_locator_v1',step_id:step.id,
  file:policy,contract_digest:identity.contractDigest};
}
