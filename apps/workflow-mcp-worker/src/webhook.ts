import {WorkflowService, StateError, type Env} from './store.ts';
import type {Plan} from './plan.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const EVENT_ID=/^[A-Za-z0-9_.:-]{1,96}$/;
const MAX_BYTES=8192;
const response=(status:number,error:string)=>Response.json({error},{status,headers:{'cache-control':'no-store'}});

async function sha256(value:string):Promise<string>{
  const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(result)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function constantTimeDigestEqual(left:string,right:string):boolean{
  if(!/^[a-f0-9]{64}$/.test(left)||!/^[a-f0-9]{64}$/.test(right))return false;
  let difference=0;
  for(let i=0;i<64;i++)difference|=left.charCodeAt(i)^right.charCodeAt(i);
  return difference===0;
}
async function boundedInputs(request:Request):Promise<Record<string,unknown>|null>{
  const declared=Number(request.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>MAX_BYTES)throw new StateError('payload_too_large');
  const reader=request.body?.getReader();
  if(!reader)return null;
  let length=0;
  const chunks:Uint8Array[]=[];
  try{
    for(;;){
      const next=await reader.read();
      if(next.done)break;
      length+=next.value.byteLength;
      if(length>MAX_BYTES)throw new StateError('payload_too_large');
      chunks.push(next.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const values=raw as Record<string,unknown>;
  if(Object.keys(values).length>32||
     Object.keys(values).some(k=>!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)||
       ['constructor','prototype','__proto__'].includes(k)))return null;
  return values;
}

/** One narrowly scoped bearer credential per published Webhook plan.
 * The Draft/Plan holds only its SHA-256 digest, not the secret. External
 * callers cannot use the owner MCP bearer and cannot forge Cron admission.
 */
export async function handleWorkflowWebhook(request:Request,env:Env):Promise<Response>{
  const path=new URL(request.url).pathname;
  const match=/^\/triggers\/webhook\/([^/]+)$/.exec(path);
  if(!match||!UUID.test(match[1]))return response(404,'not_found');
  if(request.method!=='POST')return response(405,'method_not_allowed');
  if(!env.DB||!env.WORKFLOW)return response(503,'workflow_bindings_missing');
  try{
    const row=await env.DB.prepare(
      'SELECT w.state,w.active_version_id,v.plan FROM workflows w '+
      'JOIN workflow_versions v ON v.id=w.active_version_id WHERE w.id=?'
    ).bind(match[1]).first<{state:string;active_version_id:string;plan:string}>();
    if(!row)return response(404,'not_found');
    let plan:Plan;
    try{plan=JSON.parse(row.plan) as Plan;}catch{return response(503,'published_plan_invalid');}
    const trigger=plan.triggers?.length===1&&plan.triggers[0].type==='webhook'?
      plan.triggers[0]:null;
    if(!trigger)return response(404,'not_found');
    const auth=request.headers.get('authorization');
    if(!auth?.startsWith('Bearer ')||!TOKEN.test(auth.slice(7)))
      return response(401,'unauthorized');
    const actual=await sha256(auth.slice(7));
    if(!constantTimeDigestEqual(actual,trigger.token_sha256))
      return response(401,'unauthorized');
    if(row.state!=='active')return response(409,'workflow_not_active');
    const eventId=request.headers.get('x-workflow-event-id');
    if(eventId!==null&&!EVENT_ID.test(eventId))return response(400,'invalid_event_id');
    const type=request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase();
    if(type!=='application/json')return response(415,'invalid_content_type');
    let inputs:Record<string,unknown>|null;
    try{inputs=await boundedInputs(request);}
    catch(error){return response(error instanceof StateError&&error.code==='payload_too_large'?413:400,'invalid_payload');}
    if(!inputs)return response(400,'invalid_payload');
    const defined=plan.inputs??{};
    if(Object.keys(inputs).some(key=>!Object.hasOwn(defined,key)))
      return response(422,'unknown_input');
    const key='webhook-'+(eventId===null?crypto.randomUUID():await sha256(eventId));
    try{
      const started=await new WorkflowService(env).start(match[1],inputs,key,row.active_version_id);
      return Response.json({...started,deduplication:eventId===null?'none':'stable_event_id'},{
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
  }catch{return response(503,'webhook_unavailable');}
}
