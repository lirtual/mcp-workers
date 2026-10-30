import {observeInstance} from './instance-observation.ts';
import {cancelAwaitedChild} from './child-cancel.ts';
import type {Env} from './store.ts';

/** One Cloudflare Workflow owns both awaited and detached child execution.
 * Children use their own immutable Plan and deterministic native identity;
 * awaited children transfer capacity and detached children reserve separately.
 */
/** Stable UUID for one awaited child path. Never derive from current time,
 * mutable input values, retries or an untrusted external ID.
 */
export async function awaitedChildRunId(parentRunId:string,stepId:string):Promise<string>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parentRunId)||
     !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(stepId))
    throw Error('invalid_child_identity');
  const key=new TextEncoder().encode('workflow-child:v1:'+parentRunId.toLowerCase()+':'+stepId);
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',key)).slice(0,16);
  // RFC UUID variant and version 8 (custom SHA-256-derived identity), distinct
  // from ordinary random version-4 top-level Run IDs.
  bytes[6]=(bytes[6]!&15)|0x80;
  bytes[8]=(bytes[8]!&63)|0x80;
  const hex=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),
    hex.slice(16,20),hex.slice(20)].join('-');
}

export const RUN_CAPACITY_LIMIT = 8;
export const ACTIVE_CAPACITY_UNITS_SQL =
  "(SELECT COALESCE(SUM(capacity_weight),0) FROM runs WHERE outcome IN ('queued','running'))";

/** SQL predicate for an atomic D1 admission INSERT ... SELECT.
 * A normal Run costs one unit, an awaited parent reserves two units.
 * No global reduction of the existing eight ordinary Run slots.
 */
export function capacityAdmissionPredicate(weight:1|2):string{
  if(weight!==1&&weight!==2)throw Error('invalid_run_capacity_weight');
  return ACTIVE_CAPACITY_UNITS_SQL+' <= '+(RUN_CAPACITY_LIMIT-weight);
}

type ChildReservation={
  parentRunId:string;
  parentStepId:string;
  childRunId:string;
  childWorkflowId:string;
  childVersionId:string;
  admissionKey:string;
  requestDigest:string;
  inputJson:string;
  timestamp:number;
};
type ChildRow={
  id:string;workflow_id:string;version_id:string;parent_run_id:string|null;
  parent_step_id:string|null;admission_key:string|null;request_digest:string;
  inputs:string;capacity_weight:number;
};

/**
 * Transfer one unit from the previously reserved parent (2 -> 1), creating
 * exactly one child (weight 1) in the same atomic D1 transaction.
 *
 * The child remains unstarted: the future runner must first freeze the
 * published child inputs, then call the existing native-create/reconciliation
 * path with this deterministic identity. It must NOT re-dispatch if unknown.
 * The parent's pending reservation cannot be used by a recursive child.
 */
export async function transferAwaitedChildCapacity(
  db:Pick<D1Database,'prepare'|'batch'>,args:ChildReservation,
):Promise<{childRunId:string;alreadyReserved:boolean}>{
  if(!args.parentRunId||!args.parentStepId||!args.childRunId||
     args.parentRunId===args.childRunId||!args.childWorkflowId||
     !args.childVersionId||!args.admissionKey||!args.requestDigest||
     !args.inputJson||!Number.isSafeInteger(args.timestamp))
    throw Error('invalid_child_capacity_request');
  const inserted=await db.batch([
    db.prepare(`INSERT OR IGNORE INTO runs
      (id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,
       start_state,outcome,created_at,updated_at,capacity_weight,parent_run_id,parent_step_id)
      SELECT ?,c.id,v.id,?,?,?,?,'reserved','queued',?,?,1,p.id,?
      FROM runs p JOIN workflows c ON c.id=?
      JOIN workflow_versions v ON v.id=? AND v.workflow_id=c.id
      WHERE p.id=? AND p.outcome='running' AND p.capacity_weight=2
        AND p.parent_run_id IS NULL
        AND p.workflow_id!=c.id
        AND c.state='active' AND c.active_version_id=v.id`)
      .bind(args.childRunId,args.childRunId,args.admissionKey,
        args.requestDigest,args.inputJson,args.timestamp,args.timestamp,
        args.parentStepId,args.childWorkflowId,args.childVersionId,args.parentRunId),
    db.prepare(`UPDATE runs SET capacity_weight=1,updated_at=?
      WHERE id=? AND outcome='running' AND capacity_weight=2
      AND EXISTS(SELECT 1 FROM runs c WHERE c.id=? AND
        c.parent_run_id=? AND c.parent_step_id=? AND
        c.version_id=? AND c.workflow_id=? AND
        c.request_digest=? AND c.inputs=?)`)
      .bind(args.timestamp,args.parentRunId,args.childRunId,args.parentRunId,
        args.parentStepId,args.childVersionId,args.childWorkflowId,
        args.requestDigest,args.inputJson),
  ]);
  const child=await db.prepare(`SELECT id,workflow_id,version_id,parent_run_id,
    parent_step_id,admission_key,request_digest,inputs,capacity_weight
    FROM runs WHERE parent_run_id=? AND parent_step_id=?`)
    .bind(args.parentRunId,args.parentStepId).first<ChildRow>();
  const parent=await db.prepare('SELECT outcome,capacity_weight FROM runs WHERE id=?')
    .bind(args.parentRunId).first<{outcome:string;capacity_weight:number}>();
  if(!child||!parent||parent.outcome!=='running'||parent.capacity_weight!==1||
     child.id!==args.childRunId||child.workflow_id!==args.childWorkflowId||
     child.version_id!==args.childVersionId||child.parent_run_id!==args.parentRunId||
     child.parent_step_id!==args.parentStepId||
     child.admission_key!==args.admissionKey||
     child.request_digest!==args.requestDigest||child.inputs!==args.inputJson||
     child.capacity_weight!==1)
    throw Error('child_capacity_transfer_rejected');
  return {childRunId:child.id,alreadyReserved:!inserted[0]?.meta?.changes};
}

/** Independent capacity for an explicitly detached child. Parent keeps its
 * own slot; no reservation transfer or borrowed child capacity is possible.
 * The deterministic identity and immutable target still enforce replay safety.
 */
export async function admitDetachedChild(
  db:Pick<D1Database,'prepare'>,args:ChildReservation,
):Promise<{childRunId:string;alreadyReserved:boolean}>{
  if(!args.parentRunId||!args.parentStepId||!args.childRunId||
     args.parentRunId===args.childRunId||!args.childWorkflowId||
     !args.childVersionId||!args.admissionKey||!args.requestDigest||
     !args.inputJson||!Number.isSafeInteger(args.timestamp))
    throw Error('invalid_detached_child_request');
  const inserted=await db.prepare(`INSERT OR IGNORE INTO runs
    (id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,
     start_state,outcome,created_at,updated_at,capacity_weight,parent_run_id,parent_step_id)
    SELECT ?,c.id,v.id,?,?,?,?,'reserved','queued',?,?,1,p.id,?
    FROM runs p JOIN workflows c ON c.id=?
    JOIN workflow_versions v ON v.id=? AND v.workflow_id=c.id
    WHERE p.id=? AND p.outcome='running' AND p.capacity_weight=1
      AND p.parent_run_id IS NULL AND p.workflow_id!=c.id
      AND c.state='active' AND c.active_version_id=v.id
      AND ${capacityAdmissionPredicate(1)}`)
    .bind(args.childRunId,args.childRunId,args.admissionKey,
      args.requestDigest,args.inputJson,args.timestamp,args.timestamp,
      args.parentStepId,args.childWorkflowId,args.childVersionId,args.parentRunId).run();
  const child=await db.prepare(`SELECT id,workflow_id,version_id,parent_run_id,
    parent_step_id,admission_key,request_digest,inputs,capacity_weight
    FROM runs WHERE parent_run_id=? AND parent_step_id=?`)
    .bind(args.parentRunId,args.parentStepId).first<ChildRow>();
  if(!child||child.id!==args.childRunId||child.workflow_id!==args.childWorkflowId||
     child.version_id!==args.childVersionId||child.parent_run_id!==args.parentRunId||
     child.parent_step_id!==args.parentStepId||child.admission_key!==args.admissionKey||
     child.request_digest!==args.requestDigest||child.inputs!==args.inputJson||
     child.capacity_weight!==1)
    throw Error('detached_child_admission_rejected');
  return {childRunId:child.id,alreadyReserved:!inserted.meta.changes};
}

/** Detached start is independent of parent cancellation after reservation.
 * A lost native ACK is observed but NEVER blindly reissued: Cloudflare may
 * have created the instance even if its acknowledgement was lost.
 */
export async function startReservedDetachedChild(
  env:Pick<Env,'DB'|'WORKFLOW'>,
  args:{parentRunId:string;parentStepId:string;childRunId:string;timestamp:number},
):Promise<{childRunId:string;start_state:'started'|'start_unknown'|'indeterminate'|'rejected'}>{
  const {parentRunId,parentStepId,childRunId,timestamp}=args;
  if(!parentRunId||!parentStepId||!childRunId||!Number.isSafeInteger(timestamp))
    throw Error('invalid_detached_start_request');
  const row=await env.DB.prepare(`SELECT c.start_state,c.outcome,
    c.instance_id,c.capacity_weight,c.created_at,p.outcome AS parent_outcome
    FROM runs c JOIN runs p ON p.id=c.parent_run_id
    WHERE c.id=? AND c.parent_run_id=? AND c.parent_step_id=?`)
    .bind(childRunId,parentRunId,parentStepId)
    .first<{start_state:string;outcome:string;instance_id:string;
      capacity_weight:number;created_at:number;parent_outcome:string}>();
  if(!row||row.instance_id!==childRunId||row.capacity_weight!==1)
    throw Error('detached_child_start_not_authorized');
  if(row.start_state==='started')return {childRunId,start_state:'started'};
  // An undecided native dispatch is never retried. After the same bounded
  // observation window used by awaited children, preserve unknown physical
  // effects as indeterminate rather than leaking a queued D1 capacity slot.
  const expire=async()=>{
    await env.DB.prepare(`UPDATE runs SET outcome='indeterminate',
      error_code='detached_child_start_unconfirmed',updated_at=?
      WHERE id=? AND parent_run_id=? AND parent_step_id=?
      AND start_state IN ('dispatching','start_unknown') AND outcome='queued'`)
      .bind(timestamp,childRunId,parentRunId,parentStepId).run();
    return {childRunId,start_state:'indeterminate' as const};
  };
  const markStarted=async()=>{
    await env.DB.prepare(`UPDATE runs SET start_state='started',updated_at=?
      WHERE id=? AND parent_run_id=? AND parent_step_id=?
      AND start_state IN ('dispatching','start_unknown')
      AND outcome IN ('queued','running','succeeded','failed')`)
      .bind(timestamp,childRunId,parentRunId,parentStepId).run();
    return {childRunId,start_state:'started' as const};
  };
  if(row.start_state!=='reserved'){
    if(!['dispatching','start_unknown'].includes(row.start_state)||
       !['queued','running'].includes(row.outcome))
      return {childRunId,start_state:'indeterminate'};
    const observed=await observeInstance(env.WORKFLOW,childRunId);
    if(observed.kind==='found')return markStarted();
    return timestamp-row.created_at>=10*60_000?expire():
      {childRunId,start_state:'start_unknown'};
  }
  if(row.parent_outcome!=='running'){
    // The parent became terminal before native dispatch: abandon only the
    // still-reserved child; no native effect was authorized.
    await env.DB.prepare(`UPDATE runs SET outcome='failed',
      error_code='detached_parent_not_active',updated_at=?
      WHERE id=? AND start_state='reserved' AND outcome='queued'`)
      .bind(timestamp,childRunId).run();
    return {childRunId,start_state:'rejected'};
  }
  const claim=await env.DB.prepare(`UPDATE runs SET start_state='dispatching',updated_at=?
    WHERE id=? AND parent_run_id=? AND parent_step_id=?
      AND start_state='reserved' AND outcome='queued'
      AND EXISTS(SELECT 1 FROM runs p WHERE p.id=? AND p.outcome='running')`)
    .bind(timestamp,childRunId,parentRunId,parentStepId,parentRunId).run();
  if(claim.meta.changes!==1)return {childRunId,start_state:'start_unknown'};
  try{
    await env.WORKFLOW.create({id:childRunId,params:{run_id:childRunId}});
    return markStarted();
  }catch{
    await env.DB.prepare(`UPDATE runs SET start_state='start_unknown',updated_at=?
      WHERE id=? AND start_state='dispatching' AND outcome IN ('queued','running')`)
      .bind(timestamp,childRunId).run();
    const observed=await observeInstance(env.WORKFLOW,childRunId);
    return observed.kind==='found'?markStarted():{childRunId,start_state:'start_unknown'};
  }
}

/** Only a D1 claim may initiate a native child create. A cancellation of a
 * still-reserved Run wins a compare-and-swap against this claim; once claimed,
 * cancellation is a durable intent and native termination is separately fenced.
 * Every native attempt uses the SAME deterministic child instance ID.
 */
export async function startReservedAwaitedChild(
  env:Pick<Env,'DB'|'WORKFLOW'>,
  args:{parentRunId:string;parentStepId:string;childRunId:string;timestamp:number},
):Promise<{childRunId:string;start_state:'started'|'start_unknown'|'indeterminate'|'cancelled_before_start'}>{
  const {parentRunId,parentStepId,childRunId,timestamp}=args;
  if(!parentRunId||!parentStepId||!childRunId||!Number.isSafeInteger(timestamp))
    throw Error('invalid_child_start_request');
  let row=await env.DB.prepare(`SELECT c.start_state,c.outcome,c.created_at,
    c.instance_id,c.capacity_weight,p.outcome AS parent_outcome
    FROM runs c JOIN runs p ON p.id=c.parent_run_id
    WHERE c.id=? AND c.parent_run_id=? AND c.parent_step_id=?`)
    .bind(childRunId,parentRunId,parentStepId)
    .first<{start_state:string;outcome:string;created_at:number;instance_id:string;
      capacity_weight:number;parent_outcome:string}>();
  if(row?.outcome==='cancelled'&&row.start_state==='cancelled_before_start')
    return {childRunId,start_state:'cancelled_before_start'};
  // A child may finish or be cancelled while the parent is durably asleep.
  // Never recreate a terminal child; let the parent inspect its D1 result.
  if(row&&['succeeded','failed','cancelled','indeterminate'].includes(row.outcome))
    return {childRunId,start_state:'started'};
  if(!row||row.parent_outcome!=='running'||row.capacity_weight!==1||
     row.instance_id!==childRunId||
     !['reserved','creating','dispatching','start_unknown','started'].includes(row.start_state)||
     !['queued','running'].includes(row.outcome))
    throw Error('child_start_not_authorized');
  const reconcileCancellation=async()=>{
    const pending=await env.DB.prepare(`SELECT child_run_id FROM child_cancellations
      WHERE child_run_id=?`).bind(childRunId).first<{child_run_id:string}>();
    if(pending){
      try{await cancelAwaitedChild(env,parentRunId,parentStepId);}catch{
        // Preserve the durable intent for later observation, not a new POST.
      }
    }
  };
  const markStarted=async()=>{
    await env.DB.prepare(`UPDATE runs SET start_state='started',updated_at=?
      WHERE id=? AND parent_run_id=? AND parent_step_id=?
      AND start_state IN ('creating','dispatching','start_unknown') AND outcome IN ('queued','running')`)
      .bind(timestamp,childRunId,parentRunId,parentStepId).run();
    await reconcileCancellation();
    return {childRunId,start_state:'started' as const};
  };
  if(row.start_state==='started'){
    await reconcileCancellation();
    return {childRunId,start_state:'started'};
  }
  if(row.start_state==='reserved'){
    // Only the successful D1 CAS owns permission to create. Cancellation
    // before this claim changes outcome to cancelled and makes CAS fail.
    const claim=await env.DB.prepare(`UPDATE runs SET start_state='creating',updated_at=?
      WHERE id=? AND parent_run_id=? AND parent_step_id=? AND start_state='reserved'
      AND outcome='queued' AND EXISTS(
        SELECT 1 FROM runs p WHERE p.id=? AND p.outcome='running')`)
      .bind(timestamp,childRunId,parentRunId,parentStepId,parentRunId).run();
    if(claim.meta.changes!==1){
      const stopped=await env.DB.prepare('SELECT outcome FROM runs WHERE id=?')
        .bind(childRunId).first<{outcome:string}>();
      if(stopped?.outcome==='cancelled')return {childRunId,start_state:'cancelled_before_start'};
      return {childRunId,start_state:'start_unknown'};
    }
    row={...row,start_state:'creating'};
  }else{
    // "creating" may have crashed after its claim or after a lost native ACK.
    // Observe first; never blind-create from that ambiguous state.
    const observed=await observeInstance(env.WORKFLOW,childRunId);
    if(observed.kind==='found')return markStarted();
    if(observed.kind==='unavailable')return {childRunId,start_state:'start_unknown'};
    if(row.start_state==='creating'||row.start_state==='dispatching'){
      // A lost worker between the D1 claim and Cloudflare create() must not
      // consume one reservation indefinitely. Only a positive native
      // not-found and the same ten-minute cutoff permit terminal uncertainty.
      if(timestamp-row.created_at>=10*60_000){
        await env.DB.prepare(`UPDATE runs SET outcome='indeterminate',
          error_code='start_unconfirmed',updated_at=?
          WHERE id=? AND start_state IN ('creating','dispatching') AND outcome='queued'`)
          .bind(timestamp,childRunId).run();
        return {childRunId,start_state:'indeterminate'};
      }
      return {childRunId,start_state:'start_unknown'};
    }
    // "start_unknown" is entered only after a native create attempt. Retry
    // the SAME ID on a proven native not-found, but never after cancellation.
    if(timestamp-row.created_at>=10*60_000){
      await env.DB.prepare(`UPDATE runs
        SET outcome='indeterminate',error_code='start_unconfirmed',updated_at=?
        WHERE id=? AND start_state='start_unknown' AND outcome='queued'`)
        .bind(timestamp,childRunId).run();
      return {childRunId,start_state:'indeterminate'};
    }
  }
  // Linearization point for dispatch: a cancellation before this atomic
  // claim wins and prevents all future native creation. A cancellation after
  // this point is a durable intent to terminate a possibly dispatched child.
  // The old separate SELECT-cancellation / create() gap is not a safe fence.
  const dispatch=await env.DB.prepare(`UPDATE runs
    SET start_state='dispatching',updated_at=?
    WHERE id=? AND parent_run_id=? AND parent_step_id=?
      AND start_state IN ('creating','start_unknown') AND outcome='queued'
      AND NOT EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=?)
      AND EXISTS(SELECT 1 FROM runs p WHERE p.id=? AND p.outcome='running')`)
    .bind(timestamp,childRunId,parentRunId,parentStepId,childRunId,parentRunId).run();
  if(dispatch.meta.changes!==1){
    const stopped=await env.DB.prepare('SELECT outcome,start_state FROM runs WHERE id=?')
      .bind(childRunId).first<{outcome:string;start_state:string}>();
    if(stopped?.outcome==='cancelled'&&stopped.start_state==='cancelled_before_start')
      return {childRunId,start_state:'cancelled_before_start'};
    // If cancellation intent won in 'creating', convert it into a local
    // terminal state without issuing a native create.
    if(stopped?.start_state==='creating'){
      const abandoned=await env.DB.prepare(`UPDATE runs SET outcome='cancelled',
        start_state='cancelled_before_start',error_code='cancelled_before_start',updated_at=?
        WHERE id=? AND start_state='creating' AND outcome='queued'
          AND EXISTS(SELECT 1 FROM child_cancellations WHERE child_run_id=?)`)
        .bind(timestamp,childRunId,childRunId).run();
      if(abandoned.meta.changes===1)
        return {childRunId,start_state:'cancelled_before_start'};
    }
    return {childRunId,start_state:'start_unknown'};
  }
  try{
    await env.WORKFLOW.create({id:childRunId,params:{run_id:childRunId}});
    return markStarted();
  }catch{
    await env.DB.prepare(`UPDATE runs SET start_state='start_unknown',updated_at=?
      WHERE id=? AND start_state='dispatching' AND outcome IN ('queued','running')`)
      .bind(timestamp,childRunId).run();
    const observed=await observeInstance(env.WORKFLOW,childRunId);
    return observed.kind==='found'?markStarted():
      {childRunId,start_state:'start_unknown'};
  }
}
