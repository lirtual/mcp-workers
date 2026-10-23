import type { Env } from './store.ts';

type EffectRow = {state: string; result: string | null; error_code: string | null};

export async function readProtectedEffect(db: Env['DB'], runId: string, stepId: string): Promise<EffectRow | null> {
  return db.prepare('SELECT state, result, error_code FROM protected_effects WHERE run_id=? AND step_id=?')
    .bind(runId, stepId).first<EffectRow>();
}

export async function grantRevoked(db: Env['DB'], versionId: string, grantKey: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS revoked FROM grant_revocations WHERE version_id=? AND grant_key=?')
    .bind(versionId, grantKey).first<{revoked: number}>();
  return row !== null && row !== undefined;
}

/** Mark dispatch only after local authorization. A lost race replays the stored row. */
export async function beginProtectedDispatch(db: Env['DB'], runId: string, stepId: string, grantKey: string, at: number): Promise<boolean> {
  const inserted = await db.prepare(
    "INSERT INTO protected_effects(run_id,step_id,grant_key,state,result,error_code,created_at,updated_at) VALUES(?,?,?,'dispatching',NULL,NULL,?,?)",
  ).bind(runId, stepId, grantKey, at, at).run();
  return inserted.meta.changes > 0;
}

export async function finishProtectedDispatch(
  db: Env['DB'], runId: string, stepId: string, state: 'succeeded' | 'indeterminate',
  result: string | null, errorCode: string | null, at: number,
): Promise<void> {
  await db.prepare(
    "UPDATE protected_effects SET state=?, result=?, error_code=?, updated_at=? WHERE run_id=? AND step_id=? AND state='dispatching'",
  ).bind(state, result, errorCode, at, runId, stepId).run();
}
