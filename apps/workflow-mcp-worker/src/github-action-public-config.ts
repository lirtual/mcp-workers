import type {Env} from './store.ts';

// Public, non-secret OIDC audience discovery. It does not grant GitHub
// execution, validate callers, or replace the signed, D1-fenced Claim.
export function handleGithubActionPublicConfig(request:Request,env:Env):Response{
 const headers={'cache-control':'no-store'};
 if(request.method!=='GET')return Response.json({error:'method_not_allowed'},{status:405,headers});
 const audience=env.WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE;
 if(!audience||!/^workflow-github-[a-z0-9:-]{4,120}$/.test(audience))
   return Response.json({error:'action_claim_unavailable'},{status:503,headers});
 return Response.json({audience},{headers});
}
