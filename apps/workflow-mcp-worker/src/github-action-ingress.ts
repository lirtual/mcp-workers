import type {Env} from './store.ts';
import {verifyAndClaimPinnedGitHubAction} from './github-action-oidc-claim.ts';
import type {jwtVerify} from 'jose';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type KeyResolver=Parameters<typeof jwtVerify>[1];
const result=(status:number,code:string)=>Response.json({result:code},{
 status,headers:{'cache-control':'no-store'},
});

/**
 * Action OIDC is separate from the existing fixed CI executor routes.
 * Its audience is a server-owned identity, never supplied by the caller.
 * A valid signature alone is never enough: Claim rechecks D1 and the
 * immutable Published Plan before its conditional owner update.
 */
export async function handleGithubActionClaimRequest(
 request:Request,env:Env,keys?:KeyResolver,
):Promise<Response>{
 if(new URL(request.url).pathname!=='/github/action/claim')return result(404,'not_found');
 if(request.method!=='POST')return result(405,'method_not_allowed');
 if(!env.DB||!env.GITHUB_ACTION_OIDC_AUDIENCE||
    !/^workflow-github-[a-z0-9:-]{4,120}$/.test(env.GITHUB_ACTION_OIDC_AUDIENCE))
   return result(503,'action_claim_unavailable');
 const authorization=request.headers.get('authorization')||'';
 if(!authorization.startsWith('Bearer ')||authorization.length>8300)
   return result(401,'unauthorized');
 const credential=authorization.slice(7);
 if(!credential||credential.includes(' ')||credential.length>8192)
   return result(401,'unauthorized');
 const declared=Number(request.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>8192)return result(413,'too_large');
 let attemptId:string;
 try{
  const bytes=await request.arrayBuffer();
  if(bytes.byteLength>8192)return result(413,'too_large');
  const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||
     Object.keys(raw).length!==1||!Object.hasOwn(raw,'attemptId'))
    return result(400,'invalid_request');
  const id=(raw as {attemptId?:unknown}).attemptId;
  if(typeof id!=='string'||!UUID.test(id))return result(400,'invalid_request');
  attemptId=id;
 }catch{return result(400,'invalid_request');}
 try{
  const verified=keys
   ?await verifyAndClaimPinnedGitHubAction(env.DB,attemptId,credential,env.GITHUB_ACTION_OIDC_AUDIENCE,keys)
   :await verifyAndClaimPinnedGitHubAction(env.DB,attemptId,credential,env.GITHUB_ACTION_OIDC_AUDIENCE);
  return verified?result(200,'claimed'):result(403,'claim_denied');
 }catch{return result(503,'unavailable');}
}
