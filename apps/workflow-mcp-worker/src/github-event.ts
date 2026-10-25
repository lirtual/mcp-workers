import {createRemoteJWKSet,jwtVerify,type JWTPayload} from 'jose';
import {WorkflowService,StateError,type Env} from './store.ts';
import type {GithubEventTrigger,Plan} from './plan.ts';

type KeyResolver=Parameters<typeof jwtVerify>[1];
const githubKeys=createRemoteJWKSet(new URL('https://token.actions.githubusercontent.com/.well-known/jwks'));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// All identity fields are GitHub-issued OIDC claims, never unsigned HTTP body data.
const SHA=/^[a-f0-9]{40}$/i;
const NUMBER=/^[1-9][0-9]{0,15}$/;
const response=(status:number,error:string)=>Response.json({error},{status,headers:{'cache-control':'no-store'}});

type GithubClaims=JWTPayload&{
  repository?:unknown;repository_id?:unknown;event_name?:unknown;
  workflow_ref?:unknown;ref?:unknown;sha?:unknown;
  run_id?:unknown;run_attempt?:unknown;
};
type SignedPush={
  repository:string;repository_id:number;event:'push';ref:string;
  sha:string;run_id:string;run_attempt:number;
};

/** A GitHub Actions job can bridge a native push to this Worker without
 * reimplementing the business DAG in GitHub Actions or storing a webhook HMAC
 * secret. The signed JWT is bound to one exact repository, branch and YAML.
 */
export async function verifyGithubPushEvent(
  jwt:string,audience:string,trigger:GithubEventTrigger,keys:KeyResolver=githubKeys,
):Promise<SignedPush|null>{
  if(!jwt||jwt.length>8192||!/^workflow-github-[a-z0-9:-]{4,120}$/.test(audience))
    return null;
  let claims:GithubClaims;
  try{
    const verified=await jwtVerify(jwt,keys,{issuer:'https://token.actions.githubusercontent.com',
      audience,algorithms:['RS256'],clockTolerance:'5s',maxTokenAge:'5m'});
    claims=verified.payload as GithubClaims;
  }catch{return null;}
  if(typeof claims.iat!=='number'||typeof claims.exp!=='number'||
    claims.exp-claims.iat>600||trigger.event!=='push')return null;
  if(claims.repository!==trigger.repository||
     claims.repository_id!==String(trigger.repository_id)||
     claims.event_name!=='push'||claims.ref!==trigger.ref||
     claims.workflow_ref!==trigger.repository+'/'+trigger.workflow_path+'@'+trigger.ref||
     typeof claims.sha!=='string'||!SHA.test(claims.sha)||
     typeof claims.run_id!=='string'||!NUMBER.test(claims.run_id)||
     !Number.isSafeInteger(Number(claims.run_id))||
     typeof claims.run_attempt!=='string'||!NUMBER.test(claims.run_attempt)||
     !Number.isSafeInteger(Number(claims.run_attempt)))return null;
  return {repository:trigger.repository,repository_id:trigger.repository_id,
    event:'push',ref:trigger.ref,sha:claims.sha,
    run_id:claims.run_id,run_attempt:Number(claims.run_attempt)};
}

/** Signed GitHub Actions event ingress only. Never accept client-supplied
 * repository/event/sha fields; the verified identity is the entire input.
 */
export async function handleGithubEvent(
  request:Request,env:Env,keys:KeyResolver=githubKeys,
):Promise<Response>{
  const match=/^\/triggers\/github\/([^/]+)$/.exec(new URL(request.url).pathname);
  if(!match||!UUID.test(match[1]))return response(404,'not_found');
  if(request.method!=='POST')return response(405,'method_not_allowed');
  if(!env.DB||!env.WORKFLOW||!env.GITHUB_ACTION_OIDC_AUDIENCE)
    return response(503,'github_event_unavailable');
  // The event payload must be derived from signed claims, not arbitrary JSON.
  if(request.body!==null)return response(400,'unexpected_body');
  const auth=request.headers.get('authorization');
  if(!auth?.startsWith('Bearer ')||auth.length>8300||
     !auth.slice(7)||auth.slice(7).includes(' '))return response(401,'unauthorized');
  try{
    const row=await env.DB.prepare(
      'SELECT w.state,w.active_version_id,v.plan FROM workflows w '+
      'JOIN workflow_versions v ON v.id=w.active_version_id WHERE w.id=?'
    ).bind(match[1]).first<{state:string;active_version_id:string;plan:string}>();
    if(!row)return response(404,'not_found');
    let plan:Plan;
    try{plan=JSON.parse(row.plan) as Plan;}catch{return response(503,'published_plan_invalid');}
    const trigger=plan.triggers?.length===1&&plan.triggers[0].type==='github_event'?
      plan.triggers[0]:null;
    if(!trigger)return response(404,'not_found');
    const signed=await verifyGithubPushEvent(auth.slice(7),env.GITHUB_ACTION_OIDC_AUDIENCE,trigger,keys);
    if(!signed)return response(401,'unauthorized');
    if(row.state!=='active')return response(409,'workflow_not_active');
    const inputs={github:signed};
    // Use GitHub's immutable Actions run identity for logical event replay.
    // Reruns intentionally replay the same admission, not duplicate effects.
    const admissionKey='github-event-'+signed.run_id;
    try{
      const started=await new WorkflowService(env).start(
        match[1],inputs,admissionKey,row.active_version_id);
      return Response.json({...started,deduplication:'github_run_id'},{
        status:'idempotent_replay' in started&&started.idempotent_replay?200:202,
        headers:{'cache-control':'no-store'},
      });
    }catch(error){
      if(error instanceof StateError){
        if(['workflow_not_active','published_version_changed','idempotency_conflict'].includes(error.code))
          return response(409,error.code);
        if(error.code==='run_capacity_exceeded')return response(429,error.code);
      }
      return response(503,'admission_unavailable');
    }
  }catch{return response(503,'github_event_unavailable');}
}
