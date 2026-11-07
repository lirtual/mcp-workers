import type {ReviewedGitHubAction} from './github-action-review.ts';

export const DYNAMIC_MAIN_REF='refs/heads/main';
const REPOSITORY='lirtual/github-actions';
const REPOSITORY_ID=1430925009;
// Moving main is restricted to this owner repository; Publish and preflight
// additionally require an explicit public declaration in the audited YAML.
const WORKFLOW=/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.ya?ml$/;
const SHA=/^[0-9a-f]{40}$/;

/** Fixed trusted repository, reviewed workflow identity and bounded path. */
export function isDynamicMainAction(
  action:Pick<ReviewedGitHubAction,'repository'|'repositoryId'|'workflowId'|'workflowPath'|'type'>,
  ref:unknown,planName?:string,
):boolean {
  if(ref!==DYNAMIC_MAIN_REF||action.repository!==REPOSITORY||
    action.repositoryId!==REPOSITORY_ID||!WORKFLOW.test(action.workflowPath)||
    !Number.isSafeInteger(action.workflowId)||action.workflowId<=0||
    (action.type!=='task'&&action.type!=='session'))return false;
  return true;
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
