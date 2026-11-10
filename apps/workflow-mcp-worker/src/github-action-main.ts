import type {ReviewedGitHubAction} from './github-action-review.ts';

export const DYNAMIC_MAIN_REF='refs/heads/main';
// Current repository identity is checked against the release-pinned Worker
// binding at Publish and before any new physical dispatch.
const WORKFLOW=/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.ya?ml$/;
const SHA=/^[0-9a-f]{40}$/;

/** Structurally valid dynamic-main Task/Session; identity admission is separate. */
export function isDynamicMainAction(
  action:Pick<ReviewedGitHubAction,'repository'|'repositoryId'|'workflowId'|'workflowPath'|'type'>,
  ref:unknown,planName?:string,
):boolean {
  if(ref!==DYNAMIC_MAIN_REF||!WORKFLOW.test(action.workflowPath)||
    typeof action.repository!=='string'||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.repository)||
    action.repository.includes('..')||
    !Number.isSafeInteger(action.repositoryId)||action.repositoryId<=0||
    !Number.isSafeInteger(action.workflowId)||action.workflowId<=0||
    (action.type!=='task'&&action.type!=='session'))return false;
  return true;
}

/** A historical immutable Tag is not a new admission, including inside foreach. */
export function hasHistoricalTaggedGitHubAction(plan:unknown):boolean {
  if(!plan||typeof plan!=='object'||!Array.isArray((plan as {steps?:unknown}).steps))return false;
  const tagged=(step:unknown):boolean=>{
    if(!step||typeof step!=='object')return false;
    const body=step as {with?:unknown};
    const withData=body.with;
    if(withData&&typeof withData==='object'){
      const action=(withData as {action?:unknown}).action;
      const ref=action&&typeof action==='object'?(action as {ref?:unknown}).ref:undefined;
      if(typeof ref==='string'&&ref.startsWith('refs/tags/'))return true;
      const template=(withData as {template?:unknown}).template;
      if(template&&typeof template==='object'){
        if(tagged(template))return true;
        const nested=(template as {steps?:unknown}).steps;
        if(Array.isArray(nested)&&nested.some(tagged))return true;
      }
      const templates=(withData as {templates?:unknown}).templates;
      if(Array.isArray(templates)&&templates.some(tagged))return true;
    }
    return false;
  };
  return (plan as {steps:unknown[]}).steps.some(tagged);
}

/** A mutable-branch Attempt must freeze a verified SHA in the existing D1 record. */
export function actionForAttempt(
  published:ReviewedGitHubAction,ref:string,planName:string,resolvedSha:unknown,
):ReviewedGitHubAction|null {
  if(isDynamicMainAction(published,ref,planName)){
    if(typeof resolvedSha!=='string'||!SHA.test(resolvedSha))return null;
    return {...published,commitSha:resolvedSha};
  }
  if(resolvedSha!==null&&resolvedSha!==undefined)return null;
  return ref.startsWith('refs/tags/')?published:null;
}
