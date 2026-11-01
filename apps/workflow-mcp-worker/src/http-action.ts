import type {Plan,Step} from './plan.ts';
import type {Env} from './store.ts';

// One source-reviewed transport. Targets are immutable literals in the Draft
// and separately approved verbatim by the owner at Publish time.
export type HttpOperation={url:string;method:'GET'|'HEAD'|'POST'};
const forbiddenHost=/(?:^|\.)(?:localhost|localdomain|local|internal|lan|corp|home|test|invalid|onion)$/i;
const hostname=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
const size=(v:string)=>new TextEncoder().encode(v).byteLength;
export function approvedHttpTarget(raw:unknown):URL{
  if(typeof raw!=='string'||raw.length>1024||/[^\x21-\x7e]/.test(raw))throw Error('http_invalid_target');
  let u:URL;
  try{u=new URL(raw);}catch{throw Error('http_invalid_target');}
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||
     !hostname.test(u.hostname)||forbiddenHost.test(u.hostname)||
     /^\d+(?:\.\d+)*$/.test(u.hostname)||u.hostname.endsWith('.')||
     u.hostname.includes('..')||u.hostname.includes('%')||u.pathname.includes('%')||
     u.href!==raw)throw Error('http_unsafe_target');
  return u;
}
export function httpOperation(withData:Record<string,unknown>):HttpOperation{
  const url=approvedHttpTarget(withData.url).href;
  if(withData.method!=='GET'&&withData.method!=='HEAD'&&withData.method!=='POST')
    throw Error('http_invalid_method');
  return {url,method:withData.method};
}
const HTTP_TIMEOUT_MS=12000;
const HTTP_MAX_RESPONSE=8192;
export class HttpDispatchError extends Error{
  readonly code:string;readonly uncertain:boolean;
  constructor(code:string,uncertain:boolean){super(code);this.code=code;this.uncertain=uncertain;}
}
type Db=Env['DB'];
export async function callApprovedHttp(
  db:Db,plan:Plan,step:Step,runId:string,
  evaluatedBody:unknown,outbound:typeof fetch=fetch,
):Promise<{status:number;ok:boolean;body:string;truncated:boolean}>{
  let operation:HttpOperation;
  try{operation=httpOperation(step.with);}catch{throw new HttpDispatchError('http_invalid_target',false);}
  if(!plan.http_approvals?.some(x=>x.url===operation.url&&x.method===operation.method)||
     plan.http_execution_approved!==true)
    throw new HttpDispatchError('http_approval_missing',false);
  const hasBody=Object.hasOwn(step.with,'body');
  if((operation.method==='GET'||operation.method==='HEAD')&&hasBody)
    throw new HttpDispatchError('http_invalid_body',false);
  let body:string|undefined;
  if(hasBody){
    try{body=JSON.stringify(evaluatedBody);}catch{throw new HttpDispatchError('http_invalid_body',false);}
    if(!body||size(body)>4096)throw new HttpDispatchError('http_invalid_body',false);
  }
  if(!Number.isSafeInteger(plan.http_connection_generation)||
     Number(plan.http_connection_generation)<0)
    throw new HttpDispatchError('http_authorization_unavailable',false);
  // Reuse the existing unique Run/Step external-effect reservation, while
  // independently checking the HTTP Connection generation in one D1 INSERT.
  // Revoke and dispatch serialize; a losing revoke cannot undo a sent request.
  const fence=await db.prepare(`INSERT INTO mcp_dispatch_fences
    (run_id,step_id,generation,created_at)
    SELECT ?,?,?,? WHERE EXISTS (
      SELECT 1 FROM http_connection_auth WHERE id='http'
        AND state='enabled' AND generation=?
    ) AND EXISTS (
      SELECT 1 FROM runs r WHERE r.id=? AND r.outcome='running'
    ) ON CONFLICT(run_id,step_id) DO NOTHING`)
    .bind(runId,step.id,plan.http_connection_generation,Date.now(),
      plan.http_connection_generation,runId).run();
  if(fence.meta.changes!==1){
    const prior=await db.prepare('SELECT 1 AS reserved FROM mcp_dispatch_fences WHERE run_id=? AND step_id=?')
      .bind(runId,step.id).first<{reserved:number}>();
    throw new HttpDispatchError(prior?'http_dispatch_unconfirmed':'http_dispatch_not_authorized',!!prior);
  }
  // At this point a replay MUST NOT reissue the external request.
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),HTTP_TIMEOUT_MS);
  try{
    const response=await outbound(operation.url,{method:operation.method,redirect:'manual',
      headers:body===undefined?undefined:{'content-type':'application/json'},
      body,signal:controller.signal});
    // Workers manual redirects return a response; NEVER follow or leak body
    // or credentials to a redirect target, even if same-origin.
    if(response.status>=300&&response.status<400){
      void response.body?.cancel().catch(()=>{});
      throw new HttpDispatchError('http_redirect_rejected',operation.method==='POST');
    }
    if(!response.body)
      return {status:response.status,ok:response.ok,body:'',truncated:false};
    const reader=response.body.getReader();
    let total=0,truncated=false;
    const chunks:Uint8Array[]=[];
    try{
      while(true){
        const next=await (async()=>{
          if(controller.signal.aborted)throw Error('aborted');
          let abort!:()=>void;
          const cancelled=new Promise<never>((_,reject)=>{
            abort=()=>reject(Error('aborted'));
            controller.signal.addEventListener('abort',abort,{once:true});
          });
          try{return await Promise.race([reader.read(),cancelled]);}
          finally{controller.signal.removeEventListener('abort',abort);}
        })();
        if(next.done)break;
        if(total+next.value.byteLength>HTTP_MAX_RESPONSE){
          const remaining=HTTP_MAX_RESPONSE-total;
          if(remaining>0)chunks.push(next.value.subarray(0,remaining));
          total=HTTP_MAX_RESPONSE;truncated=true;break;
        }
        total+=next.value.byteLength;chunks.push(next.value);
      }
    }finally{
      if(truncated||controller.signal.aborted)void reader.cancel().catch(()=>{});
      else reader.releaseLock();
    }
    const bytes=new Uint8Array(total);let pos=0;
    for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
    return {status:response.status,ok:response.ok,
      body:operation.method==='HEAD'?'':new TextDecoder().decode(bytes),truncated};
  }catch(error){
    if(error instanceof HttpDispatchError)throw error;
    // Aborted, lost response and transport failures cannot prove whether an
    // upstream POST was committed. Preserve uncertainty for every method.
    throw new HttpDispatchError('http_outcome_unknown',true);
  }finally{clearTimeout(timer);}
}
