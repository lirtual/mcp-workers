import type { jwtVerify } from 'jose';
import {
  verifyGithubClaimedOwner,type AttemptDatabase,type ExecutorIdentity,
} from './s3-github-claim.ts';

/**
 * S3 receipt-first callback protocol for the registered HTTP ingress and
 * durable Workflow runner. The business operation must be executed only
 * after the separately confirmed OIDC Claim has succeeded.
 */
export type GitHubCallback={
  attemptId:string;
  callbackId:string;
  outcome:'succeeded'|'failed';
  result:unknown;
};
type KeyResolver=Parameters<typeof jwtVerify>[1];
type ReceiptRow={
  callback_id:string;
  attempt_id:string;
  outcome:string;
  result_json:string;
  notification_delivered:number;
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Verify an actual signed GitHub OIDC credential, then durably store an
 * immutable terminal fact for the existing claimed Attempt.
 * Identical callback replay is acknowledged; conflicting callbacks fail.
 */
export async function recordGithubCallback(
  db:AttemptDatabase,callback:GitHubCallback,
  oidcJwt:string,pinned:ExecutorIdentity,keyResolver?:KeyResolver,
):Promise<boolean>{
  if(!UUID.test(callback.attemptId)||!UUID.test(callback.callbackId)||
     !['succeeded','failed'].includes(callback.outcome))return false;
  const serialized=JSON.stringify(callback.result);
  if(!serialized||new TextEncoder().encode(serialized).byteLength>4096)
    return false;
  const identityOk=keyResolver
    ? await verifyGithubClaimedOwner(db,callback.attemptId,oidcJwt,pinned,keyResolver)
    : await verifyGithubClaimedOwner(db,callback.attemptId,oidcJwt,pinned);
  if(!identityOk)return false;
  // One statement both gates on the still-claimed owner and inserts the
  // receipt. GitHub must not insert results for an unrelated signed Run.
  await db.prepare(`INSERT OR IGNORE INTO callback_receipts
    (callback_id,attempt_id,outcome,result_json,created_at)
    SELECT ?,?,?,?,? FROM step_attempts
    WHERE attempt_id=? AND state='claimed'
      AND owner_run_id=candidate_run_id
      AND owner_run_attempt=candidate_run_attempt
      AND EXISTS(SELECT 1 FROM runs
        WHERE runs.id=step_attempts.run_id
        AND runs.outcome IN ('queued','running'))`).bind(
    callback.callbackId,callback.attemptId,callback.outcome,
    serialized,Date.now(),callback.attemptId,
  ).run();
  const persisted=await db.prepare(`SELECT callback_id,attempt_id,outcome,
    result_json,notification_delivered FROM callback_receipts
    WHERE attempt_id=?`).bind(callback.attemptId).first<ReceiptRow>();
  return persisted?.callback_id===callback.callbackId &&
    persisted.outcome===callback.outcome &&
    persisted.result_json===serialized;
}

/**
 * Notify Cloudflare only after reading a durable callback receipt.
 * Failure leaves notification_delivered=0 for a bounded reconciliation
 * process to retry. Duplicate wake-ups are possible and must be idempotent;
 * neither the event nor this flag by itself establishes Run success.
 */
export async function notifyStoredGithubReceipt(
  db:AttemptDatabase,attemptId:string,
  wake:(event:{attemptId:string;callbackId:string})=>Promise<void>,
):Promise<boolean>{
  if(!UUID.test(attemptId))return false;
  const persisted=await db.prepare(`SELECT callback_id,attempt_id,outcome,
    result_json,notification_delivered FROM callback_receipts
    WHERE attempt_id=?`).bind(attemptId).first<ReceiptRow>();
  if(!persisted)return false;
  if(persisted.notification_delivered===1)return true;
  await wake({attemptId:persisted.attempt_id,callbackId:persisted.callback_id});
  const updated=await db.prepare(`UPDATE callback_receipts
    SET notification_delivered=1,delivered_at=?
    WHERE attempt_id=? AND callback_id=? AND notification_delivered=0`).bind(
    Date.now(),persisted.attempt_id,persisted.callback_id,
  ).run();
  return updated.meta.changes===1;
}
