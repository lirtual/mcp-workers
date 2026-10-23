import { GITHUB_TRIGGER_EVENTS, isConfiguredSecret } from './capabilities.ts';
import { WorkflowService, StateError } from './store.ts';
import type { Env } from './store.ts';

const MAX_BODY=8192;
const EVENT_ID=/^[A-Za-z0-9_-]{1,128}$/;
const ROUTE=/^\/triggers\/(webhook|github)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const json=(status:number,body:unknown)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const fail=(status:number,error:string)=>json(status,{error});

function statusFor(code:string):number{
  switch(code){
    case 'invalid_event_id':
    case 'invalid_input':
    case 'invalid_request':
    case 'invalid_id': return 400;
    case 'unauthorized_source':
    case 'unauthorized_event': return 403;
    case 'workflow_not_found': return 404;
    case 'workflow_not_active':
    case 'idempotency_conflict':
    case 'published_version_changed': return 409;
    case 'run_capacity_exceeded': return 429;
    case 'trigger_not_configured':
    case 'workflow_bindings_missing':
    case 'version_missing': return 503;
    default: return 503;
  }
}

async function hmacMatches(secret:string, body:Uint8Array, header:string|null):Promise<boolean>{
  if(!header?.startsWith('sha256='))return false;
  const hex=header.slice('sha256='.length);
  if(!/^[0-9a-f]{64}$/i.test(hex))return false;
  const signature=new Uint8Array(32);
  for(let index=0; index<32; index++)signature[index]=Number.parseInt(hex.slice(index*2,index*2+2),16);
  const payload=new ArrayBuffer(body.byteLength);
  new Uint8Array(payload).set(body);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,signature,payload);
}

function stableEventId(value:string|null):string|null{
  if(value===null)return null;
  if(!EVENT_ID.test(value))throw new StateError('invalid_event_id');
  return value;
}

// Authenticated webhook and GitHub deliveries normalize into Run admission.
// GitHub Action claim/callback stays a separate executor path.
export async function handleTriggerRequest(request:Request, env:Env):Promise<Response>{
  const match=new URL(request.url).pathname.match(ROUTE);
  if(!match)return fail(404,'not_found');
  if(request.method!=='POST')return fail(405,'method_not_allowed');
  const kind=match[1]==='github'?'github_event':'webhook';
  const workflowId=match[2];
  if(!env.DB||!env.WORKFLOW)return fail(503,'workflow_bindings_missing');
  const secret=kind==='webhook'?env.WEBHOOK_TRIGGER_SECRET:env.GITHUB_WEBHOOK_SECRET;
  const sourceReady=kind==='webhook'
    ?Boolean(env.WEBHOOK_TRIGGER_SOURCE)
    :Boolean(env.GITHUB_EXECUTOR_REPOSITORY);
  if(!isConfiguredSecret(secret)||!sourceReady)return fail(503,'trigger_not_configured');
  const contentType=request.headers.get('content-type')??'';
  if(!contentType.startsWith('application/json'))return fail(400,'invalid_request');
  if((Number(request.headers.get('content-length'))||0)>MAX_BODY)return fail(413,'too_large');
  const bytes=new Uint8Array(await request.arrayBuffer());
  if(bytes.byteLength>MAX_BODY)return fail(413,'too_large');
  const signatureHeader=kind==='webhook'
    ?request.headers.get('x-workflow-signature-256')
    :request.headers.get('x-hub-signature-256');
  if(!await hmacMatches(secret,bytes,signatureHeader))return fail(401,'invalid_signature');
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{return fail(400,'invalid_request');}
  if(text.includes(secret))return fail(400,'invalid_input');
  let payload:unknown;
  try{payload=JSON.parse(text);}catch{return fail(400,'invalid_request');}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return fail(400,'invalid_input');
  const record=payload as Record<string,unknown>;
  if(['__proto__','constructor','prototype'].some(key=>Object.hasOwn(record,key)))return fail(400,'invalid_input');
  try{
    const eventName=kind==='webhook'?request.headers.get('x-workflow-event'):request.headers.get('x-github-event');
    if(!eventName||!/^[a-z][a-z0-9_]{0,63}$/.test(eventName))throw new StateError('invalid_request');
    const eventId=stableEventId(kind==='webhook'?request.headers.get('x-workflow-event-id'):request.headers.get('x-github-delivery'));
    let source=env.WEBHOOK_TRIGGER_SOURCE??'';
    if(kind==='github_event'){
      if(!(GITHUB_TRIGGER_EVENTS as readonly string[]).includes(eventName))throw new StateError('unauthorized_event');
      const repository=record.repository;
      const fullName=repository&&typeof repository==='object'&&!Array.isArray(repository)
        ?(repository as Record<string,unknown>).full_name:undefined;
      if(typeof fullName!=='string')throw new StateError('unauthorized_source');
      source=fullName;
    }
    const admitted=await new WorkflowService(env).admitEvent(workflowId,{
      kind,event:eventName,event_id:eventId,source,payload:record,
    });
    return json(200,admitted);
  }catch(error){
    if(!(error instanceof StateError))return fail(503,'unavailable');
    const status=statusFor(error.code);
    const hidden=status===503&&!['trigger_not_configured','workflow_bindings_missing','version_missing'].includes(error.code);
    return fail(status,hidden?'unavailable':error.code);
  }
}
