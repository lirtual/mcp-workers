import type { WorkflowStep } from 'cloudflare:workers';
import type { Env } from './store.ts';
import { grantRevoked } from './protected-effect.ts';
import { CancelObserved } from './run-cancel.ts';

/** Twenty 30-second wakes. The deadline is fixed when the gate opens. */
export const APPROVAL_WAKE_TIMEOUT = '30 seconds';
export const APPROVAL_WAKE_LIMIT = 20;
export const APPROVAL_WAKE_MS = 30_000;
export const APPROVAL_WAIT_MS = APPROVAL_WAKE_LIMIT * APPROVAL_WAKE_MS;
export const APPROVAL_GATE_WHEN = 'before_dispatch' as const;
export const APPROVAL_GATE_BINDING = ['run_id', 'step_id', 'published_version_id'] as const;

type DecisionRow = {decision: string; created_at: number; consumed_at: number | null};
type GateRow = {version_id: string; deadline_at: number};
export type RuntimeApprovalResult = {ok: true} | {ok: false; error_code: string};

const now = () => Date.now();
const inTime = (row: DecisionRow | null, deadline: number) =>
  !!row && (row.decision === 'approved' || row.decision === 'denied') && row.created_at < deadline;

export async function readRuntimeApproval(
  db: Env['DB'], runId: string, stepId: string, versionId: string,
): Promise<DecisionRow | null> {
  const row = await db.prepare(
    'SELECT decision, created_at, consumed_at FROM runtime_approvals WHERE run_id=? AND step_id=? AND version_id=?',
  ).bind(runId, stepId, versionId).first<DecisionRow>();
  if (!row || (row.decision !== 'approved' && row.decision !== 'denied')) return null;
  return row;
}

/** Insert once. A different decision does not replace the stored row. */
export async function recordRuntimeApproval(
  db: Env['DB'], runId: string, stepId: string, versionId: string,
  decision: 'approved' | 'denied', at: number,
): Promise<{decision: 'approved' | 'denied'; consumed: boolean; conflict: boolean}> {
  await db.prepare(
    `INSERT INTO runtime_approvals(run_id,step_id,version_id,decision,created_at)
     VALUES(?,?,?,?,?) ON CONFLICT(run_id,step_id,version_id) DO NOTHING`,
  ).bind(runId, stepId, versionId, decision, at).run();
  const row = await readRuntimeApproval(db, runId, stepId, versionId);
  if (!row || (row.decision !== 'approved' && row.decision !== 'denied')) throw Error('approval_binding_mismatch');
  return {decision: row.decision, consumed: row.consumed_at !== null, conflict: row.decision !== decision};
}

export async function approvalStillWaiting(db: Env['DB'], runId: string, at: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS open FROM runtime_approval_gates g
     WHERE g.run_id=? AND g.deadline_at>?
       AND NOT EXISTS (
         SELECT 1 FROM runtime_approvals a
         WHERE a.run_id=g.run_id AND a.step_id=g.step_id AND a.version_id=g.version_id
       )`,
  ).bind(runId, at).first<{open: number}>();
  return row != null;
}

async function openGate(db: Env['DB'], runId: string, stepId: string, versionId: string, at: number): Promise<number> {
  const deadline = at + APPROVAL_WAIT_MS;
  await db.prepare(
    'INSERT INTO runtime_approval_gates(run_id,step_id,version_id,deadline_at) VALUES(?,?,?,?) ON CONFLICT(run_id,step_id) DO NOTHING',
  ).bind(runId, stepId, versionId, deadline).run();
  const row = await db.prepare(
    'SELECT version_id, deadline_at FROM runtime_approval_gates WHERE run_id=? AND step_id=?',
  ).bind(runId, stepId).first<GateRow>();
  if (!row || row.version_id !== versionId) throw Error('approval_binding_mismatch');
  return row.deadline_at;
}

/**
 * Wait outside step.do. The wake payload is not a decision; D1 is.
 * A grant check here does not consume the approval, so revocation stays independent.
 */
export async function waitForRuntimeApproval(
  db: Env['DB'], workflowStep: WorkflowStep, runId: string, stepId: string, versionId: string,
  grantKey: string | null, cancelled: () => Promise<boolean>,
): Promise<RuntimeApprovalResult> {
  const deadline = await workflowStep.do(
    'approval-open-' + stepId,
    {retries: {limit: 0, delay: '1 second'}, timeout: '30 seconds'},
    async () => {
      await db.prepare(
        `INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,?,'waiting_approval',?)
         ON CONFLICT(run_id,step_id) DO UPDATE SET status='waiting_approval', updated_at=excluded.updated_at
         WHERE run_steps.status IN ('waiting','running','waiting_approval')`,
      ).bind(runId, stepId, now()).run();
      return openGate(db, runId, stepId, versionId, now());
    },
  );
  let decision = await readRuntimeApproval(db, runId, stepId, versionId);
  for (let index = 0; index < APPROVAL_WAKE_LIMIT && !inTime(decision, deadline) && now() < deadline; index++) {
    if (await cancelled()) throw new CancelObserved();
    try {
      await workflowStep.waitForEvent<{run_id: string}>(
        'approval-' + stepId + '-' + index,
        {type: 'approval-' + stepId, timeout: APPROVAL_WAKE_TIMEOUT},
      );
    } catch {
      // A lost wake or a 30-second slice is not an approval.
    }
    decision = await readRuntimeApproval(db, runId, stepId, versionId);
  }
  if (await cancelled()) throw new CancelObserved();
  if (decision && inTime(decision, deadline) && decision.decision === 'denied')
    return {ok: false, error_code: 'approval_denied'};
  if (!decision || !inTime(decision, deadline) || decision.decision !== 'approved')
    return {ok: false, error_code: 'approval_timeout'};
  if (decision.consumed_at !== null) return {ok: false, error_code: 'approval_already_used'};
  if (grantKey !== null && await grantRevoked(db, versionId, grantKey))
    return {ok: false, error_code: 'grant_revoked'};
  const consumed = await db.prepare(
    `UPDATE runtime_approvals SET consumed_at=?
     WHERE run_id=? AND step_id=? AND version_id=? AND decision='approved' AND consumed_at IS NULL`,
  ).bind(now(), runId, stepId, versionId).run();
  if (consumed.meta.changes < 1) return {ok: false, error_code: 'approval_already_used'};
  return {ok: true};
}
