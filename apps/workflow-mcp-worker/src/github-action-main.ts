import type {ReviewedGitHubAction} from './github-action-review.ts';

export const DYNAMIC_MAIN_REF='refs/heads/main';
const REPOSITORY='lirtual/github-actions';
const REPOSITORY_ID=1430925009;
// Narrow owner-approved capability: no other repository, workflow, or branch
// can opt into moving-source execution.
const WORKFLOWS:Record<string,{id:number;type:'session'|'task'}>={
  '.github/workflows/windows.yml':{id:394689662,type:'session'},
  '.github/workflows/ubuntu.yml':{id:395929968,type:'session'},
  '.github/workflows/chrome.yml':{id:394689653,type:'session'},
  '.github/workflows/code-server.yml':{id:394689654,type:'session'},
  '.github/workflows/download.yml':{id:401335372,type:'task'},
};
const SHA=/^[0-9a-f]{40}$/;

/** Only the five named owner Workflows may use the live main branch. */
export function isDynamicMainAction(
  action:Pick<ReviewedGitHubAction,'repository'|'repositoryId'|'workflowId'|'workflowPath'|'type'>,
  ref:unknown,planName?:string,
):boolean {
  const approved=WORKFLOWS[action.workflowPath];
  const name=action.workflowPath.slice('.github/workflows/'.length,-'.yml'.length);
  return ref===DYNAMIC_MAIN_REF&&action.repository===REPOSITORY&&
    action.repositoryId===REPOSITORY_ID&&!!approved&&
    action.workflowId===approved.id&&action.type===approved.type&&
    (planName===undefined||planName===name);
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
