import type {Env} from './store.ts';
import type {Plan} from './plan.ts';
import {EVENT_WAIT_UUID,EVENT_WAIT_ID,EVENT_WAIT_BEARER,
  constantTimeDigestEqual,sha256,payloadDigest,eventTypeForStep} from './event-wait.ts';

const MAX_EVENT_BYTES=8192;
const fail=(status:number,error:string)=>Response.json({error},{status,headers:{'cache-control':'no-store'}});

async function boundedEventPayload(request:Request):Promise<Record<string,unknown>>{
  const claimed=Number(request.headers.get('content-length'));
  if(Number.isFinite(claimed)&&claimed>MAX_EVENT_BYTES)throw Error('payload_too_large');
  const reader=request.body?.getReader();
  if(!reader)throw Error('invalid_payload');
  const buffers:Uint8Array[]=[];
  let length=0;
  try{
    for(;;){
      const part=await reader.read();
      if(part.done)break;
      length+=part.value.byteLength;
      if(length>MAX_EVENT_BYTES)throw Error('payload_too_large');
      buffers.push(part.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);
  let offset=0;
  for(const part of buffers){bytes.set(part,offset);offset+=part.byteLength;}
  const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('invalid_payload');
  const data=parsed as Record<string,unknown>;
  if(Object.keys(data).length>32||
    Object.keys(data).some(k=>!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k)||
    ['constructor','prototype','__proto__'].includes(k)))throw Error('invalid_payload');
  return data;
}

/** Signal an existing immutable Run/Step only; no new Run or implicit grant. */
export async function handleWaitEvent(request:Request,env:Env):Promise<Response>{
  const parts=/^\/events\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
  if(!parts||!EVENT_WAIT_UUID.test(parts[1])||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(parts[2]))return fail(404,'not_found');
  if(request.method!=='POST')return fail(405,'method_not_allowed');
  if(!env.DB||!env.WORKFLOW)return fail(503,'workflow_bindings_missing');
  try{
    const row=await env.DB.prepare(`SELECT r.id,r.instance_id,r.outcome,r.start_state,
      v.plan FROM runs r JOIN workflow_versions v ON v.id=r.version_id
      WHERE r.id=?`).bind(parts[1])
      .first<{id:string;instance_id:string;outcome:string;start_state:string;plan:string}>();
    if(!row)return fail(404,'not_found');
    let plan:Plan;
    try{plan=JSON.parse(row.plan) as Plan;}catch{return fail(503,'published_plan_invalid');}
    const selected=plan.steps.find(s=>s.id===parts[2]&&s.uses==='flow.wait_event');
    const digest=selected?.with.token_sha256;
    if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))return fail(404,'not_found');
    const bearer=request.headers.get('authorization');
    if(!bearer?.startsWith('Bearer ')||!EVENT_WAIT_BEARER.test(bearer.slice(7)))return fail(401,'unauthorized');
    if(!constantTimeDigestEqual(await sha256(bearer.slice(7)),digest))return fail(401,'unauthorized');

    const eventId=request.headers.get('x-workflow-event-id');
    if(!eventId||!EVENT_WAIT_ID.test(eventId))return fail(400,'invalid_event_id');
    if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')
      return fail(415,'invalid_content_type');
    let data:Record<string,unknown>;
    try{data=await boundedEventPayload(request);}
    catch(e){return fail(e instanceof Error&&e.message==='payload_too_large'?413:400,'invalid_payload');}
    const digestOfPayload=await payloadDigest(data);
    const recorded=await env.DB.prepare(`INSERT OR IGNORE INTO wait_event_receipts
      (run_id,step_id,event_id,payload_digest,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM runs
        WHERE id=? AND outcome IN ('queued','running') AND start_state='started')`)
      .bind(parts[1],parts[2],eventId,digestOfPayload,Date.now(),parts[1]).run();
    const receipt=await env.DB.prepare(`SELECT event_id,payload_digest,last_sent_at
      FROM wait_event_receipts WHERE run_id=? AND step_id=?`)
      .bind(parts[1],parts[2])
      .first<{event_id:string;payload_digest:string;last_sent_at:number|null}>();
    if(!receipt)return fail(409,'run_not_active');
    if(receipt.event_id!==eventId||receipt.payload_digest!==digestOfPayload)
      return fail(409,'event_conflict');
    const current=await env.DB.prepare(`SELECT r.outcome,s.status AS step_status FROM runs r
      LEFT JOIN run_steps s ON s.run_id=r.id AND s.step_id=?
      WHERE r.id=?`).bind(parts[2],parts[1])
      .first<{outcome:string;step_status:string|null}>();
    if(current?.step_status==='succeeded'&&receipt.last_sent_at!==null)
      return Response.json({delivery:'completed',idempotent_replay:true},{status:200,headers:{'cache-control':'no-store'}});
    if(!current||!['queued','running'].includes(current.outcome)||
      (current.step_status!==null&&current.step_status!=='waiting'))
      return fail(409,'run_not_active');
    if(receipt.last_sent_at!==null)
      return Response.json({delivery:'acknowledged',idempotent_replay:true},{status:200,headers:{'cache-control':'no-store'}});
    // Lost sendEvent ACK is an unknown delivery, not evidence of non-delivery.
    // The SAME event may be resent. Only one native wait matches this type.
    try{
      const instance=await env.WORKFLOW.get(row.instance_id);
      if(!instance.sendEvent)throw Error('native_send_unavailable');
      await instance.sendEvent({type:eventTypeForStep(parts[2]),payload:{event_id:eventId,data}});
      await env.DB.prepare(`UPDATE wait_event_receipts SET last_sent_at=?
        WHERE run_id=? AND step_id=? AND last_sent_at IS NULL`)
        .bind(Date.now(),parts[1],parts[2]).run();
      return Response.json({delivery:'acknowledged',idempotent_replay:false},
        {status:202,headers:{'cache-control':'no-store'}});
    }catch{
      return Response.json({delivery:'unconfirmed',retry:'same_event_id_and_payload'},
        {status:503,headers:{'cache-control':'no-store'}});
    }
  }catch{return fail(503,'event_ingress_unavailable');}
}
