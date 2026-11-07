import {runGenericJsonAction} from './generic-action-executor.ts';
import {runEnvshareAction} from './envshare-action-executor.ts';
import {runDubAction} from './dub-action-executor.ts';
import {runBarkAction} from './bark-action-executor.ts';
import type {Env} from './store.ts';
import type {Plan,Step} from './plan.ts';
import {isRetiredWeixinAction} from './cloudflare-action-contract.ts';
import {inspectPersistedGitHubActionAttempt} from './github-action-attempt-inspection.ts';

type Result={status:'succeeded'|'failed'|'indeterminate';error_code?:string;output?:{status:string}};
// Special business actions retain dedicated security checks. New bounded JSON Actions
// use the reviewed Provider contract and the same durable one-shot D1 fence.
export async function runPublishedCloudflareAction(
 env:Env,plan:Plan,action:Step,runId:string,
 inspect:typeof inspectPersistedGitHubActionAttempt=inspectPersistedGitHubActionAttempt,
 ctx?:{inputs:Record<string,unknown>;steps:Record<string,{status:string;output?:unknown}>},
):Promise<Result>{
 if(isRetiredWeixinAction(action))return {status:'failed',error_code:'weixin_action_retired'};
 if(plan.cloudflare_action_contracts?.[action.id] &&
   !['bark','dub','envshare','litterbox'].includes(String(action.with.provider)))
   return runGenericJsonAction(env,plan,action,runId,ctx);
 if(action.with.provider==='dub'&&action.with.action==='dub.shorten_url')
   return runDubAction(env,plan,action,runId,ctx);
 if(action.with.provider==='envshare'&&action.with.action==='envshare.share_text')
   return runEnvshareAction(env,plan,action,runId,ctx);
 if(action.with.provider==='bark'&&action.with.action==='bark.send_notification')
   return runBarkAction(env,plan,action,runId,ctx,inspect);
 return {status:'failed',error_code:'cloudflare_action_not_reviewed'};
}
