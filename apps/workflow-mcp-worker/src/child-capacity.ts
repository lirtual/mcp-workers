/**
 * One-Cloudflare-Workflow awaited-child capacity primitive.
 *
 * Deliberately not wired to workflow_run/runner yet: flow.child remains
 * unsupported until target-pinned admission, native start reconciliation,
 * cancellation and real Cloudflare E2E are verified together.
 */
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
