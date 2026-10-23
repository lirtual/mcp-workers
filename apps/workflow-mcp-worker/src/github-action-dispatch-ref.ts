import type { ReviewedGitHubAction } from './github-action-review.ts';

type Http=(request:Request)=>Promise<Response>;
export type ActionDispatchTarget={ref:string;sha:string};
const REF=/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,190}$/;

/**
 * The GitHub workflow_dispatch endpoint accepts a branch/tag name rather than
 * an immutable commit SHA. Resolve the server-selected ref immediately prior
 * to dispatch and compare its effective commit to the reviewed source.
 * A positive result is NOT sufficient to authorize the physical job: OIDC
 * and actual run head_sha must also match the approved SHA.
 */
export async function verifyActionDispatchRef(
 action:ReviewedGitHubAction,ref:string,token:string,
 http:Http=fetch,
):Promise<ActionDispatchTarget>{
 if(!REF.test(ref)||ref.includes('..')||ref.includes('//')||
    ref.endsWith('/')||!token?.trim()||
    !/^[a-f0-9]{40}$/i.test(action.commitSha)||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(action.repository))
  throw Error('github_action_ref_invalid');
 const path=ref.slice('refs/'.length);
 const req=new Request('https://api.github.com/repos/'+action.repository+'/git/ref/'+path,{
  redirect:'manual',headers:{accept:'application/vnd.github+json',authorization:'Bearer '+token,
   'user-agent':'workflow-mcp-action-ref','x-github-api-version':'2026-03-10'},
 });
 let resp:Response;
 try{resp=await http(req);}catch{throw Error('github_action_ref_unconfirmed');}
 if(resp.status!==200)throw Error('github_action_ref_unconfirmed');
 let json:unknown;
 try{const body=await resp.text();if(body.length>16384)throw Error('oversized');json=JSON.parse(body);}
 catch{throw Error('github_action_ref_unconfirmed');}
 const obj=json as {ref?:unknown;object?:{sha?:unknown;type?:unknown}};
 if(obj?.ref!==ref || obj.object?.type!=='commit' || obj.object.sha!==action.commitSha)
   throw Error('github_action_ref_mismatch');
 return {ref,sha:action.commitSha};
}
