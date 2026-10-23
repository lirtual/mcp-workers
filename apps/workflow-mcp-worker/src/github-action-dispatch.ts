import type {ReviewedGitHubAction} from './github-action-review.ts';
import {verifyActionDispatchRef} from './github-action-dispatch-ref.ts';
import type {DispatchOutcome} from './github-dispatch.ts';

type Http=(request:Request)=>Promise<Response>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One POST after a pinned-ref read. Never retry ambiguous dispatch ACKs.
 * This primitive is NOT a public execution route: D1 admission, persisted
 * publication and a verified OIDC claim remain mandatory at the caller.
 */
export async function dispatchReviewedGitHubAction(
 action:ReviewedGitHubAction,ref:string,token:string,
 attempt:{attemptId:string;dispatchId:string},inputs:Record<string,string>,
 http:Http=fetch,
):Promise<DispatchOutcome>{
 if(!UUID.test(attempt.attemptId)||!UUID.test(attempt.dispatchId)||
    !Number.isSafeInteger(action.workflowId)||action.workflowId<=0||
    !inputs||typeof inputs!=='object'||Array.isArray(inputs)||
    Object.keys(inputs).length>10||
    Object.entries(inputs).some(([k,v])=>!(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k))||
       k.toLowerCase().startsWith('workflow_')||
       ['attempt_id','dispatch_id','capability_id'].includes(k.toLowerCase())||
       typeof v!=='string'||new TextEncoder().encode(v).length>4096))
   throw Error('github_action_dispatch_invalid');
 await verifyActionDispatchRef(action,ref,token,http);
 const body=JSON.stringify({ref:ref.slice(ref.indexOf('/',5)+1),return_run_details:true,
   inputs:{...inputs,attempt_id:attempt.attemptId,dispatch_id:attempt.dispatchId,
     capability_id:'github.action'}});
 let response:Response;
 try{
  response=await http(new Request('https://api.github.com/repos/'+action.repository+
    '/actions/workflows/'+action.workflowId+'/dispatches',{
   method:'POST',redirect:'manual',headers:{
    accept:'application/vnd.github+json',authorization:'Bearer '+token,
    'content-type':'application/json','user-agent':'workflow-mcp-action-dispatch',
    'x-github-api-version':'2026-03-10'},body,
  }));
 }catch{return {status:'dispatch_unknown'};}
 if([400,401,403,404,422].includes(response.status))
  return {status:'rejected',httpStatus:response.status as 400|401|403|404|422,reason:'unknown'};
 if(response.status!==200)return {status:'dispatch_unknown'};
 try{
  const text=await response.text();
  if(text.length>16384)return {status:'dispatch_unknown'};
  const parsed=JSON.parse(text) as {workflow_run_id?:unknown};
  if(Number.isSafeInteger(parsed.workflow_run_id)&&
     typeof parsed.workflow_run_id==='number'&&parsed.workflow_run_id>0)
   return {status:'confirmed',runId:parsed.workflow_run_id,runAttempt:1};
 }catch{}
 return {status:'dispatch_unknown'};
}
