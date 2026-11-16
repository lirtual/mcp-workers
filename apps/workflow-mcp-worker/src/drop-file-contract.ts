/** Spec #87: the only Task Plan permitted to bind a selected-file ciphertext. */
import {isPublishedGitHubActionApproved} from './github-action-review.ts';
import type {Plan} from './plan.ts';

export const DROP_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DROP_DIGEST=/^[a-f0-9]{64}$/i;
export const DROP_PART_SIZE=3500;
export const DROP_PARTS=['drop_part_0','drop_part_1','drop_part_2'] as const;
export type SealedDropInputs={drop_attempt_id:string;drop_part_0:string;drop_part_1:string;drop_part_2:string};

export function isDropPlan(p:Plan):boolean{
 const s=p.steps?.[0];
 if(p.name!=='drop'||p.steps.length!==1||p.triggers?.length||p.saga||
    (p.inputs&&Object.keys(p.inputs).length!==0)||
    p.github_execution_approved!==true||
    s?.uses!=='github.run'||!Array.isArray(s.needs)||s.needs.length!==0||s.if!==undefined||
    s.approval!==undefined||s.needs_policy!==undefined||
    s.with.capability!=='github.action')return false;
 const a=s.with.action as Record<string,unknown>|undefined;
 if(!a||a.type!=='task'||a.workflowPath!=='.github/workflows/drop.yml'||
    a.ref!=='refs/heads/main'||!DROP_DIGEST.test(String(a.contractDigest))||
    !a.inputs||typeof a.inputs!=='object'||Array.isArray(a.inputs))return false;
 const inputs=a.inputs as Record<string,unknown>;
 if(Object.keys(inputs).sort().join(',')!==[...DROP_PARTS].sort().join(',')||
    DROP_PARTS.some(k=>inputs[k]!==''))return false;
 return isPublishedGitHubActionApproved(p.github_action_approvals,{
  repository:a.repository as string,repositoryId:a.repositoryId as number,
  workflowId:a.workflowId as number,workflowPath:a.workflowPath as string,
  commitSha:a.commitSha as string,type:'task',contractDigest:a.contractDigest as string,
 });
}
export function isSealedDropInputs(value:unknown):value is SealedDropInputs{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).sort().join(',')!==
    ['drop_attempt_id',...DROP_PARTS].sort().join(',')||
    typeof v.drop_attempt_id!=='string'||!DROP_UUID.test(v.drop_attempt_id))return false;
 const parts=DROP_PARTS.map(k=>v[k]);
 if(parts.some(part=>typeof part!=='string'||part.length>DROP_PART_SIZE)||
    !parts[0]||(!parts[1]&&parts[2]))return false;
 return parts.join('').length<=DROP_PART_SIZE*3;
}
